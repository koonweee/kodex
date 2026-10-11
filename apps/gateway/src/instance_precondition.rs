use axum::{
    extract::{Request, State},
    http::StatusCode,
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};

pub const HEADER: &str = "x-kodex-expected-instance";

pub async fn enforce(State(instance_id): State<String>, request: Request, next: Next) -> Response {
    let mismatch = request
        .headers()
        .get(HEADER)
        .is_some_and(|expected| expected.as_bytes() != instance_id.as_bytes());
    if mismatch {
        return (
            StatusCode::CONFLICT,
            Json(crate::error::ApiErrorBody {
                code: "executor_instance_mismatch".to_string(),
                message: "The executor at this endpoint no longer matches the registered instance."
                    .to_string(),
                retryable: false,
                data: None,
            }),
        )
            .into_response();
    }
    next.run(request).await
}
