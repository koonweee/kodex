use axum::{
    extract::{Path, Query, State},
    routing::{get, post},
    Json, Router,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

use crate::{
    api::AppState,
    app_server_api,
    automations::{
        broadcast_automation_delete, broadcast_automation_upsert, AUTOMATION_MIN_INTERVAL_SECONDS,
    },
    error::{ApiError, ApiResult},
    store::{Automation, AutomationStatus, AutomationUpdate, NewAutomation},
};

#[derive(Debug, Deserialize, IntoParams, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AutomationListQuery {
    pub thread_id: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AutomationSchedule {
    /// Absolute RFC3339 timestamp for the first firing. Clients should send either a Z timestamp or an explicit UTC offset; the gateway normalizes and stores the instant in UTC. Fixed-duration repeats are not timezone or DST aware.
    #[schema(example = "2026-05-07T09:00:00-07:00")]
    pub start_at: DateTime<Utc>,
    /// Fixed-duration repeat interval. Accepted units are seconds, minutes, and hours; the effective interval must be at least 30 seconds.
    pub repeat_every: AutomationRepeatEvery,
}

#[derive(Debug, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRepeatEvery {
    /// Positive repeat interval value in the selected unit.
    #[schema(example = 1)]
    pub value: i64,
    /// Interval unit. The gateway canonicalizes this to seconds for storage and scheduling.
    pub unit: AutomationRepeatUnit,
}

