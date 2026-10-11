//! Bounded, deterministic agent-facing excerpts. Native history remains authoritative.
use crate::{
    api::AppState,
    app_server_api::{self, SortDirection, ThreadTurnItemsView, ThreadTurnSnapshot},
    error::{ApiError, ApiResult},
};
use axum::{
    extract::{Path, Query, State},
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use utoipa::{IntoParams, ToSchema};

#[derive(Debug, Default, Deserialize, IntoParams, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CompactTurnsQuery {
    pub cursor: Option<String>,
    pub limit: Option<u32>,
    pub max_chars: Option<usize>,
    #[serde(default)]
    pub include_tool_output: bool,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CompactTurnsResponse {
    pub thread_id: String,
    pub turns: Vec<CompactTurn>,
    pub next_cursor: Option<String>,
    pub truncated: bool,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CompactTurn {
    pub id: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub items: Vec<CompactItem>,
    pub omitted_items: usize,
    pub truncated: bool,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CompactItem {
    pub id: String,
    pub item_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phase: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub success: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    pub truncated: bool,
}

#[utoipa::path(get, path = "/v1/self-control/threads/{threadId}/turns/compact", params(CompactTurnsQuery), responses((status = 200, body = CompactTurnsResponse)))]
pub async fn get_compact_turns(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    Query(query): Query<CompactTurnsQuery>,
) -> ApiResult<Json<CompactTurnsResponse>> {
    let limit = query.limit.unwrap_or(5);
    let max_chars = query.max_chars.unwrap_or(16_000);
    if !(1..=20).contains(&limit) || !(256..=64_000).contains(&max_chars) {
        return Err(ApiError::BadRequest(
            "limit must be 1–20 and maxChars must be 256–64000".into(),
        ));
    }
    let revision = state.store.latest_event_seq().await?;
    let page = app_server_api::client(&state.app_server)
        .thread_turns_list_page(
            thread_id.clone(),
            query.cursor,
            SortDirection::Desc,
            ThreadTurnItemsView::Full,
            Some(limit),
        )
        .await?;
    // A revert while native history was being read invalidates this entire excerpt.
    state
        .thread_views
        .ensure_history_current(&thread_id, revision)
        .await?;
    let turns = compact_turns(&page.data, max_chars, query.include_tool_output);
    Ok(Json(CompactTurnsResponse {
        thread_id,
        truncated: turns.iter().any(|turn| turn.truncated),
        turns,
        next_cursor: page.next_cursor,
    }))
}

pub(crate) fn compact_turns(
    turns: &[ThreadTurnSnapshot],
    max_chars: usize,
    include_tools: bool,
) -> Vec<CompactTurn> {
    let mut budget = TextBudget(max_chars);
    let mut remaining_items = 200;
    turns
        .iter()
        .map(|turn| {
            let (error, mut truncated) = budget.optional(
                turn.raw_payload
                    .pointer("/error/message")
                    .and_then(Value::as_str),
            );
            let mut items = Vec::new();
            let mut omitted_items = 0;
            for item in &turn.items {
                if remaining_items == 0 {
                    omitted_items += 1;
                    continue;
                }
                remaining_items -= 1;
                let raw = &item.raw_payload;
                let (error, error_cut) = budget.optional(
                    raw.pointer("/error/message")
                        .or_else(|| raw.get("error"))
                        .and_then(Value::as_str),
                );
                let (text, text_cut) = match item.item_type.as_str() {
                    "userMessage" => {
                        let text = app_server_api::visible_text_from_thread_item(raw);
                        budget.optional(text.as_deref())
                    }
                    "agentMessage" => budget.optional(raw.get("text").and_then(Value::as_str)),
                    _ if include_tools => tool_text(&mut budget, raw),
                    _ => (None, false),
                };
                truncated |= error_cut || text_cut;
                items.push(CompactItem {
                    id: item.id.clone(),
                    item_type: item.item_type.clone(),
                    status: raw.get("status").and_then(Value::as_str).map(str::to_owned),
                    phase: raw.get("phase").and_then(Value::as_str).map(str::to_owned),
                    exit_code: raw.get("exitCode").and_then(Value::as_i64),
                    success: raw.get("success").and_then(Value::as_bool),
                    error,
                    text,
                    truncated: error_cut || text_cut,
                });
            }
            CompactTurn {
                id: turn.id.clone(),
                status: turn.status.clone(),
                error,
                items,
                omitted_items,
                truncated: truncated || omitted_items > 0,
            }
        })
        .collect()
}

struct TextBudget(usize);
impl TextBudget {
    fn optional(&mut self, text: Option<&str>) -> (Option<String>, bool) {
        let Some(text) = text else {
            return (None, false);
        };
        let limit = self.0.min(4_000);
        let mut chars = text.chars();
        let excerpt: String = chars.by_ref().take(limit).collect();
        self.0 -= excerpt.chars().count();
        (Some(excerpt), chars.next().is_some())
    }
}

// Only text output fields are selected; no arguments, raw results, images or config payloads.
fn tool_text(budget: &mut TextBudget, raw: &Value) -> (Option<String>, bool) {
    if let Some(text) = raw
        .get("aggregatedOutput")
        .or_else(|| raw.get("output"))
        .and_then(Value::as_str)
    {
        return budget.optional(Some(text));
    }
    let content = raw
        .pointer("/result/content")
        .or_else(|| raw.get("contentItems"))
        .or_else(|| raw.get("output"))
        .and_then(Value::as_array);
    let Some(content) = content else {
        return (None, false);
    };
    let mut field_budget = TextBudget(budget.0.min(4_000));
    let initial_budget = field_budget.0;
    let mut combined = String::new();
    let mut truncated = false;
    for block in content {
        if let Some(text) = block.get("text").and_then(Value::as_str) {
            if !combined.is_empty() && !text.is_empty() {
                let (separator, cut) = field_budget.optional(Some("\n"));
                combined.push_str(&separator.unwrap_or_default());
                truncated |= cut;
            }
            let (text, cut) = field_budget.optional(Some(text));
            combined.push_str(&text.unwrap_or_default());
            truncated |= cut;
        }
    }
    budget.0 -= initial_budget - field_budget.0;
    (Some(combined), truncated)
}
