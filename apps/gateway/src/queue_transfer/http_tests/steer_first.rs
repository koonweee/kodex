use super::*;

async fn steer_first(state: &AppState) -> (StatusCode, Value) {
    let response = build_router(state.clone())
        .oneshot(
            Request::post(format!("{BASE}/steer-first"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

#[tokio::test]
async fn native_http_steer_first_waits_for_other_clients_reorder_and_refills_both() {
    let (state, native) = state().await;
    let a = create(&state).await;
    let b = create(&state).await;
    let other = state.clone();
    let cursor = state.store.latest_event_seq().await.unwrap();
    let mut first_stream = stream(&state, cursor).await;
    let mut other_stream = stream(&other, cursor).await;
    let (started, waiting) = oneshot::channel();
    let (release, held) = oneshot::channel();
    *native.reorder_gate.lock().unwrap() = Some((started, held));
    let reordering_state = other.clone();
    let reorder_body = json!({"queuedSubmissionIds":[b["id"],a["id"]]});
    let reordering = tokio::spawn(async move {
        request(
            &reordering_state,
            "POST",
            &format!("{BASE}/reorder"),
            reorder_body,
        )
        .await
    });
    timeout(Duration::from_secs(2), waiting)
        .await
        .unwrap()
        .unwrap();
    native.requests.lock().unwrap().clear();
    let steering_state = state.clone();
    let mut steering = tokio::spawn(async move { steer_first(&steering_state).await });
    assert!(timeout(Duration::from_millis(30), &mut steering)
        .await
        .is_err());
    assert!(
        native.requests.lock().unwrap().is_empty(),
        "selection must wait for reorder's lock"
    );
    release.send(()).unwrap();
    assert_eq!(reordering.await.unwrap().0, StatusCode::OK);
    let (status, outcome) = timeout(Duration::from_secs(2), steering)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(status, StatusCode::OK, "{outcome}");
    assert_eq!(outcome["transfer"]["nativeQueueId"], b["id"]);
    assert_eq!(outcome["transfer"]["phase"], "accepted");
    marker(&mut first_stream, "turn_queue.transfer_changed").await;
    marker(&mut other_stream, "turn_queue.transfer_changed").await;
    let (_, listed) = request(&other, "GET", BASE, Value::Null).await;
    assert_eq!(listed["queuedInputs"].as_array().unwrap().len(), 1);
    assert_eq!(listed["queuedInputs"][0]["id"], a["id"]);
    assert_eq!(listed["transfers"][0]["id"], outcome["transfer"]["id"]);
    let calls = native.requests.lock().unwrap();
    let deletes = calls
        .iter()
        .filter(|(method, _)| method == "thread/queue/delete")
        .collect::<Vec<_>>();
    assert_eq!(deletes.len(), 1);
    assert_eq!(deletes[0].1["queuedSubmissionId"], b["id"]);
    assert_eq!(
        calls
            .iter()
            .filter(|(method, _)| method == "turn/steer")
            .count(),
        1
    );
    assert!(calls
        .iter()
        .all(|(method, _)| method != "turn/start" && method != "thread/resume"));
}

#[tokio::test]
async fn native_http_steer_first_empty_queue_conflicts_without_native_mutations() {
    let (state, native) = state().await;
    let (status, body) = steer_first(&state).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert!(native
        .requests
        .lock()
        .unwrap()
        .iter()
        .all(|(method, _)| matches!(
            method.as_str(),
            "thread/read" | "thread/turns/list" | "thread/queue/list"
        )));
    assert!(state
        .store
        .list_queue_transfers(None)
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn native_http_steer_first_uses_the_native_front_even_without_enqueue_context() {
    let (state, native) = state().await;
    let later = create(&state).await;
    native
        .rows
        .lock()
        .unwrap()
        .insert(0, row("native-from-previous-turn"));
    native.requests.lock().unwrap().clear();
    let (status, body) = steer_first(&state).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body["transfer"]["nativeQueueId"],
        "native-from-previous-turn"
    );
    assert_eq!(body["transfer"]["phase"], "accepted");
    let (_, listed) = request(&state, "GET", BASE, Value::Null).await;
    assert_eq!(listed["queuedInputs"].as_array().unwrap().len(), 1);
    assert_eq!(listed["queuedInputs"][0]["id"], later["id"]);
    assert_eq!(listed["queuedInputs"][0]["canSteer"], true);
}

#[tokio::test]
async fn native_http_steer_first_returns_unresolved_front_without_skipping_or_writing() {
    let (state, native) = state().await;
    let front = create(&state).await;
    let later = create(&state).await;
    let saved = state
        .store
        .create_queue_transfer(
            THREAD,
            front["id"].as_str().unwrap(),
            "reused-client",
            TURN,
            vec![],
        )
        .await
        .unwrap();
    let before = native.rows.lock().unwrap().clone();
    let (status, body) = steer_first(&state).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["transfer"]["id"], saved.id);
    assert_eq!(*native.rows.lock().unwrap(), before);
    let (_, listed) = request(&state, "GET", BASE, Value::Null).await;
    assert_eq!(listed["queuedInputs"][0]["canSteer"], false);
    assert_eq!(listed["queuedInputs"][1]["id"], later["id"]);
    assert_eq!(listed["queuedInputs"][1]["canSteer"], true);
    let calls = native.requests.lock().unwrap();
    assert!(calls.iter().all(|(method, _)| matches!(
        method.as_str(),
        "thread/queue/add" | "thread/queue/list" | "thread/read" | "thread/turns/list"
    )));
}
