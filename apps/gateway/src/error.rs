use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use utoipa::ToSchema;

pub type ApiResult<T> = Result<T, ApiError>;

#[derive(Debug, Error)]
pub enum ApiError {
    #[error("not found: {0}")]
    NotFound(String),
    #[error("bad request: {0}")]
    BadRequest(String),
    #[error("app-server unavailable")]
    AppServerUnavailable,
    #[error("retryable app-server error: {0}")]
    Retryable(String),
    #[error("bad gateway: {0}")]
    BadGateway(String),
    #[error(transparent)]
    Store(#[from] sqlx::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Other(#[from] anyhow::Error),
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ApiErrorBody {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

impl ApiError {
    pub fn status_code(&self) -> StatusCode {
        match self {
            Self::NotFound(_) => StatusCode::NOT_FOUND,
            Self::BadRequest(_) => StatusCode::BAD_REQUEST,
            Self::AppServerUnavailable => StatusCode::SERVICE_UNAVAILABLE,
            Self::Retryable(_) => StatusCode::TOO_MANY_REQUESTS,
            Self::BadGateway(_) => StatusCode::BAD_GATEWAY,
            Self::Store(_) | Self::Io(_) | Self::Other(_) => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }

    pub fn body(&self) -> ApiErrorBody {
        match self {
            Self::NotFound(message) => ApiErrorBody {
                code: "not_found".to_string(),
                message: message.clone(),
                retryable: false,
            },
            Self::BadRequest(message) => ApiErrorBody {
                code: "bad_request".to_string(),
                message: message.clone(),
                retryable: false,
            },
            Self::AppServerUnavailable => ApiErrorBody {
                code: "app_server_unavailable".to_string(),
                message: "Codex app-server is not ready".to_string(),
                retryable: true,
            },
            Self::Retryable(message) => ApiErrorBody {
                code: "app_server_retryable".to_string(),
                message: message.clone(),
                retryable: true,
            },
            Self::BadGateway(message) => ApiErrorBody {
                code: "bad_gateway".to_string(),
                message: message.clone(),
                retryable: true,
            },
            Self::Store(_) | Self::Io(_) | Self::Other(_) => ApiErrorBody {
                code: "internal_error".to_string(),
                message: "internal server error".to_string(),
                retryable: false,
            },
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        tracing::warn!(error = %self, "request failed");
        (self.status_code(), Json(self.body())).into_response()
    }
}

impl From<serde_json::Error> for ApiError {
    fn from(error: serde_json::Error) -> Self {
        Self::Other(anyhow::Error::new(error))
    }
}
