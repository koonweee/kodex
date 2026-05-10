use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    net::{IpAddr, SocketAddr},
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
};

use serde::{Deserialize, Serialize};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    process::{Child, Command},
    sync::Mutex,
    time::{timeout, Duration},
};
use utoipa::ToSchema;

use crate::{
    config::Config,
    error::{ApiError, ApiResult},
    store::{ProjectPreview, ProjectPreviewRoute, ProjectPreviewService, Store},
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum PreviewSubsystemState {
    Available,
    Degraded,
    Disabled,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum PreviewServiceReachability {
    Reachable,
    Unreachable,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum PreviewRuntimeStateKind {
    Active,
    Disabled,
    Degraded,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PreviewSubsystemStatus {
    pub state: PreviewSubsystemState,
    pub caddy_found: bool,
    pub caddy_running: bool,
    pub admin_reachable: bool,
    pub bind_address: Option<String>,
    pub admin_address: String,
    pub last_reload_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PreviewServiceStatus {
    pub reachability: PreviewServiceReachability,
    pub health_url: String,
    pub last_checked_at: Option<chrono::DateTime<chrono::Utc>>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PreviewRuntimeStatus {
    pub state: PreviewRuntimeStateKind,
    pub url: Option<String>,
    pub public_port: i64,
    pub last_reload_error: Option<String>,
    pub route_errors: Vec<String>,
}

#[derive(Clone)]
pub struct PreviewManager {
    inner: Arc<PreviewManagerInner>,
}

struct PreviewManagerInner {
    config: Arc<Config>,
    child: Mutex<Option<Child>>,
    status: Mutex<PreviewStatusState>,
}

#[derive(Debug, Clone)]
struct PreviewStatusState {
    caddy_found: bool,
    caddy_running: bool,
    admin_reachable: bool,
    last_reload_error: Option<String>,
}

impl Default for PreviewStatusState {
    fn default() -> Self {
        Self {
            caddy_found: false,
            caddy_running: false,
            admin_reachable: false,
            last_reload_error: None,
        }
    }
}

impl PreviewManager {
    pub fn new(config: Arc<Config>) -> Self {
        Self {
            inner: Arc::new(PreviewManagerInner {
                config,
                child: Mutex::new(None),
                status: Mutex::new(PreviewStatusState::default()),
            }),
        }
    }

    pub async fn start(&self, store: &Store) -> ApiResult<()> {
        self.apply(store).await
    }

    pub async fn apply(&self, store: &Store) -> ApiResult<()> {
        if let Err(error) = self.apply_inner(store).await {
            self.record_degraded(error.to_string()).await;
        }
        Ok(())
    }

    pub async fn shutdown(&self) -> ApiResult<()> {
        self.stop_child().await
    }

    pub async fn subsystem_status(&self) -> PreviewSubsystemStatus {
        let status = self.inner.status.lock().await.clone();
        let bind_address = self
            .inner
            .config
            .preview_bind_address()
            .ok()
            .map(|address| address.to_string());
        let state = if !status.caddy_found {
            PreviewSubsystemState::Disabled
        } else if status.last_reload_error.is_some() {
            PreviewSubsystemState::Degraded
        } else {
            PreviewSubsystemState::Available
        };
        PreviewSubsystemStatus {
            state,
            caddy_found: status.caddy_found,
            caddy_running: status.caddy_running,
            admin_reachable: status.admin_reachable,
            bind_address,
            admin_address: self.inner.config.previews.caddy_admin_bind.to_string(),
            last_reload_error: status.last_reload_error,
        }
    }

    pub async fn service_status(&self, service: &ProjectPreviewService) -> PreviewServiceStatus {
        let checked_at = chrono::Utc::now();
        let health_url = service_health_url(service);
        match check_service_health(service).await {
            Ok(()) => PreviewServiceStatus {
                reachability: PreviewServiceReachability::Reachable,
                health_url,
                last_checked_at: Some(checked_at),
                last_error: None,
            },
            Err(error) => PreviewServiceStatus {
                reachability: PreviewServiceReachability::Unreachable,
                health_url,
                last_checked_at: Some(checked_at),
                last_error: Some(error),
            },
        }
    }

    pub async fn preview_status(
        &self,
        preview: &ProjectPreview,
        routes: &[ProjectPreviewRoute],
    ) -> PreviewRuntimeStatus {
        let subsystem = self.subsystem_status().await;
        let mut route_errors = Vec::new();
        for route in routes {
            if !is_valid_route_pattern(&route.path_pattern) {
                route_errors.push(format!("invalid route path {}", route.path_pattern));
            }
        }
        if !preview.enabled {
            return PreviewRuntimeStatus {
                state: PreviewRuntimeStateKind::Disabled,
                url: None,
                public_port: preview.public_port,
                last_reload_error: subsystem.last_reload_error,
                route_errors,
            };
        }
        let url = subsystem
            .bind_address
            .as_ref()
            .map(|bind| format!("http://{bind}:{}", preview.public_port));
        let state =
            if subsystem.state == PreviewSubsystemState::Available && route_errors.is_empty() {
                PreviewRuntimeStateKind::Active
            } else {
                PreviewRuntimeStateKind::Degraded
            };
        PreviewRuntimeStatus {
            state,
            url,
            public_port: preview.public_port,
            last_reload_error: subsystem.last_reload_error,
            route_errors,
        }
    }

    async fn apply_inner(&self, store: &Store) -> ApiResult<()> {
        let bind = self
            .inner
            .config
            .preview_bind_address()
            .map_err(|error| ApiError::BadRequest(error.to_string()))?;
        let Some(binary) = resolve_caddy_binary(&self.inner.config.previews.caddy_binary) else {
            self.stop_child().await?;
            let mut status = self.inner.status.lock().await;
            *status = PreviewStatusState {
                caddy_found: false,
                caddy_running: false,
                admin_reachable: false,
                last_reload_error: Some("Caddy binary was not found".to_string()),
            };
            return Ok(());
        };

        let snapshot = PreviewConfigSnapshot::load(store).await?;
        let enabled_previews: Vec<_> = snapshot
            .previews
            .iter()
            .filter(|preview| preview.enabled)
            .collect();
        if enabled_previews.is_empty() {
            self.stop_child().await?;
            let mut status = self.inner.status.lock().await;
            *status = PreviewStatusState {
                caddy_found: true,
                caddy_running: false,
                admin_reachable: false,
                last_reload_error: None,
            };
            return Ok(());
        }

        let admin_bind = self.inner.config.previews.caddy_admin_bind;
        if !admin_bind.ip().is_loopback() {
            return Err(ApiError::BadRequest(
                "KODEX_CADDY_ADMIN_BIND must use a loopback address".to_string(),
            ));
        }

        let caddyfile = render_caddyfile(
            bind,
            admin_bind,
            &snapshot.services,
            &snapshot.previews,
            &snapshot.routes,
        )?;
        let caddyfile_path = self.write_caddyfile(&caddyfile).await?;
        self.stop_child().await?;
        ensure_socket_available(admin_bind).await?;
        for preview in &enabled_previews {
            ensure_socket_available(SocketAddr::new(bind, preview.public_port as u16)).await?;
        }
        self.restart_child(binary, caddyfile_path).await?;
        self.wait_for_child_ready(admin_bind).await?;
        let mut status = self.inner.status.lock().await;
        *status = PreviewStatusState {
            caddy_found: true,
            caddy_running: true,
            admin_reachable: true,
            last_reload_error: None,
        };
        Ok(())
    }

    async fn write_caddyfile(&self, caddyfile: &str) -> ApiResult<PathBuf> {
        let root = self.inner.config.previews.data_dir.join("caddy");
        tokio::fs::create_dir_all(root.join("data")).await?;
        tokio::fs::create_dir_all(root.join("config")).await?;
        tokio::fs::create_dir_all(root.join("logs")).await?;
        let caddyfile_path = root.join("Caddyfile");
        tokio::fs::write(&caddyfile_path, caddyfile).await?;
        Ok(caddyfile_path)
    }

    async fn restart_child(&self, binary: PathBuf, caddyfile_path: PathBuf) -> ApiResult<()> {
        let root = self.inner.config.previews.data_dir.join("caddy");
        let child = Command::new(binary)
            .arg("run")
            .arg("--config")
            .arg(caddyfile_path)
            .arg("--adapter")
            .arg("caddyfile")
            .env("XDG_DATA_HOME", root.join("data"))
            .env("XDG_CONFIG_HOME", root.join("config"))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()?;
        *self.inner.child.lock().await = Some(child);
        Ok(())
    }

    async fn wait_for_child_ready(&self, admin_bind: SocketAddr) -> ApiResult<()> {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        loop {
            if !self.child_running().await {
                return Err(ApiError::BadGateway(
                    "Caddy exited before its admin endpoint became reachable".to_string(),
                ));
            }
            match check_tcp_connect(admin_bind).await {
                Ok(()) => return Ok(()),
                Err(error) => {
                    if tokio::time::Instant::now() >= deadline {
                        return Err(ApiError::BadGateway(format!(
                            "Caddy admin endpoint {admin_bind} did not become reachable: {error}"
                        )));
                    }
                }
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    async fn stop_child(&self) -> ApiResult<()> {
        let child = self.inner.child.lock().await.take();
        if let Some(mut child) = child {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
        Ok(())
    }

    async fn child_running(&self) -> bool {
        let mut child_guard = self.inner.child.lock().await;
        let Some(child) = child_guard.as_mut() else {
            return false;
        };
        match child.try_wait() {
            Ok(Some(_)) | Err(_) => {
                *child_guard = None;
                false
            }
            Ok(None) => true,
        }
    }

    async fn record_degraded(&self, error: String) {
        let caddy_found = resolve_caddy_binary(&self.inner.config.previews.caddy_binary).is_some();
        let child_running = self.child_running().await;
        let mut status = self.inner.status.lock().await;
        *status = PreviewStatusState {
            caddy_found,
            caddy_running: child_running,
            admin_reachable: false,
            last_reload_error: Some(error),
        };
    }
}

struct PreviewConfigSnapshot {
    services: Vec<ProjectPreviewService>,
    previews: Vec<ProjectPreview>,
    routes: Vec<ProjectPreviewRoute>,
}

impl PreviewConfigSnapshot {
    async fn load(store: &Store) -> ApiResult<Self> {
        let previews = store.list_all_project_previews().await?;
        let routes = store.list_all_project_preview_routes().await?;
        let projects = store.list_projects().await?;
        let mut services = Vec::new();
        for project in projects {
            services.extend(store.list_project_preview_services(&project.id).await?);
        }
        Ok(Self {
            services,
            previews,
            routes,
        })
    }
}

pub fn render_caddyfile(
    bind: IpAddr,
    admin_bind: SocketAddr,
    services: &[ProjectPreviewService],
    previews: &[ProjectPreview],
    routes: &[ProjectPreviewRoute],
) -> ApiResult<String> {
    let services_by_id: HashMap<_, _> = services
        .iter()
        .map(|service| (&service.id, service))
        .collect();
    let mut used_listeners = BTreeSet::new();
    let mut routes_by_preview: BTreeMap<&str, Vec<&ProjectPreviewRoute>> = BTreeMap::new();
    for route in routes {
        routes_by_preview
            .entry(route.preview_id.as_str())
            .or_default()
            .push(route);
    }

    let mut output = format!("{{\n  admin {admin_bind}\n  auto_https off\n}}\n\n");
    for preview in previews.iter().filter(|preview| preview.enabled) {
        if !used_listeners.insert(preview.public_port) {
            return Err(ApiError::BadRequest(format!(
                "duplicate preview public port {}",
                preview.public_port
            )));
        }
        let root_service = services_by_id
            .get(&preview.root_service_id)
            .ok_or_else(|| ApiError::BadRequest("preview root service is missing".to_string()))?;
        output.push_str(&format!("http://{bind}:{} {{\n", preview.public_port));
        if let Some(preview_routes) = routes_by_preview.get(preview.id.as_str()) {
            let mut sorted_routes = preview_routes.clone();
            sorted_routes
                .sort_by_key(|route| (route.sort_order, route.created_at, route.id.clone()));
            for route in sorted_routes {
                if !is_valid_route_pattern(&route.path_pattern) || route.path_pattern == "/" {
                    return Err(ApiError::BadRequest(format!(
                        "invalid preview route path {}",
                        route.path_pattern
                    )));
                }
                let service = services_by_id.get(&route.service_id).ok_or_else(|| {
                    ApiError::BadRequest("preview route service is missing".to_string())
                })?;
                let directive = if route.strip_prefix {
                    "handle_path"
                } else {
                    "handle"
                };
                output.push_str(&format!(
                    "  {directive} {} {{\n    reverse_proxy 127.0.0.1:{}\n  }}\n\n",
                    route.path_pattern, service.local_port
                ));
            }
        }
        output.push_str(&format!(
            "  handle {{\n    reverse_proxy 127.0.0.1:{}\n  }}\n}}\n\n",
            root_service.local_port
        ));
    }
    Ok(output)
}

pub fn is_valid_route_pattern(path: &str) -> bool {
    if path == "/" {
        return true;
    }
    if !path.starts_with('/') || !path.ends_with("/*") || path.len() <= 3 {
        return false;
    }
    let prefix = &path[..path.len() - 2];
    if prefix == "/" || prefix.ends_with('/') {
        return false;
    }
    prefix.bytes().all(|byte| {
        byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'-' | b'_' | b'.' | b'~')
    })
}

fn service_health_url(service: &ProjectPreviewService) -> String {
    format!(
        "{}://127.0.0.1:{}{}",
        service.protocol, service.local_port, service.health_path
    )
}

async fn check_service_health(service: &ProjectPreviewService) -> Result<(), String> {
    if service.protocol != "http" {
        return Err("only http health checks are supported".to_string());
    }
    let addr = format!("127.0.0.1:{}", service.local_port);
    let mut stream = timeout(Duration::from_millis(500), TcpStream::connect(&addr))
        .await
        .map_err(|_| format!("timed out connecting to {addr}"))?
        .map_err(|error| format!("could not connect to {addr}: {error}"))?;
    let request = format!(
        "GET {} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
        service.health_path
    );
    timeout(
        Duration::from_millis(500),
        stream.write_all(request.as_bytes()),
    )
    .await
    .map_err(|_| "timed out writing health request".to_string())?
    .map_err(|error| format!("could not write health request: {error}"))?;
    let mut response = [0u8; 64];
    let count = timeout(Duration::from_millis(500), stream.read(&mut response))
        .await
        .map_err(|_| "timed out reading health response".to_string())?
        .map_err(|error| format!("could not read health response: {error}"))?;
    let status = std::str::from_utf8(&response[..count]).unwrap_or("");
    if status.starts_with("HTTP/1.1 2") || status.starts_with("HTTP/1.1 3") {
        Ok(())
    } else {
        Err("health check did not return a successful HTTP status".to_string())
    }
}

async fn ensure_socket_available(addr: SocketAddr) -> ApiResult<()> {
    match TcpListener::bind(addr).await {
        Ok(listener) => {
            drop(listener);
            Ok(())
        }
        Err(error) => Err(ApiError::BadRequest(format!(
            "preview address {addr} is unavailable: {error}"
        ))),
    }
}

async fn check_tcp_connect(addr: SocketAddr) -> Result<(), String> {
    timeout(Duration::from_millis(100), TcpStream::connect(addr))
        .await
        .map_err(|_| format!("timed out connecting to {addr}"))?
        .map(|_| ())
        .map_err(|error| format!("could not connect to {addr}: {error}"))
}

fn resolve_caddy_binary(binary: &str) -> Option<PathBuf> {
    let path = Path::new(binary);
    if path.components().count() > 1 {
        return path.exists().then(|| path.to_path_buf());
    }
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        let candidate = dir.join(binary);
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use std::io::Write;

    use crate::store::Store;

    #[test]
    fn renders_path_stripping_and_preserving_routes() {
        let now = Utc::now();
        let frontend = ProjectPreviewService {
            id: "frontend".to_string(),
            project_id: "project-1".to_string(),
            name: "Frontend".to_string(),
            protocol: "http".to_string(),
            local_port: 3000,
            health_path: "/".to_string(),
            created_at: now,
            updated_at: now,
        };
        let backend = ProjectPreviewService {
            id: "backend".to_string(),
            project_id: "project-1".to_string(),
            name: "Backend".to_string(),
            protocol: "http".to_string(),
            local_port: 4000,
            health_path: "/health".to_string(),
            created_at: now,
            updated_at: now,
        };
        let preview = ProjectPreview {
            id: "preview".to_string(),
            project_id: "project-1".to_string(),
            name: "App".to_string(),
            public_port: 13000,
            root_service_id: "frontend".to_string(),
            enabled: true,
            created_at: now,
            updated_at: now,
        };
        let routes = vec![
            ProjectPreviewRoute {
                id: "api".to_string(),
                preview_id: "preview".to_string(),
                path_pattern: "/api/*".to_string(),
                service_id: "backend".to_string(),
                strip_prefix: true,
                sort_order: 0,
                created_at: now,
                updated_at: now,
            },
            ProjectPreviewRoute {
                id: "raw".to_string(),
                preview_id: "preview".to_string(),
                path_pattern: "/raw/*".to_string(),
                service_id: "backend".to_string(),
                strip_prefix: false,
                sort_order: 1,
                created_at: now,
                updated_at: now,
            },
        ];
        let caddyfile = render_caddyfile(
            "100.64.0.1".parse().unwrap(),
            "127.0.0.1:20191".parse().unwrap(),
            &[frontend, backend],
            &[preview],
            &routes,
        )
        .unwrap();
        assert!(caddyfile.contains("http://100.64.0.1:13000"));
        assert!(caddyfile.contains("handle_path /api/*"));
        assert!(caddyfile.contains("handle /raw/*"));
        assert!(caddyfile.contains("reverse_proxy 127.0.0.1:3000"));
        assert!(caddyfile.contains("reverse_proxy 127.0.0.1:4000"));
    }

    #[test]
    fn route_patterns_reject_caddyfile_injection_and_root_wildcard() {
        assert!(is_valid_route_pattern("/api/*"));
        assert!(is_valid_route_pattern("/api/v1/*"));
        assert!(!is_valid_route_pattern("/*"));
        assert!(!is_valid_route_pattern("/api/"));
        assert!(!is_valid_route_pattern("/api/*\nhandle {"));
        assert!(!is_valid_route_pattern("/api users/*"));
        assert!(!is_valid_route_pattern("/api{host}/*"));
    }

    #[tokio::test]
    async fn caddy_child_must_stay_running_until_admin_is_reachable() {
        let temp_dir = tempfile::tempdir().unwrap();
        let fake_caddy_path = temp_dir.path().join("fake-caddy");
        let mut fake_caddy = std::fs::File::create(&fake_caddy_path).unwrap();
        writeln!(fake_caddy, "#!/bin/sh").unwrap();
        writeln!(fake_caddy, "exit 2").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = fake_caddy.metadata().unwrap().permissions();
            permissions.set_mode(0o755);
            std::fs::set_permissions(&fake_caddy_path, permissions).unwrap();
        }
        drop(fake_caddy);

        let mut config = Config::default();
        config.previews.caddy_binary = fake_caddy_path.to_string_lossy().to_string();
        config.previews.data_dir = temp_dir.path().join("data");
        let manager = PreviewManager::new(Arc::new(config));
        let caddyfile_path = temp_dir.path().join("Caddyfile");
        std::fs::write(&caddyfile_path, "{\n  auto_https off\n}\n").unwrap();

        manager
            .restart_child(fake_caddy_path, caddyfile_path)
            .await
            .unwrap();
        let error = manager
            .wait_for_child_ready("127.0.0.1:1".parse().unwrap())
            .await
            .unwrap_err();
        assert!(error
            .to_string()
            .contains("Caddy exited before its admin endpoint became reachable"));
    }

    #[tokio::test]
    async fn manager_reports_missing_caddy_without_failing_gateway() {
        let store = Store::in_memory().await.unwrap();
        let mut config = Config::default();
        config.previews.caddy_binary = "__missing_kodex_test_caddy__".to_string();
        let manager = PreviewManager::new(Arc::new(config));

        manager.start(&store).await.unwrap();
        let status = manager.subsystem_status().await;
        assert_eq!(status.state, PreviewSubsystemState::Disabled);
        assert!(!status.caddy_found);
        assert!(status.last_reload_error.unwrap().contains("not found"));
    }
}
