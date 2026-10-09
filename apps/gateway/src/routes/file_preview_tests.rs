use crate::{
    api::{build_router, AppState},
    app_server::tests::RecordingAppServer,
    config::Config,
    store::Store,
};
use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
    Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde_json::json;
use std::{
    path::Path,
    sync::{atomic::Ordering, Arc},
};
use tower::ServiceExt;

async fn fixture() -> (Router, Arc<RecordingAppServer>, tempfile::TempDir) {
    let native = Arc::new(RecordingAppServer::default());
    native.ready.store(true, Ordering::SeqCst);
    let state = AppState::new(
        Config::default(),
        Store::in_memory().await.unwrap(),
        native.clone(),
    );
    (build_router(state), native, tempfile::tempdir().unwrap())
}

async fn request(
    app: &Router,
    native: &RecordingAppServer,
    cwd: &Path,
    request: Request<Body>,
) -> axum::response::Response {
    native
        .queued_responses
        .lock()
        .unwrap()
        .push(json!({"thread":{
            "id":"thread-1", "cwd":cwd.display().to_string(), "createdAt":1, "updatedAt":1,
            "status":{"type":"idle","activeFlags":[]}, "turns":[]
        }}));
    app.clone().oneshot(request).await.unwrap()
}

fn get(url: &str) -> Request<Body> {
    Request::get(url)
        .header("Host", "localhost")
        .body(Body::empty())
        .unwrap()
}

fn content_prefix(root: &Path) -> String {
    format!(
        "/v1/threads/thread-1/files/content/{}",
        URL_SAFE_NO_PAD.encode(root.canonicalize().unwrap().to_str().unwrap())
    )
}

#[tokio::test]
async fn file_preview_existing_html_links_redirect_to_relative_asset_context() {
    let (app, native, dir) = fixture().await;
    let gallery = dir.path().join("gallery");
    std::fs::create_dir(&gallery).unwrap();
    std::fs::write(
        gallery.join("index.html"),
        "<!doctype html><video src=\"clip.webm\"></video>",
    )
    .unwrap();
    let response = request(
        &app,
        &native,
        dir.path(),
        get("/v1/threads/thread-1/files/preview?path=gallery%2Findex.html"),
    )
    .await;
    assert_eq!(response.status(), StatusCode::TEMPORARY_REDIRECT);
    assert_eq!(
        response.headers()["location"],
        format!("{}/index.html", content_prefix(&gallery))
    );
    let target = response.headers()["location"].to_str().unwrap();
    let document = request(&app, &native, dir.path(), get(target)).await;
    assert_eq!(document.status(), StatusCode::OK);
    assert_eq!(
        document.headers()["content-type"],
        "text/html; charset=utf-8"
    );
    assert!(!document.headers().contains_key("content-disposition"));
    let policy = document.headers()["content-security-policy"]
        .to_str()
        .unwrap();
    assert!(policy.contains("sandbox allow-scripts"));
    assert!(!policy.contains("allow-same-origin"));
    assert!(policy.contains("connect-src 'none'"));
    assert!(policy.contains("form-action 'none'"));
    assert_eq!(document.headers()["x-content-type-options"], "nosniff");
    assert!(String::from_utf8(
        to_bytes(document.into_body(), usize::MAX)
            .await
            .unwrap()
            .to_vec()
    )
    .unwrap()
    .contains("clip.webm"));
}

