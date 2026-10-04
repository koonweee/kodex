use super::*;

#[tokio::test]
async fn native_http_queue_mutations_and_native_notifications_refill_both_clients() {
    let (state, native) = state().await;
    let other = state.clone();
    let cursor = state.store.latest_event_seq().await.unwrap();
    let mut first = stream(&state, cursor).await;
    let mut second = stream(&other, cursor).await;
    let queued = create(&state).await;
    marker(&mut first, "turn_queue.changed").await;
    marker(&mut second, "turn_queue.changed").await;
    let (_, listed) = request(&other, "GET", BASE, Value::Null).await;
    assert_eq!(listed["queuedInputs"][0], queued);

    native.rows.lock().unwrap().clear();
    ingest_inbound(
        InboundMessage::Notification {
            method: "thread/queue/changed".into(),
            params: json!({"threadId":THREAD}),
        },
        &state,
    )
    .await
    .unwrap();
    marker(&mut first, "turn_queue.changed").await;
    marker(&mut second, "turn_queue.changed").await;
    let (_, listed) = request(&other, "GET", BASE, Value::Null).await;
    assert_eq!(listed["queuedInputs"], json!([]));
    let (_, replay) = request(
        &other,
        "GET",
        &format!("/v1/events?threadId=other-chat&includeGlobal=true&cursor={cursor}"),
        Value::Null,
    )
    .await;
    let markers = replay["events"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|event| event["kind"] == "turn_queue.changed")
        .collect::<Vec<_>>();
    assert_eq!(markers.len(), 2);
    assert!(markers
        .iter()
        .all(|event| event["payload"] == json!({"threadId":THREAD})));
}

