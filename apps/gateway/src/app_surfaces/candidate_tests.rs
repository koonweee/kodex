use serde_json::{json, Value};

use super::McpAppSurfaceCandidate;

fn native_item() -> Value {
    json!({
        "id": "call-widget",
        "type": "mcpToolCall",
        "server": "codex_apps",
        "tool": "calendar",
        "status": "completed",
        "arguments": {"date": "2026-10-05"},
        "mcpAppUi": {
            "resourceUri": "ui://calendar/native",
            "preferredModelDisplayMode": "fullscreen"
        },
        "appContext": {
            "connectorId": "calendar-connector",
            "linkId": "calendar-account",
            "appName": "Calendar",
            "actionName": "Show day",
            "resourceUri": "ui://calendar/native",
            "unknownNativeField": {"keep": true}
        },
        "result": {
            "content": [{"type": "text", "text": "Calendar ready"}]
        },
        "error": null
    })
}

#[test]
fn native_widget_descriptor_is_sufficient_and_wins_legacy_result_uris() {
    let item = native_item();
    let native_only = McpAppSurfaceCandidate::from_item("turn-calendar", &item)
        .expect("native descriptor should discover the widget without catalog or legacy metadata");
    assert_eq!(native_only.resource_uri, "ui://calendar/native");

    let mut competing = item;
    competing["mcpAppResourceUri"] = json!("ui://calendar/legacy");
    competing["result"]["_meta"] = json!({"ui": {"resourceUri": "ui://calendar/result"}});
    let selected = McpAppSurfaceCandidate::from_item("turn-calendar", &competing).unwrap();
    assert_eq!(selected.resource_uri, "ui://calendar/native");
}

#[test]
fn native_app_identity_and_display_changes_invalidate_import_signature() {
    let mut item = native_item();
    item["mcpAppResourceUri"] = json!("ui://calendar/native");
    let original = McpAppSurfaceCandidate::from_item("turn-calendar", &item).unwrap();
    assert_eq!(original.signature["appContext"], item["appContext"]);
    assert_eq!(original.signature["mcpAppUi"], item["mcpAppUi"]);

    item["appContext"]["linkId"] = json!("different-account");
    let different_account = McpAppSurfaceCandidate::from_item("turn-calendar", &item).unwrap();
    assert_ne!(different_account.signature, original.signature);

    item["mcpAppUi"]["preferredModelDisplayMode"] = json!("inline");
    let different_display = McpAppSurfaceCandidate::from_item("turn-calendar", &item).unwrap();
    assert_ne!(different_display.signature, different_account.signature);
}

#[test]
fn result_widget_metadata_remains_a_bounded_fallback() {
    let mut item = native_item();
    item["mcpAppUi"] = Value::Null;
    item["result"]["_meta"] = json!({"ui": {"resourceUri": "ui://calendar/result"}});
    let selected = McpAppSurfaceCandidate::from_item("turn-calendar", &item).unwrap();
    assert_eq!(selected.resource_uri, "ui://calendar/result");

    item["result"]["_meta"] = Value::Null;
    item["_meta"] = json!({"ui": {"resourceUri": "ui://unrecognized-item-alias"}});
    assert!(McpAppSurfaceCandidate::from_item("turn-calendar", &item).is_none());
}

#[test]
fn imports_only_completed_native_calls_with_successful_results() {
    let mut item = native_item();
    item["mcpAppResourceUri"] = json!("ui://calendar/native");
    assert!(McpAppSurfaceCandidate::from_item("turn-calendar", &item).is_some());

    for status in ["inProgress", "failed", "unknown"] {
        let mut unfinished = item.clone();
        unfinished["status"] = json!(status);
        assert!(
            McpAppSurfaceCandidate::from_item("turn-calendar", &unfinished).is_none(),
            "{status} must not read a resource before native successful-call provenance exists"
        );
    }
    for (field, value) in [
        ("result", Value::Null),
        ("result", json!({"content": "malformed"})),
        ("error", json!({"message": "native tool failed"})),
    ] {
        let mut failed = item.clone();
        failed[field] = value;
        assert!(McpAppSurfaceCandidate::from_item("turn-calendar", &failed).is_none());
    }
}
