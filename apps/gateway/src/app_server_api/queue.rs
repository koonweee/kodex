use std::sync::LazyLock;

use jsonschema::{Draft, JSONSchema};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use utoipa::ToSchema;

use super::{bad_gateway, CodexClient, RawAppServerResponse};
use crate::error::ApiResult;

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct NativeQueuedSubmission {
    pub id: String,
    pub client_user_message_id: String,
    // Native UserInput includes variants and fields absent from the older
    // gateway input enum. Preserve it after validation against the pinned schema.
    pub input: Vec<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct NativeQueuePage {
    pub data: Vec<NativeQueuedSubmission>,
    pub next_cursor: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubmissionResponse {
    queued_submission: NativeQueuedSubmission,
}

#[derive(Deserialize)]
struct DeleteResponse {
    deleted: bool,
}

static ADD_RESPONSE: LazyLock<JSONSchema> = LazyLock::new(|| {
    compile_schema(include_str!(
        "../../app-server-schema/0.160.0/json/v2/ThreadQueueAddResponse.json"
    ))
});
static LIST_RESPONSE: LazyLock<JSONSchema> = LazyLock::new(|| {
    compile_schema(include_str!(
        "../../app-server-schema/0.160.0/json/v2/ThreadQueueListResponse.json"
    ))
});
static UPDATE_RESPONSE: LazyLock<JSONSchema> = LazyLock::new(|| {
    compile_schema(include_str!(
        "../../app-server-schema/0.160.0/json/v2/ThreadQueueUpdateResponse.json"
    ))
});
static DELETE_RESPONSE: LazyLock<JSONSchema> = LazyLock::new(|| {
    compile_schema(include_str!(
        "../../app-server-schema/0.160.0/json/v2/ThreadQueueDeleteResponse.json"
    ))
});
static REORDER_RESPONSE: LazyLock<JSONSchema> = LazyLock::new(|| {
    compile_schema(include_str!(
        "../../app-server-schema/0.160.0/json/v2/ThreadQueueReorderResponse.json"
    ))
});
static START_RESPONSE: LazyLock<JSONSchema> = LazyLock::new(|| {
    compile_schema(include_str!(
        "../../app-server-schema/0.160.0/json/v2/ThreadQueueStartResponse.json"
    ))
});

fn compile_schema(source: &str) -> JSONSchema {
    let schema: Value =
        serde_json::from_str(source).expect("checked-in native queue schema must be valid JSON");
    JSONSchema::options()
        .with_draft(Draft::Draft7)
        .compile(&schema)
        .expect("checked-in native queue schema must compile")
}

impl CodexClient {
    pub async fn queue_add(
        &self,
        thread_id: String,
        input: Vec<Value>,
        client_id: String,
    ) -> ApiResult<NativeQueuedSubmission> {
        let response: SubmissionResponse = self
            .queue_response(
                "thread/queue/add",
                json!({"threadId":thread_id,"input":input,"clientUserMessageId":client_id}),
                &ADD_RESPONSE,
            )
            .await?;
        Ok(response.queued_submission)
    }

    pub async fn queue_list(
        &self,
        thread_id: String,
        cursor: Option<String>,
        limit: Option<u32>,
    ) -> ApiResult<NativeQueuePage> {
        self.queue_response(
            "thread/queue/list",
            json!({"threadId":thread_id,"cursor":cursor,"limit":limit}),
            &LIST_RESPONSE,
        )
        .await
    }

    pub async fn queue_update(
        &self,
        thread_id: String,
        queue_id: String,
        input: Vec<Value>,
    ) -> ApiResult<NativeQueuedSubmission> {
        let response: SubmissionResponse = self
            .queue_response(
                "thread/queue/update",
                json!({"threadId":thread_id,"queuedSubmissionId":queue_id,"input":input}),
                &UPDATE_RESPONSE,
            )
            .await?;
        Ok(response.queued_submission)
    }

    pub async fn queue_delete(&self, thread_id: String, queue_id: String) -> ApiResult<bool> {
        let response: DeleteResponse = self
            .queue_response(
                "thread/queue/delete",
                json!({"threadId":thread_id,"queuedSubmissionId":queue_id}),
                &DELETE_RESPONSE,
            )
            .await?;
        Ok(response.deleted)
    }

    pub async fn queue_reorder(&self, thread_id: String, queue_ids: Vec<String>) -> ApiResult<()> {
        let _: Value = self
            .queue_response(
                "thread/queue/reorder",
                json!({"threadId":thread_id,"queuedSubmissionIds":queue_ids}),
                &REORDER_RESPONSE,
            )
            .await?;
        Ok(())
    }

    /// Return the validated native turn acknowledgement. Completion and queue
    /// state remain native-owned and must be observed independently.
    pub async fn queue_start(
        &self,
        thread_id: String,
        queue_id: Option<String>,
    ) -> ApiResult<RawAppServerResponse> {
        let payload = self
            .queue_response(
                "thread/queue/start",
                json!({"threadId":thread_id,"queuedSubmissionId":queue_id}),
                &START_RESPONSE,
            )
            .await?;
        Ok(RawAppServerResponse { payload })
    }

    async fn queue_response<T: DeserializeOwned>(
        &self,
        method: &str,
        params: Value,
        schema: &JSONSchema,
    ) -> ApiResult<T> {
        let payload = self.request(method, params).await?;
        if !schema.is_valid(&payload) {
            // Validation errors may include submitted text or attachment data.
            // Report the contract boundary without exposing response contents.
            return Err(bad_gateway(format!(
                "{method} response does not match the pinned app-server schema"
            )));
        }
        serde_json::from_value(payload)
            .map_err(|_| bad_gateway(format!("{method} response could not be decoded")))
    }
}