#[tokio::test]
async fn native_http_promotion_is_one_shared_transfer_until_exact_native_receipt() {
    let (state, native) = state().await;
    let other = state.clone();
    let retained = create(&state).await;
    let selected = create(&state).await;
    let path = format!("{BASE}/{}/steer", selected["id"].as_str().unwrap());
    let (status, first) = request(&state, "POST", &path, Value::Null).await;
    assert_eq!(status, StatusCode::OK, "{first}");
    assert_eq!(first["status"], "transfer");
    assert_eq!(first["transfer"]["phase"], "accepted");
    assert_eq!(first["transfer"]["input"], input());
    let id = first["transfer"]["id"].as_str().unwrap();
    assert_ne!(id, selected["clientUserMessageId"].as_str().unwrap());
    let before = native.requests.lock().unwrap().clone();
    let (status, repeated) = request(&other, "POST", &path, Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(repeated, first);
    assert_eq!(*native.requests.lock().unwrap(), before);
    let (status, _) = request(
        &other,
        "DELETE",
        &format!("/v1/queue-transfers/{id}"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(*native.requests.lock().unwrap(), before);
    let (_, listed) = request(&other, "GET", BASE, Value::Null).await;
    assert_eq!(listed["queuedInputs"].as_array().unwrap().len(), 1);
    assert_eq!(listed["queuedInputs"][0]["id"], retained["id"]);
    assert_eq!(listed["transfers"][0]["id"], id);
    let steers = before
        .iter()
        .filter(|(method, _)| method == "turn/steer")
        .collect::<Vec<_>>();
    assert_eq!(steers.len(), 1);
    assert_eq!(
        steers[0].1,
        json!({"threadId":THREAD,"expectedTurnId":TURN,"clientUserMessageId":id,"input":input()})
    );

    ingest_inbound(
        InboundMessage::Notification {
            method: "item/started".into(),
            params: json!({"threadId":THREAD,"turnId":TURN,"item":{
                "id":"native-promoted-item","type":"userMessage","clientId":id,"content":input(),
            }}),
        },
        &state,
    )
    .await
    .unwrap();
    let (_, listed) = request(&other, "GET", BASE, Value::Null).await;
    assert_eq!(listed["transfers"], json!([]));
    assert_eq!(listed["queuedInputs"][0]["id"], retained["id"]);
}

#[tokio::test]
async fn native_http_uncertain_transfer_can_only_reconcile_exact_receipt_or_be_dismissed() {
    for reconcile in [true, false] {
        let (state, native) = state().await;
        *native.steer_error.lock().unwrap() = true;
        let queued = create(&state).await;
        let (status, body) = request(
            &state,
            "POST",
            &format!("{BASE}/{}/steer", queued["id"].as_str().unwrap()),
            Value::Null,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["transfer"]["phase"], "uncertain");
        let id = body["transfer"]["id"].as_str().unwrap();
        let other = state.clone();
        let (_, listed) = request(&other, "GET", BASE, Value::Null).await;
        assert_eq!(listed["queuedInputs"], json!([]));
        assert_eq!(listed["transfers"][0]["input"], input());
        let (_, absent) = request(
            &other,
            "POST",
            &format!("/v1/queue-transfers/{id}/reconcile"),
            Value::Null,
        )
        .await;
        assert_eq!(absent["status"], "transfer");
        assert_eq!(absent["transfer"]["phase"], "uncertain");
        let before = native.requests.lock().unwrap().clone();
        if reconcile {
            *native.history.lock().unwrap() = vec![json!({"turnId":TURN,"item":{
                "id":"native-recovered-item","type":"userMessage","clientId":id,"content":input(),
            }})];
            let (status, delivered) = request(
                &other,
                "POST",
                &format!("/v1/queue-transfers/{id}/reconcile"),
                Value::Null,
            )
            .await;
            assert_eq!(status, StatusCode::OK);
            assert_eq!(delivered, json!({"status":"delivered","id":id}));
            assert_eq!(native.requests.lock().unwrap().len(), before.len() + 1);
            assert_eq!(
                native.requests.lock().unwrap().last().unwrap().0,
                "thread/items/list"
            );
        } else {
            let (status, deleted) = request(
                &other,
                "DELETE",
                &format!("/v1/queue-transfers/{id}"),
                Value::Null,
            )
            .await;
            assert_eq!(status, StatusCode::OK);
            assert_eq!(deleted, json!({"id":id,"threadId":THREAD}));
            assert_eq!(*native.requests.lock().unwrap(), before);
        }
        let (_, listed) = request(&state, "GET", BASE, Value::Null).await;
        assert_eq!(listed["transfers"], json!([]));
        assert_eq!(listed["queuedInputs"], json!([]));
        let calls = native.requests.lock().unwrap();
        assert_eq!(
            calls
                .iter()
                .filter(|(method, _)| method == "turn/steer")
                .count(),
            1
        );
        assert_eq!(
            calls
                .iter()
                .filter(|(method, _)| method == "thread/queue/add")
                .count(),
            1
        );
        assert!(calls
            .iter()
            .all(|(method, _)| method != "turn/start" && method != "thread/resume"));
    }
}

#[tokio::test]
async fn native_http_competing_edit_finishes_before_promotion_reads_its_lossless_input() {
    let (state, native) = state().await;
    let queued = create(&state).await;
    let row_id = queued["id"].as_str().unwrap().to_string();
    let edited = json!([{"type":"text","text":"Corrected before promotion"},{"type":"localAudio","path":"/fixture/revised.wav"}]);
    let (started, waiting) = oneshot::channel();
    let (release, held) = oneshot::channel();
    *native.update_gate.lock().unwrap() = Some((started, held));
    let editing_state = state.clone();
    let edit_path = format!("{BASE}/{row_id}");
    let edit_body = json!({"input":edited});
    let editing =
        tokio::spawn(async move { request(&editing_state, "PUT", &edit_path, edit_body).await });
    timeout(Duration::from_secs(2), waiting)
        .await
        .unwrap()
        .unwrap();
    let promoting_state = state.clone();
    let promote_path = format!("{BASE}/{row_id}/steer");
    let mut promoting =
        tokio::spawn(
            async move { request(&promoting_state, "POST", &promote_path, Value::Null).await },
        );
    assert!(
        timeout(Duration::from_millis(30), &mut promoting)
            .await
            .is_err(),
        "promotion must wait for the in-flight edit"
    );
    assert!(native
        .requests
        .lock()
        .unwrap()
        .iter()
        .all(|(method, _)| method != "thread/queue/delete"));
    release.send(()).unwrap();
    assert_eq!(
        timeout(Duration::from_secs(2), editing)
            .await
            .unwrap()
            .unwrap()
            .0,
        StatusCode::OK
    );
    let (status, promoted) = timeout(Duration::from_secs(2), promoting)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(status, StatusCode::OK, "{promoted}");
    assert_eq!(promoted["transfer"]["input"], edited);
    let calls = native.requests.lock().unwrap();
    let steer = calls
        .iter()
        .find(|(method, _)| method == "turn/steer")
        .unwrap();
    assert_eq!(steer.1["input"], edited);
    assert_eq!(
        calls
            .iter()
            .filter(|(method, _)| method == "thread/queue/update")
            .count(),
        1
    );
    assert_eq!(
        calls
            .iter()
            .filter(|(method, _)| method == "turn/steer")
            .count(),
        1
    );
}
