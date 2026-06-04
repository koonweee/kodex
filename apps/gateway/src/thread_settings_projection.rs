use serde_json::Value;

use crate::{
    api::AppState,
    app_server_api::{ActivePermissionProfile, ThreadSettingsUpdateRequest, ThreadSummary},
    error::{ApiError, ApiResult},
};

#[cfg(test)]
use crate::store::ThreadLocalSettingsOverlay;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ActivePermissionProfilePatch {
    Missing,
    Clear,
    Set(ActivePermissionProfile),
}

impl ActivePermissionProfilePatch {
    pub(crate) fn from_permissions_update(permissions: &Option<Option<String>>) -> Self {
        match permissions {
            Some(Some(permissions)) => Self::Set(ActivePermissionProfile {
                id: permissions.clone(),
                extends: None,
            }),
            Some(None) => Self::Clear,
            None => Self::Missing,
        }
    }

    pub(crate) fn from_thread_settings_value(settings: Option<&Value>) -> ApiResult<Self> {
        let Some(settings) = settings.and_then(Value::as_object) else {
            return Ok(Self::Missing);
        };
        let Some(profile) = settings.get("activePermissionProfile") else {
            return Ok(Self::Missing);
        };
        if profile.is_null() {
            return Ok(Self::Clear);
        }
        Ok(Self::Set(active_permission_profile_from_value(profile)?))
    }

    pub(crate) fn permissions_overlay(&self) -> Option<Option<String>> {
        match self {
            Self::Missing => None,
            Self::Clear => Some(None),
            Self::Set(profile) => Some(Some(profile.id.clone())),
        }
    }

    pub(crate) fn apply_to_thread_summary(&self, thread: &mut ThreadSummary) -> ApiResult<()> {
        match self {
            Self::Missing => {}
            Self::Clear => {
                thread.active_permission_profile = None;
                if let Some(raw_payload) = thread.raw_payload.as_object_mut() {
                    raw_payload.remove("activePermissionProfile");
                }
            }
            Self::Set(profile) => {
                thread.active_permission_profile = Some(profile.clone());
                if let Some(raw_payload) = thread.raw_payload.as_object_mut() {
                    raw_payload.insert(
                        "activePermissionProfile".to_string(),
                        serde_json::to_value(profile)?,
                    );
                }
            }
        }
        Ok(())
    }
}

pub(crate) async fn save_permissions_overlay_patch(
    state: &AppState,
    thread_id: &str,
    patch: &ActivePermissionProfilePatch,
) -> ApiResult<()> {
    let Some(permissions) = patch.permissions_overlay() else {
        return Ok(());
    };
    let mut settings = state
        .store
        .thread_local_settings_overlays(&[thread_id.to_string()])
        .await?
        .remove(thread_id)
        .unwrap_or_default();
    settings.permissions = permissions;
    settings.approval_policy = None;
    settings.approvals_reviewer = None;
    settings.sandbox = None;
    state
        .store
        .save_thread_local_settings_overlay(thread_id, &settings)
        .await
}

pub(crate) async fn save_thread_settings_overlay_patch(
    state: &AppState,
    thread_id: &str,
    request: &ThreadSettingsUpdateRequest,
    permissions_patch: &ActivePermissionProfilePatch,
) -> ApiResult<()> {
    let has_composer_patch =
        request.model.is_some() || request.effort.is_some() || request.service_tier.is_some();
    if !has_composer_patch && matches!(permissions_patch, ActivePermissionProfilePatch::Missing) {
        return Ok(());
    }

    let mut settings = state
        .store
        .thread_local_settings_overlays(&[thread_id.to_string()])
        .await?
        .remove(thread_id)
        .unwrap_or_default();
    if let Some(model) = request.model.as_ref() {
        settings.model = model.clone();
    }
    if let Some(effort) = request.effort.as_ref() {
        settings.reasoning_effort = effort.clone();
    }
    if let Some(service_tier) = request.service_tier.as_ref() {
        settings.service_tier = service_tier.clone();
    }
    if let Some(permissions) = permissions_patch.permissions_overlay() {
        settings.permissions = permissions;
        settings.approval_policy = None;
        settings.approvals_reviewer = None;
        settings.sandbox = None;
    }
    state
        .store
        .save_thread_local_settings_overlay(thread_id, &settings)
        .await
}

#[cfg(test)]
fn permissions_overlay_from_patch(
    patch: &ActivePermissionProfilePatch,
) -> ThreadLocalSettingsOverlay {
    let mut overlay = ThreadLocalSettingsOverlay::default();
    if let Some(permissions) = patch.permissions_overlay() {
        overlay.permissions = permissions;
    }
    overlay
}

fn active_permission_profile_from_value(profile: &Value) -> ApiResult<ActivePermissionProfile> {
    Ok(ActivePermissionProfile {
        id: required_string(profile, "id")?,
        extends: optional_string(profile, "extends"),
    })
}

