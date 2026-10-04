use std::path::{Component, Path};

use super::*;

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeConfigWriteTarget {
    pub file_path: String,
    pub version: String,
}

impl NativeConfigWriteTarget {
    pub fn validate_owned_path(&self, home: &Path) -> ApiResult<()> {
        let file = Path::new(&self.file_path);
        let relative = file.strip_prefix(home).map_err(|_| {
            ApiError::BadRequest("config writes must remain inside the Kodex native home".into())
        })?;
        if !file.is_absolute() || relative.as_os_str().is_empty() {
            return Err(ApiError::BadRequest(
                "config write target must be an absolute file path".into(),
            ));
        }
        let mut owned = home.to_path_buf();
        crate::native_runtime::reject_leaf_symlink(&owned)
            .map_err(|error| ApiError::BadRequest(error.to_string()))?;
        for component in relative.components() {
            let Component::Normal(component) = component else {
                return Err(ApiError::BadRequest(
                    "config write target must be normalized".into(),
                ));
            };
            owned.push(component);
            crate::native_runtime::reject_leaf_symlink(&owned)
                .map_err(|error| ApiError::BadRequest(error.to_string()))?;
        }
        let resolved = crate::native_runtime::canonical_future_path(&owned)
            .map_err(|error| ApiError::BadRequest(error.to_string()))?;
        if resolved != file {
            return Err(ApiError::BadRequest(
                "config write target must use its owned canonical path".into(),
            ));
        }
        Ok(())
    }
}

pub(super) fn native_config_write_target(
    payload: &Value,
    home: &Path,
) -> Option<NativeConfigWriteTarget> {
    // Native config/read returns layers from highest to lowest priority. The
    // first user layer is also the native writer's active target, including profiles.
    let layer = payload.get("layers")?.as_array()?.iter().find(|layer| {
        layer
            .get("name")
            .and_then(|name| name.get("type"))
            .and_then(Value::as_str)
            == Some("user")
    })?;
    if layer
        .get("disabledReason")
        .is_some_and(|reason| !reason.is_null())
    {
        return None;
    }
    let target = NativeConfigWriteTarget {
        file_path: layer.get("name")?.get("file")?.as_str()?.to_string(),
        version: layer.get("version")?.as_str()?.to_string(),
    };
    target.validate_owned_path(home).ok()?;
    Some(target)
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct NativeConfigLeafEdit {
    /// Native key-path segments relative to one MCP server. Null deletes the leaf.
    pub key_path: Vec<String>,
    pub value: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct NativeConfigWriteResult {
    pub status: NativeConfigWriteStatus,
    pub file_path: String,
    pub version: String,
    #[schema(required = true)]
    pub overridden_metadata: Option<NativeConfigOverriddenMetadata>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum NativeConfigWriteStatus {
    Ok,
    OkOverridden,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct NativeConfigOverriddenMetadata {
    pub message: String,
    pub overriding_layer: NativeConfigLayerMetadata,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct NativeConfigLayerMetadata {
    pub kind: String,
    pub file_path: Option<String>,
    pub profile: Option<String>,
    pub version: String,
}

impl NativeConfigWriteResult {
    fn from_payload(payload: Value) -> ApiResult<Self> {
        let overridden_metadata = payload
            .get("overriddenMetadata")
            .filter(|value| !value.is_null())
            .map(|value| {
                let layer = value
                    .get("overridingLayer")
                    .ok_or_else(|| bad_gateway("config write override missing layer"))?;
                let name = layer
                    .get("name")
                    .ok_or_else(|| bad_gateway("config write override missing layer name"))?;
                Ok::<_, ApiError>(NativeConfigOverriddenMetadata {
                    message: required_string(value, "message")?,
                    overriding_layer: NativeConfigLayerMetadata {
                        kind: required_string(name, "type")?,
                        file_path: optional_string(name, "file")
                            .or_else(|| optional_string(name, "dotCodexFolder")),
                        profile: optional_string(name, "profile"),
                        version: required_string(layer, "version")?,
                    },
                })
            })
            .transpose()?;
        Ok(Self {
            status: serde_json::from_value(payload.get("status").cloned().unwrap_or_default())
                .map_err(|error| bad_gateway(format!("config write status: {error}")))?,
            file_path: required_string(&payload, "filePath")?,
            version: required_string(&payload, "version")?,
            // Native effectiveValue may contain credentials. It is deliberately
            // absent from the public write result; refills use masked projections.
            overridden_metadata,
        })
    }
}

pub(super) fn config_edit(key_path: &str, value: Value) -> Value {
    json!({"keyPath":key_path,"mergeStrategy":"replace","value":value})
}

pub(super) fn native_config_key_segment(segment: &str) -> ApiResult<String> {
    if segment.is_empty() || segment.chars().any(char::is_control) {
        return Err(ApiError::BadRequest(
            "config key segments must be nonempty and contain no control characters".into(),
        ));
    }
    // The native parser unescapes the next character literally; JSON's \n or
    // \u escaping would change a key, so escape only its two delimiter characters.
    Ok(format!(
        "\"{}\"",
        segment.replace('\\', "\\\\").replace('"', "\\\"")
    ))
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ComposerSettingsResponse {
    #[schema(required = true)]
    pub write_target: Option<NativeConfigWriteTarget>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub service_tier: Option<String>,
    pub permission_profile_id: Option<String>,
    pub approval_policy: Option<String>,
    pub approvals_reviewer: Option<String>,
    pub permissions_preset: Option<ComposerPermissionsPreset>,
}

impl ComposerSettingsResponse {
    pub(super) fn from_payload(payload: Value, home: &Path) -> ApiResult<Self> {
        let config = payload
            .get("config")
            .ok_or_else(|| bad_gateway("config/read response missing config"))?;
        Ok(Self {
            write_target: native_config_write_target(&payload, home),
            model: optional_string(config, "model"),
            effort: optional_string(config, "model_reasoning_effort"),
            service_tier: optional_string(config, "service_tier"),
            permission_profile_id: optional_string(config, "default_permissions"),
            approval_policy: optional_string(config, "approval_policy"),
            approvals_reviewer: optional_string(config, "approvals_reviewer"),
            permissions_preset: composer_permissions_preset(config),
        })
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum ComposerPermissionsPreset {
    Default,
    AutoReview,
    FullAccess,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ComposerSettingsUpdateRequest {
    pub write_target: NativeConfigWriteTarget,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_string_update",
        skip_serializing_if = "Option::is_none"
    )]
    pub model: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_string_update",
        skip_serializing_if = "Option::is_none"
    )]
    pub effort: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_string_update",
        skip_serializing_if = "Option::is_none"
    )]
    pub service_tier: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_string_update",
        skip_serializing_if = "Option::is_none"
    )]
    pub permission_profile_id: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_string_update",
        skip_serializing_if = "Option::is_none"
    )]
    pub approval_policy: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_string_update",
        skip_serializing_if = "Option::is_none"
    )]
    pub approvals_reviewer: Option<Option<String>>,
}

