use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use utoipa::ToSchema;

use crate::app_server::JsonRpcError;

pub type ApiResult<T> = Result<T, ApiError>;

#[derive(Debug, Error)]
pub enum ApiError {
    #[error("not found: {0}")]
    NotFound(String),
    #[error("bad request: {0}")]
    BadRequest(String),
    #[error("unsupported media type: {0}")]
    UnsupportedMediaType(String),
    #[error("conflict: {0}")]
    Conflict(String),
    #[error("thread archived: {0}")]
    ThreadArchived(String),
    #[error("native configuration write rejected: {0:?}")]
    NativeConfigWrite(NativeConfigWriteErrorCode),
    #[error("app-server unavailable")]
    AppServerUnavailable,
    #[error("retryable app-server error: {0}")]
    Retryable(String),
    #[error("{}", native_rpc_public_error(.0))]
    NativeRpc(JsonRpcError),
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<NativeConfigWriteErrorData>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum NativeConfigWriteErrorCode {
    ConfigLayerReadonly,
    ConfigRequirementReadonly,
    ConfigVersionConflict,
    ConfigValidationError,
    ConfigPathNotFound,
    ConfigSchemaUnknownKey,
    UserLayerNotFound,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct NativeConfigWriteErrorData {
    pub config_write_error_code: NativeConfigWriteErrorCode,
}

impl NativeConfigWriteErrorCode {
    fn message(&self) -> &'static str {
        match self {
            Self::ConfigVersionConflict => {
                "Configuration changed since this view was read. Refetch and review before saving."
            }
            Self::ConfigLayerReadonly => {
                "The selected native configuration layer is read-only or is no longer active."
            }
            Self::ConfigRequirementReadonly => {
                "A managed native requirement prevents this configuration change."
            }
            Self::ConfigValidationError => "Native configuration validation rejected the change.",
            Self::ConfigPathNotFound => "The native configuration path was not found.",
            Self::ConfigSchemaUnknownKey => "The native configuration key is not recognized.",
            Self::UserLayerNotFound => "The native user configuration layer was not found.",
        }
    }
}

impl ApiError {
    pub fn status_code(&self) -> StatusCode {
        match self {
            Self::NativeRpc(error) => native_rpc_public_error(error).status_code(),
            Self::NotFound(_) => StatusCode::NOT_FOUND,
            Self::BadRequest(_) => StatusCode::BAD_REQUEST,
            Self::UnsupportedMediaType(_) => StatusCode::UNSUPPORTED_MEDIA_TYPE,
            Self::ThreadArchived(_) => StatusCode::GONE,
            Self::Conflict(_)
            | Self::NativeConfigWrite(NativeConfigWriteErrorCode::ConfigVersionConflict) => {
                StatusCode::CONFLICT
            }
            Self::NativeConfigWrite(_) => StatusCode::BAD_REQUEST,
            Self::AppServerUnavailable => StatusCode::SERVICE_UNAVAILABLE,
            Self::Retryable(_) => StatusCode::TOO_MANY_REQUESTS,
            Self::BadGateway(_) => StatusCode::BAD_GATEWAY,
            Self::Store(_) | Self::Io(_) | Self::Other(_) => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }

    pub fn body(&self) -> ApiErrorBody {
        match self {
            Self::NativeRpc(error) => native_rpc_public_error(error).body(),
            Self::NotFound(message) => ApiErrorBody {
                code: "not_found".to_string(),
                message: message.clone(),
                retryable: false,
                data: None,
            },
            Self::BadRequest(message) => ApiErrorBody {
                code: "bad_request".to_string(),
                message: message.clone(),
                retryable: false,
                data: None,
            },
            Self::UnsupportedMediaType(message) => ApiErrorBody {
                code: "unsupported_media_type".to_string(),
                message: message.clone(),
                retryable: false,
                data: None,
            },
            Self::Conflict(message) => ApiErrorBody {
                code: "conflict".to_string(),
                message: message.clone(),
                retryable: false,
                data: None,
            },
            Self::ThreadArchived(thread_id) => ApiErrorBody {
                code: "thread_archived".to_string(),
                message: format!("Thread {thread_id} is archived"),
                retryable: false,
                data: None,
            },
            Self::NativeConfigWrite(code) => ApiErrorBody {
                code: if *code == NativeConfigWriteErrorCode::ConfigVersionConflict {
                    "config_version_conflict"
                } else {
                    "config_write_error"
                }
                .into(),
                message: code.message().into(),
                retryable: false,
                data: Some(NativeConfigWriteErrorData {
                    config_write_error_code: code.clone(),
                }),
            },
            Self::AppServerUnavailable => ApiErrorBody {
                code: "app_server_unavailable".to_string(),
                message: "Codex app-server is not ready".to_string(),
                retryable: true,
                data: None,
            },
            Self::Retryable(message) => ApiErrorBody {
                code: "app_server_retryable".to_string(),
                message: message.clone(),
                retryable: true,
                data: None,
            },
            Self::BadGateway(message) => ApiErrorBody {
                code: "bad_gateway".to_string(),
                message: message.clone(),
                retryable: true,
                data: None,
            },
            Self::Store(_) | Self::Io(_) | Self::Other(_) => ApiErrorBody {
                code: "internal_error".to_string(),
                message: "internal server error".to_string(),
                retryable: false,
                data: None,
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

// Native failures retain their wire fields until the HTTP response boundary.
// Config errors expose only the approved code because data can contain secrets.
fn native_rpc_public_error(error: &JsonRpcError) -> ApiError {
    if error.code == -32001 {
        return ApiError::Retryable(error.message.clone());
    }
    if let Some(code) = error.config_write_error_code() {
        return ApiError::NativeConfigWrite(code);
    }
    let message = if let Some(data) = &error.data {
        format!(
            "app-server error {}: {}; data: {}",
            error.code, error.message, data
        )
    } else {
        format!("app-server error {}: {}", error.code, error.message)
    };
    ApiError::BadGateway(message)
}
