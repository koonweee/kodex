use serde_json::{json, Value};

use super::{
    bad_gateway, optional_string, required_string, CodexClient, SortDirection, ThreadItemSnapshot,
};
use crate::error::ApiResult;

#[derive(Debug)]
pub struct ThreadItemEntry {
    pub turn_id: String,
    pub item: ThreadItemSnapshot,
}

#[derive(Debug)]
pub struct ThreadItemsListPage {
    pub data: Vec<ThreadItemEntry>,
    pub next_cursor: Option<String>,
    pub backwards_cursor: Option<String>,
}

impl CodexClient {
    /// Read native item history without activating a chat or loading its full
    /// transcript. The turn filter is also checked in the response so scoped
    /// consumers cannot accidentally display another turn's content.
    pub async fn thread_items_list_page(
        &self,
        thread_id: String,
        turn_id: Option<String>,
        cursor: Option<String>,
        sort_direction: SortDirection,
        limit: Option<u32>,
    ) -> ApiResult<ThreadItemsListPage> {
        let payload = self
            .request(
                "thread/items/list",
                json!({
                    "threadId":thread_id,
                    "turnId":turn_id,
                    "cursor":cursor,
                    "sortDirection":sort_direction.as_str(),
                    "limit":limit,
                }),
            )
            .await?;
        let data = payload
            .get("data")
            .and_then(Value::as_array)
            .ok_or_else(|| bad_gateway("thread/items/list response missing data array"))?
            .iter()
            .map(|entry| {
                let entry_turn_id = required_string(entry, "turnId")?;
                if turn_id
                    .as_ref()
                    .is_some_and(|turn_id| turn_id != &entry_turn_id)
                {
                    return Err(bad_gateway(
                        "thread/items/list response contains a different turn",
                    ));
                }
                let item = ThreadItemSnapshot::from_payload(
                    entry
                        .get("item")
                        .ok_or_else(|| bad_gateway("thread/items/list entry missing item"))?,
                )?;
                // Text is a required native field consumed by the preview.
                // Missing/wrong-type content is not an empty retained answer.
                if item.item_type == "agentMessage" {
                    required_string(&item.raw_payload, "text")?;
                }
                Ok(ThreadItemEntry {
                    turn_id: entry_turn_id,
                    item,
                })
            })
            .collect::<ApiResult<Vec<_>>>()?;
        Ok(ThreadItemsListPage {
            data,
            next_cursor: optional_string(&payload, "nextCursor"),
            backwards_cursor: optional_string(&payload, "backwardsCursor"),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_server::tests::RecordingAppServer;
    use std::sync::Arc;

    #[tokio::test]
    async fn native_items_keep_turn_item_identity_and_opaque_continuation() {
        let server = Arc::new(RecordingAppServer::default());
        server.queued_responses.lock().unwrap().extend([
            json!({"data":[{"turnId":"turn-a", "item":{
                "id":"item-a", "type":"userMessage", "clientId":"same-client",
                "content":[{"type":"text", "text":"same text", "text_elements":[]}]
            }}],"nextCursor":"opaque-next", "backwardsCursor":"opaque-back"}),
            json!({"data":[{"turnId":"turn-a", "item":{
                "id":"item-b", "type":"userMessage", "clientId":"same-client",
                "content":[{"type":"text", "text":"same text", "text_elements":[]}]
            }}],"nextCursor":null, "backwardsCursor":"opaque-new-back"}),
        ]);
        let client = CodexClient::new(server.clone());
        let first = client
            .thread_items_list_page(
                "thread-a".into(),
                Some("turn-a".into()),
                None,
                SortDirection::Desc,
                Some(1),
            )
            .await
            .unwrap();
        assert_eq!(first.data[0].turn_id, "turn-a");
        assert_eq!(first.data[0].item.id, "item-a");
        assert_eq!(first.data[0].item.client_id.as_deref(), Some("same-client"));
        assert_eq!(first.backwards_cursor.as_deref(), Some("opaque-back"));
        let second = client
            .thread_items_list_page(
                "thread-a".into(),
                Some("turn-a".into()),
                first.next_cursor,
                SortDirection::Desc,
                Some(1),
            )
            .await
            .unwrap();
        assert_eq!(second.data[0].item.id, "item-b");
        assert!(second.next_cursor.is_none());
        let requests = server.requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert_eq!(
            requests[0],
            (
                "thread/items/list".into(),
                json!({"threadId":"thread-a","turnId":"turn-a","cursor":null,"sortDirection":"desc","limit":1})
            )
        );
        assert_eq!(requests[1].1["cursor"], "opaque-next");
    }

    #[tokio::test]
    async fn scoped_native_items_reject_other_turns_and_shape_drift_without_retry() {
        for payload in [
            json!({"data":[{"turnId":"other", "item":{"id":"answer","type":"agentMessage","text":"wrong answer"}}]}),
            json!({"data":[{"item":{"id":"answer","type":"agentMessage","text":"missing turn"}}]}),
            json!({"data":[{"turnId":"expected"}]}),
            json!({"data":[{"turnId":"expected", "item":{"id":"answer","type":"agentMessage"}}]}),
            json!({"data":[{"turnId":"expected", "item":{"id":"answer","type":"agentMessage","text":[]}}]}),
            json!({"data":{}}),
        ] {
            let server = Arc::new(RecordingAppServer::default());
            *server.next_response.lock().unwrap() = Some(payload);
            assert!(CodexClient::new(server.clone())
                .thread_items_list_page(
                    "thread".into(),
                    Some("expected".into()),
                    None,
                    SortDirection::Desc,
                    Some(16)
                )
                .await
                .is_err());
            assert_eq!(server.requests.lock().unwrap().len(), 1);
        }
    }
}