impl ComposerSettingsUpdateRequest {
    fn config_edits(self) -> Vec<Value> {
        let mut edits = Vec::new();
        if let Some(model) = self.model {
            edits.push(config_edit("model", option_string_value(model)));
        }
        if let Some(effort) = self.effort {
            edits.push(config_edit(
                "model_reasoning_effort",
                option_string_value(effort),
            ));
        }
        if let Some(service_tier) = self.service_tier {
            edits.push(config_edit(
                "service_tier",
                option_string_value(service_tier),
            ));
        }
        if let Some(permission_profile_id) = self.permission_profile_id {
            edits.push(config_edit(
                "default_permissions",
                option_string_value(permission_profile_id),
            ));
        }
        if let Some(approval_policy) = self.approval_policy {
            edits.push(config_edit(
                "approval_policy",
                option_string_value(approval_policy),
            ));
        }
        if let Some(approvals_reviewer) = self.approvals_reviewer {
            edits.push(config_edit(
                "approvals_reviewer",
                option_string_value(approvals_reviewer),
            ));
        }
        edits
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ComposerSettingsUpdateResponse {
    pub saved: bool,
    pub write: NativeConfigWriteResult,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notification_error: Option<String>,
}

impl CodexClient {
    pub async fn composer_settings(
        &self,
        cwd: Option<String>,
        home: &Path,
    ) -> ApiResult<ComposerSettingsResponse> {
        let payload = self
            .request("config/read", json!({"cwd":cwd,"includeLayers":true}))
            .await?;
        ComposerSettingsResponse::from_payload(payload, home)
    }

    pub async fn update_composer_settings(
        &self,
        request: ComposerSettingsUpdateRequest,
    ) -> ApiResult<ComposerSettingsUpdateResponse> {
        let target = request.write_target.clone();
        let edits = request.config_edits();
        let write = self.config_batch_write(&target, edits, true).await?;
        Ok(ComposerSettingsUpdateResponse {
            saved: true,
            write,
            notification_error: None,
        })
    }

    pub(super) async fn config_batch_write(
        &self,
        target: &NativeConfigWriteTarget,
        edits: Vec<Value>,
        reload_user_config: bool,
    ) -> ApiResult<NativeConfigWriteResult> {
        if edits.is_empty() {
            return Err(ApiError::BadRequest(
                "at least one config edit is required".into(),
            ));
        }
        let payload = self
            .request(
                "config/batchWrite",
                json!({
                    "filePath":target.file_path,"expectedVersion":target.version,
                    "edits":edits,"reloadUserConfig":reload_user_config,
                }),
            )
            .await?;
        NativeConfigWriteResult::from_payload(payload)
    }
}