fn required_string(value: &Value, field: &str) -> ApiResult<String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| ApiError::BadGateway(format!("missing string field {field}")))
}

fn optional_string(value: &Value, field: &str) -> Option<String> {
    value.get(field).and_then(Value::as_str).map(str::to_string)
}

#[cfg(test)]
mod tests {
    use chrono::Utc;
    use serde_json::json;

    use crate::app_server_api::ThreadStatus;

    use super::*;

    fn summary_with_profile() -> ThreadSummary {
        ThreadSummary {
            id: "thread-1".to_string(),
            name: None,
            cwd: "/tmp".to_string(),
            status: ThreadStatus::Idle,
            created_at: 1,
            updated_at: 2,
            source: None,
            model: None,
            reasoning_effort: None,
            service_tier: None,
            approval_policy: None,
            approvals_reviewer: None,
            active_permission_profile: Some(ActivePermissionProfile {
                id: ":read-only".to_string(),
                extends: None,
            }),
            agent_nickname: None,
            agent_role: None,
            sandbox: None,
            git_info: None,
            pinned_at: Some(Utc::now()),
            preview: None,
            last_completed_agent_turn_seq: None,
            seen_completed_agent_turn_seq: 0,
            unread_completed_agent_turn: false,
            notifications_enabled: true,
            raw_payload: json!({
                "id": "thread-1",
                "cwd": "/tmp",
                "status": { "type": "idle" },
                "createdAt": 1,
                "updatedAt": 2,
                "activePermissionProfile": { "id": ":read-only" }
            }),
        }
    }

    #[test]
    fn missing_patch_leaves_summary_and_overlay_unchanged() {
        let mut summary = summary_with_profile();
        let before = summary.clone();
        let patch = ActivePermissionProfilePatch::Missing;

        patch.apply_to_thread_summary(&mut summary).unwrap();

        assert_eq!(
            summary.active_permission_profile,
            before.active_permission_profile
        );
        assert_eq!(
            summary.raw_payload["activePermissionProfile"],
            before.raw_payload["activePermissionProfile"]
        );
        assert_eq!(patch.permissions_overlay(), None);
        assert!(!permissions_overlay_from_patch(&patch).has_any_setting());
    }

    #[test]
    fn clear_patch_clears_summary_raw_payload_and_overlay() {
        let mut summary = summary_with_profile();
        let patch = ActivePermissionProfilePatch::Clear;

        patch.apply_to_thread_summary(&mut summary).unwrap();

        assert_eq!(summary.active_permission_profile, None);
        assert!(summary.raw_payload.get("activePermissionProfile").is_none());
        assert_eq!(patch.permissions_overlay(), Some(None));
        assert!(!permissions_overlay_from_patch(&patch).has_any_setting());
    }

    #[test]
    fn set_patch_updates_summary_raw_payload_and_overlay() {
        let mut summary = summary_with_profile();
        let patch = ActivePermissionProfilePatch::Set(ActivePermissionProfile {
            id: ":workspace-write".to_string(),
            extends: Some(":read-only".to_string()),
        });

        patch.apply_to_thread_summary(&mut summary).unwrap();

        assert_eq!(
            summary.active_permission_profile,
            Some(ActivePermissionProfile {
                id: ":workspace-write".to_string(),
                extends: Some(":read-only".to_string()),
            })
        );
        assert_eq!(
            summary.raw_payload["activePermissionProfile"],
            json!({ "id": ":workspace-write", "extends": ":read-only" })
        );
        assert_eq!(
            patch.permissions_overlay(),
            Some(Some(":workspace-write".to_string()))
        );
        assert_eq!(
            permissions_overlay_from_patch(&patch).permissions,
            Some(":workspace-write".to_string())
        );
    }

    #[test]
    fn parses_thread_settings_patch_variants() {
        assert_eq!(
            ActivePermissionProfilePatch::from_thread_settings_value(None).unwrap(),
            ActivePermissionProfilePatch::Missing
        );
        assert_eq!(
            ActivePermissionProfilePatch::from_thread_settings_value(Some(&json!({}))).unwrap(),
            ActivePermissionProfilePatch::Missing
        );
        assert_eq!(
            ActivePermissionProfilePatch::from_thread_settings_value(Some(&json!({
                "activePermissionProfile": null
            })))
            .unwrap(),
            ActivePermissionProfilePatch::Clear
        );
        assert_eq!(
            ActivePermissionProfilePatch::from_thread_settings_value(Some(&json!({
                "activePermissionProfile": {
                    "id": ":danger-full-access",
                    "extends": ":workspace-write"
                }
            })))
            .unwrap(),
            ActivePermissionProfilePatch::Set(ActivePermissionProfile {
                id: ":danger-full-access".to_string(),
                extends: Some(":workspace-write".to_string()),
            })
        );
    }
}