#[derive(Debug, Deserialize, Serialize, Clone, Copy, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum AutomationRepeatUnit {
    Seconds,
    Minutes,
    Hours,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AutomationCreateRequest {
    /// Non-empty display name for the automation.
    #[schema(example = "Daily status")]
    pub name: String,
    /// Non-empty prompt to enqueue into the target thread at each scheduled firing.
    #[schema(example = "Summarize current repo state and next actions.")]
    pub prompt: String,
    /// Target thread id that will receive the queued automation prompt.
    pub target_thread_id: String,
    /// Initial schedule. startAt is an absolute instant; repeatEvery is a fixed duration.
    pub schedule: AutomationSchedule,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AutomationUpdateRequest {
    /// Replacement non-empty display name. Omit to keep the current name.
    pub name: Option<String>,
    /// Replacement non-empty prompt. Omit to keep the current prompt.
    pub prompt: Option<String>,
    /// Replacement target thread id. Omit to keep the current target thread.
    pub target_thread_id: Option<String>,
    /// Replacement full schedule. When provided, the gateway resets nextRunAt to schedule.startAt.
    pub schedule: Option<AutomationSchedule>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AutomationResponse {
    pub automation: AutomationDto,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AutomationListResponse {
    pub automations: Vec<AutomationDto>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AutomationDeleteResponse {
    pub id: String,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AutomationDto {
    pub id: String,
    pub name: String,
    pub prompt: String,
    pub target_thread_id: String,
    pub schedule: AutomationSchedule,
    /// Next due firing instant in UTC.
    pub next_run_at: DateTime<Utc>,
    pub status: AutomationStatus,
    pub paused_reason: Option<String>,
    pub last_run_at: Option<DateTime<Utc>>,
    pub last_queued_input_id: Option<String>,
    pub last_error: Option<String>,
    pub consecutive_failure_count: i64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/v1/automations",
            get(list_automations).post(create_automation),
        )
        .route(
            "/v1/automations/{automation_id}",
            get(get_automation)
                .patch(update_automation)
                .delete(delete_automation),
        )
        .route(
            "/v1/automations/{automation_id}/pause",
            post(pause_automation),
        )
        .route(
            "/v1/automations/{automation_id}/resume",
            post(resume_automation),
        )
}

#[utoipa::path(get, path = "/v1/automations", params(AutomationListQuery), responses((status = 200, body = AutomationListResponse)))]
pub async fn list_automations(
    State(state): State<AppState>,
    Query(query): Query<AutomationListQuery>,
) -> ApiResult<Json<AutomationListResponse>> {
    let automations = state
        .store
        .list_automations(query.thread_id.as_deref())
        .await?
        .into_iter()
        .map(automation_to_dto)
        .collect();
    Ok(Json(AutomationListResponse { automations }))
}

#[utoipa::path(post, path = "/v1/automations", request_body = AutomationCreateRequest, responses((status = 200, body = AutomationResponse)))]
pub async fn create_automation(
    State(state): State<AppState>,
    Json(request): Json<AutomationCreateRequest>,
) -> ApiResult<Json<AutomationResponse>> {
    validate_name_and_prompt(&request.name, &request.prompt)?;
    let repeat_every_seconds = repeat_every_seconds(&request.schedule.repeat_every)?;
    validate_target_thread(&state, &request.target_thread_id).await?;
    let automation = state
        .store
        .create_automation(NewAutomation {
            name: request.name,
            prompt: request.prompt,
            target_thread_id: request.target_thread_id,
            start_at: request.schedule.start_at,
            repeat_every_seconds,
            next_run_at: request.schedule.start_at,
        })
        .await?;
    broadcast_automation_upsert(&state, &automation).await?;
    Ok(Json(AutomationResponse {
        automation: automation_to_dto(automation),
    }))
}

#[utoipa::path(get, path = "/v1/automations/{automationId}", responses((status = 200, body = AutomationResponse)))]
pub async fn get_automation(
    State(state): State<AppState>,
    Path(automation_id): Path<String>,
) -> ApiResult<Json<AutomationResponse>> {
    Ok(Json(AutomationResponse {
        automation: automation_to_dto(state.store.get_automation(&automation_id).await?),
    }))
}

#[utoipa::path(patch, path = "/v1/automations/{automationId}", request_body = AutomationUpdateRequest, responses((status = 200, body = AutomationResponse)))]
pub async fn update_automation(
    State(state): State<AppState>,
    Path(automation_id): Path<String>,
    Json(request): Json<AutomationUpdateRequest>,
) -> ApiResult<Json<AutomationResponse>> {
    if let Some(name) = request.name.as_deref() {
        validate_non_empty("name", name)?;
    }
    if let Some(prompt) = request.prompt.as_deref() {
        validate_non_empty("prompt", prompt)?;
    }
    if let Some(target_thread_id) = request.target_thread_id.as_deref() {
        validate_target_thread(&state, target_thread_id).await?;
    }
    let (start_at, repeat_every_seconds, next_run_at) = match request.schedule {
        Some(schedule) => {
            let repeat_every_seconds = repeat_every_seconds(&schedule.repeat_every)?;
            let next_run_at = schedule.start_at;
            (
                Some(schedule.start_at),
                Some(repeat_every_seconds),
                Some(next_run_at),
            )
        }
        None => (None, None, None),
    };
    let automation = state
        .store
        .update_automation(
            &automation_id,
            AutomationUpdate {
                name: request.name,
                prompt: request.prompt,
                target_thread_id: request.target_thread_id,
                start_at,
                repeat_every_seconds,
                next_run_at,
            },
        )
        .await?;
    broadcast_automation_upsert(&state, &automation).await?;
    Ok(Json(AutomationResponse {
        automation: automation_to_dto(automation),
    }))
}

#[utoipa::path(post, path = "/v1/automations/{automationId}/pause", responses((status = 200, body = AutomationResponse)))]
pub async fn pause_automation(
    State(state): State<AppState>,
    Path(automation_id): Path<String>,
) -> ApiResult<Json<AutomationResponse>> {
    let automation = state.store.pause_automation(&automation_id, None).await?;
    broadcast_automation_upsert(&state, &automation).await?;
    Ok(Json(AutomationResponse {
        automation: automation_to_dto(automation),
    }))
}

#[utoipa::path(post, path = "/v1/automations/{automationId}/resume", responses((status = 200, body = AutomationResponse)))]
pub async fn resume_automation(
    State(state): State<AppState>,
    Path(automation_id): Path<String>,
) -> ApiResult<Json<AutomationResponse>> {
    let automation = state.store.resume_automation(&automation_id).await?;
    broadcast_automation_upsert(&state, &automation).await?;
    Ok(Json(AutomationResponse {
        automation: automation_to_dto(automation),
    }))
}

#[utoipa::path(delete, path = "/v1/automations/{automationId}", responses((status = 200, body = AutomationDeleteResponse)))]
pub async fn delete_automation(
    State(state): State<AppState>,
    Path(automation_id): Path<String>,
) -> ApiResult<Json<AutomationDeleteResponse>> {
    state.store.delete_automation(&automation_id).await?;
    broadcast_automation_delete(&state, &automation_id).await?;
    Ok(Json(AutomationDeleteResponse { id: automation_id }))
}

pub(crate) fn automation_to_dto(automation: Automation) -> AutomationDto {
    AutomationDto {
        id: automation.id,
        name: automation.name,
        prompt: automation.prompt,
        target_thread_id: automation.target_thread_id,
        schedule: AutomationSchedule {
            start_at: automation.start_at,
            repeat_every: AutomationRepeatEvery {
                value: automation.repeat_every_seconds,
                unit: AutomationRepeatUnit::Seconds,
            },
        },
        next_run_at: automation.next_run_at,
        status: automation.status,
        paused_reason: automation.paused_reason,
        last_run_at: automation.last_run_at,
        last_queued_input_id: automation.last_queued_input_id,
        last_error: automation.last_error,
        consecutive_failure_count: automation.consecutive_failure_count,
        created_at: automation.created_at,
        updated_at: automation.updated_at,
    }
}

async fn validate_target_thread(state: &AppState, thread_id: &str) -> ApiResult<()> {
    app_server_api::client(&state.app_server)
        .thread_read(thread_id.to_string())
        .await?;
    Ok(())
}

fn validate_name_and_prompt(name: &str, prompt: &str) -> ApiResult<()> {
    validate_non_empty("name", name)?;
    validate_non_empty("prompt", prompt)
}

fn validate_non_empty(field: &str, value: &str) -> ApiResult<()> {
    if value.trim().is_empty() {
        return Err(ApiError::BadRequest(format!("{field} must not be empty")));
    }
    Ok(())
}

fn repeat_every_seconds(repeat_every: &AutomationRepeatEvery) -> ApiResult<i64> {
    if repeat_every.value <= 0 {
        return Err(ApiError::BadRequest(
            "repeatEvery value must be positive".to_string(),
        ));
    }
    let multiplier = match repeat_every.unit {
        AutomationRepeatUnit::Seconds => 1,
        AutomationRepeatUnit::Minutes => 60,
        AutomationRepeatUnit::Hours => 60 * 60,
    };
    let seconds = repeat_every.value * multiplier;
    if seconds < AUTOMATION_MIN_INTERVAL_SECONDS {
        return Err(ApiError::BadRequest(format!(
            "repeatEvery must be at least {AUTOMATION_MIN_INTERVAL_SECONDS} seconds"
        )));
    }
    Ok(seconds)
}
