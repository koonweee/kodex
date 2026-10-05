//! Browser protocol epoch. Bump on incompatible API changes and regenerate frontend types.
use axum::{
    extract::Request,
    http::{HeaderValue, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

pub const HEADER: &str = "x-kodex-api-version";
#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub enum ApiVersion {
    #[serde(rename = "2")]
    V2,
}

pub async fn enforce(request: Request, next: Next) -> Response {
    let version = serde_json::to_value(ApiVersion::V2).unwrap();
    let version = version.as_str().unwrap();
    // Unversioned CLI/Control callers remain supported. Browser requests carry this header.
    let mismatch = request.headers().get(HEADER).is_some_and(|v| v != version);
    let mut response =
        if request.uri().path().starts_with("/v1/") && mismatch && !request.method().is_safe() {
            (
                StatusCode::CONFLICT,
                Json(crate::error::ApiErrorBody {
                    code: "client_update_required".into(),
                    message: "Update Kodex before making changes.".into(),
                    retryable: false,
                    data: None,
                }),
            )
                .into_response()
        } else {
            next.run(request).await
        };
    response
        .headers_mut()
        .insert(HEADER, HeaderValue::from_str(version).unwrap());
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, middleware, routing::post, Router};
    use tower::ServiceExt;

    #[tokio::test]
    async fn stale_browser_cannot_mutate_even_when_it_missed_deployment_events() {
        let router = Router::new()
            .route("/v1/projects", post(|| async { StatusCode::CREATED }))
            .layer(middleware::from_fn(enforce));
        for (version, status) in [
            (Some("old"), StatusCode::CONFLICT),
            (Some("1"), StatusCode::CONFLICT),
            (Some("2"), StatusCode::CREATED),
            (None, StatusCode::CREATED),
        ] {
            let mut request = Request::builder().method("POST").uri("/v1/projects");
            if let Some(version) = version {
                request = request.header(HEADER, version);
            }
            let response = router
                .clone()
                .oneshot(request.body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), status);
            assert_eq!(response.headers()[HEADER], "2");
        }
    }
}