#[tokio::test]
async fn file_preview_content_serves_assets_and_bounds_resolution_to_the_directory() {
    let (app, native, dir) = fixture().await;
    let gallery = dir.path().join("gallery");
    std::fs::create_dir(&gallery).unwrap();
    std::fs::write(gallery.join("theme.css"), "video { width: 100% }").unwrap();
    std::fs::write(gallery.join("controls.js"), "window.controlsLoaded = true;").unwrap();
    std::fs::write(
        gallery.join("space #?%.htm"),
        "<!doctype html><h1>Encoded</h1>",
    )
    .unwrap();
    std::fs::write(dir.path().join("outside.css"), "secret").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(dir.path().join("outside.css"), gallery.join("escape.css")).unwrap();
    for (file, mime) in [
        ("theme.css", "text/css; charset=utf-8"),
        ("controls.js", "text/javascript; charset=utf-8"),
        ("space%20%23%3F%25.htm", "text/html; charset=utf-8"),
    ] {
        let response = request(
            &app,
            &native,
            dir.path(),
            get(&format!("{}/{file}", content_prefix(&gallery))),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK, "{file}");
        assert_eq!(response.headers()["content-type"], mime);
    }
    for file in ["missing.css", "../outside.css", "escape.css"] {
        let response = request(
            &app,
            &native,
            dir.path(),
            get(&format!("{}/{file}", content_prefix(&gallery))),
        )
        .await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "{file}");
    }
    assert_eq!(
        request(
            &app,
            &native,
            dir.path(),
            get("/v1/threads/thread-1/files/content/not-base64/index.html")
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn file_preview_video_supports_full_head_and_seek_ranges() {
    let (app, native, dir) = fixture().await;
    for (file, bytes, mime) in [
        (
            "clip.webm",
            b"\x1a\x45\xdf\xa3webm-test-video".as_slice(),
            "video/webm",
        ),
        (
            "clip.mp4",
            b"\x00\x00\x00\x18ftypisommp4-test-video".as_slice(),
            "video/mp4",
        ),
    ] {
        std::fs::write(dir.path().join(file), bytes).unwrap();
        for url in [
            format!("/v1/threads/thread-1/files/preview?path={file}"),
            format!("{}/{file}", content_prefix(dir.path())),
        ] {
            let response = request(&app, &native, dir.path(), get(&url)).await;
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(response.headers()["content-type"], mime);
            assert!(!response.headers().contains_key("content-disposition"));
            assert_eq!(response.headers()["accept-ranges"], "bytes");
            assert_eq!(
                &to_bytes(response.into_body(), usize::MAX).await.unwrap()[..],
                bytes
            );
            let partial = request(
                &app,
                &native,
                dir.path(),
                Request::get(&url)
                    .header("Range", "bytes=4-7")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await;
            assert_eq!(partial.status(), StatusCode::PARTIAL_CONTENT);
            assert_eq!(
                partial.headers()["content-range"],
                format!("bytes 4-7/{}", bytes.len())
            );
            assert_eq!(
                &to_bytes(partial.into_body(), usize::MAX).await.unwrap()[..],
                &bytes[4..8]
            );
            let head = request(
                &app,
                &native,
                dir.path(),
                Request::head(&url).body(Body::empty()).unwrap(),
            )
            .await;
            assert_eq!(head.status(), StatusCode::OK);
            assert_eq!(head.headers()["content-length"], bytes.len().to_string());
            assert!(to_bytes(head.into_body(), usize::MAX)
                .await
                .unwrap()
                .is_empty());
            let invalid = request(
                &app,
                &native,
                dir.path(),
                Request::get(&url)
                    .header("Range", "bytes=9999-")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await;
            assert_eq!(invalid.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        }
    }
}

#[tokio::test]
async fn file_preview_html_and_media_keep_size_and_thread_checks() {
    let (app, native, dir) = fixture().await;
    let oversized = std::fs::File::create(dir.path().join("large.html")).unwrap();
    oversized.set_len(2 * 1024 * 1024 + 1).unwrap();
    assert_eq!(
        request(
            &app,
            &native,
            dir.path(),
            get("/v1/threads/thread-1/files/preview?path=large.html")
        )
        .await
        .status(),
        StatusCode::UNSUPPORTED_MEDIA_TYPE
    );
    let oversized = std::fs::File::create(dir.path().join("large.webm")).unwrap();
    oversized.set_len(100 * 1024 * 1024 + 1).unwrap();
    assert_eq!(
        request(
            &app,
            &native,
            dir.path(),
            get(&format!("{}/large.webm", content_prefix(dir.path())))
        )
        .await
        .status(),
        StatusCode::UNSUPPORTED_MEDIA_TYPE
    );
    native.queued_responses.lock().unwrap().push(json!({"thread":{"id":"another-thread","cwd":dir.path().display().to_string(),"createdAt":1,"updatedAt":1,"status":{"type":"idle","activeFlags":[]},"turns":[]}}));
    assert_eq!(
        app.oneshot(get(&format!("{}/index.html", content_prefix(dir.path()))))
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn file_preview_html_policy_uses_proxy_host_or_http2_authority() {
    let (app, native, dir) = fixture().await;
    std::fs::write(
        dir.path().join("index.html"),
        "<!doctype html><h1>Report</h1>",
    )
    .unwrap();
    let target = format!("{}/index.html", content_prefix(dir.path()));
    let source = format!(
        "https://jtkwmini.tail445f8.ts.net{}/",
        content_prefix(dir.path())
    );
    for request_builder in [
        Request::get(&target).header("Host", "jtkwmini.tail445f8.ts.net"),
        Request::get(format!("http://jtkwmini.tail445f8.ts.net{target}")),
    ] {
        let response = request(
            &app,
            &native,
            dir.path(),
            request_builder.body(Body::empty()).unwrap(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let policy = response.headers()["content-security-policy"]
            .to_str()
            .unwrap();
        assert!(policy.contains(&source));
        assert!(!policy.contains("'self'"));
    }
    for host in [
        None,
        Some("localhost;connect-src"),
        Some("localhost:invalid"),
    ] {
        let mut builder = Request::get(&target);
        if let Some(host) = host {
            builder = builder.header("Host", host);
        }
        assert_eq!(
            request(
                &app,
                &native,
                dir.path(),
                builder.body(Body::empty()).unwrap()
            )
            .await
            .status(),
            StatusCode::BAD_REQUEST
        );
    }
}

#[tokio::test]
async fn file_preview_browser_enforces_headers_and_plays_relative_video() {
    if std::env::var("KODEX_BROWSER_TESTS").as_deref() != Ok("1") {
        return;
    }
    let (app, _native, dir) = fixture().await;
    let forbidden_requests = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let observed = forbidden_requests.clone();
    let app = app.route(
        "/v1/preview-probe",
        axum::routing::any(move || {
            let observed = observed.clone();
            async move {
                observed.fetch_add(1, Ordering::SeqCst);
                StatusCode::NO_CONTENT
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base_url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let output = tokio::process::Command::new("node")
        .arg("scripts/file-preview-browser.mjs")
        .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join("../web"))
        .env("KODEX_FILE_PREVIEW_TEST_URL", base_url)
        .env("KODEX_FILE_PREVIEW_TEST_ROOT", dir.path())
        .output()
        .await
        .unwrap();
    server.abort();
    assert!(
        output.status.success(),
        "browser proof failed:\n{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    println!("{}", String::from_utf8_lossy(&output.stdout));
    assert_eq!(
        forbidden_requests.load(Ordering::SeqCst),
        0,
        "restricted operations must not reach gateway routes"
    );
}
