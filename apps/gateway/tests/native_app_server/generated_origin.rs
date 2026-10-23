//! Synthetic local MCP transport probe for inline generated-card origin identity.
use super::fixture::{api, Fixture, ModelResponse, NativeSession};
use kodex_gateway::app_server_api::SortDirection;
use serde_json::{json, Value};
use std::collections::HashSet;
use tokio::time::{timeout, Duration};

#[tokio::test]
#[ignore = "requires explicit pinned real Codex executable and loopback access"]
async fn native_code_mode_generated_origin_metadata() -> anyhow::Result<()> {
    let mut fixture = Fixture::new().await?;
    let server = fixture.workspace.join("origin.py");
    std::fs::write(
        &server,
        r#"
import json, sys
for line in sys.stdin:
    r = json.loads(line)
    method = r.get('method')
    if method == 'initialize':
        result = {'protocolVersion':r['params']['protocolVersion'], 'capabilities':{'tools':{}}, 'serverInfo':{'name':'origin', 'version':'1'}}
    elif method == 'tools/list':
        result = {'tools':[{'name':'capture','description':'Capture synthetic origin metadata','annotations':{'readOnlyHint':True,'destructiveHint':False,'openWorldHint':False},'inputSchema':{'type':'object','properties':{'label':{'type':'string'}},'required':['label']}}]}
    elif method == 'tools/call':
        result = {'content':[{'type':'text','text':json.dumps(r['params'])}]}
    elif method == 'ping':
        result = {}
    else:
        continue
    print(json.dumps({'jsonrpc':'2.0','id':r['id'],'result':result}), flush=True)
"#,
    )?;
    let config_path = fixture.config.codex.home.join("config.toml");
    let config = std::fs::read_to_string(&config_path)?
        .replace("on-request", "never")
        .replace(
            "[features]\n",
            "[features]\ncode_mode = true\ncode_mode_only = true\ncode_mode_host = true\n",
        );
    std::fs::write(
        &config_path,
        format!(
            "{config}\n[mcp_servers.origin]\ncommand = \"/usr/bin/python3\"\nargs = [{}]\n",
            serde_json::to_string(&server.to_string_lossy())?
        ),
    )?;
    let mut session = NativeSession::start(&fixture).await?;
    let result = timeout(Duration::from_secs(60), async {
        let project = api(&session.app, "POST", "/v1/projects", Some(json!({"name":"Origin proof", "roots":[{"path":fixture.workspace}],"idempotencyKey":"origin-proof"}))).await?;
        let created = api(&session.app, "POST", "/v1/threads", Some(json!({"projectId":project["id"]}))).await?;
        let thread = created["thread"]["id"].as_str().unwrap();
        fixture.enqueue([
            ModelResponse::Items(vec![json!({"type":"custom_tool_call","call_id":"origin-code-mode-call","name":"exec","input":"const results = await Promise.all([tools.mcp__origin__capture({label:'A'}), tools.mcp__origin__capture({label:'B'})]); for (const result of results) text(result); text(await tools.mcp__origin__capture({label:'C'}));"})]),
            ModelResponse::message("Origin probe complete"),
        ]);
        api(&session.app, "POST", &format!("/v1/threads/{thread}/input"), Some(json!({"input":[{"type":"text","text":"Execute synthetic origin proof"}]}))).await?;
        fixture.next_model_request().await.map_err(|e|anyhow::anyhow!("first model request: {e}"))?;
        let next = fixture.next_model_request().await.map_err(|e|anyhow::anyhow!("second model request: {e}"))?;
        let output = next["input"].as_array().unwrap().iter().find(|item|item["call_id"]=="origin-code-mode-call" && item["type"]=="custom_tool_call_output").unwrap();
        let captures = output["output"].as_array().unwrap().iter()
            .filter_map(|block| serde_json::from_str::<Value>(block["text"].as_str()?).ok())
            .map(|result| serde_json::from_str::<Value>(result["content"][0]["text"].as_str().unwrap()))
            .collect::<Result<Vec<_>,_>>()?;
        anyhow::ensure!(captures.len()==3, "expected all concurrent/repeated calls");
        let turn = session.completed_turn(thread,"completed").await?;
        let page = session.native_items_page(thread,None,None,SortDirection::Asc,50).await?;
        let enclosing = next["input"].as_array().unwrap().iter()
            .find(|item|item["type"]=="custom_tool_call" && item["call_id"]=="origin-code-mode-call")
            .ok_or_else(||anyhow::anyhow!("missing enclosing Code Mode call"))?;
        let enclosing_id = enclosing["id"].as_str().ok_or_else(||anyhow::anyhow!("missing enclosing string ID"))?;
        let mut calls = HashSet::new();
        let mut labels = HashSet::new();
        for capture in captures {
            let meta = &capture["_meta"];
            anyhow::ensure!(meta["threadId"] == thread);
            anyhow::ensure!(meta["x-codex-turn-metadata"]["thread_id"] == thread);
            anyhow::ensure!(meta["x-codex-turn-metadata"]["turn_id"] == turn["id"]);
            anyhow::ensure!(meta["itemId"] == enclosing_id, "wrong enclosing Code Mode item");
            labels.insert(capture["arguments"]["label"].as_str().unwrap().to_owned());
            let call = meta["callId"].as_str().unwrap();
            anyhow::ensure!(calls.insert(call.to_owned()), "call identity repeated");
            anyhow::ensure!(meta["itemId"] != call, "probe must distinguish enclosing Code Mode item");
            let item = page.data.iter().find(|entry|entry.item.id==call)
                .ok_or_else(||anyhow::anyhow!("MCP call missing from persisted native page: {call}"))?;
            anyhow::ensure!(item.turn_id == turn["id"].as_str().unwrap());
            anyhow::ensure!(item.item.raw_payload["arguments"] == capture["arguments"]);
            anyhow::ensure!(item.item.item_type == "mcpToolCall");
            anyhow::ensure!(item.item.raw_payload["server"] == "origin");
            anyhow::ensure!(item.item.raw_payload["tool"] == "capture");
        }
        anyhow::ensure!(labels == HashSet::from(["A".into(),"B".into(),"C".into()]));
        Ok::<_,anyhow::Error>(())
    }).await;
    session.shutdown().await?;
    result??;
    Ok(())
}

#[tokio::test]
#[ignore = "requires explicit pinned real Codex executable and loopback access"]
async fn native_generated_cards_create_inline_and_survive_reopen() -> anyhow::Result<()> {
    let mut fixture = Fixture::new().await?;
    let config_path = fixture.config.codex.home.join("config.toml");
    let config = std::fs::read_to_string(&config_path)?.replace(
        "[features]\n",
        "[features]\ncode_mode = true\ncode_mode_only = true\ncode_mode_host = true\n",
    );
    std::fs::write(config_path, config)?;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let mut session = NativeSession::start_with_control(&fixture, address).await?;
    let app = session.app.clone();
    let serving = tokio::spawn(async move { axum::serve(listener, app).await });
    let result = timeout(Duration::from_secs(60), async {
        let project = api(&session.app,"POST","/v1/projects",Some(json!({"name":"Inline cards", "roots":[{"path":fixture.workspace}],"idempotencyKey":"inline"}))).await?;
        let created = api(&session.app,"POST","/v1/threads",Some(json!({"projectId":project["id"]}))).await?;
        let thread = created["thread"]["id"].as_str().unwrap().to_owned();
        let target = api(&session.app,"POST","/v1/threads",Some(json!({"projectId":project["id"]}))).await?;
        let args = |title:&str| json!({"threadId":thread,"title":title,"html":format!("<main>{title}</main>"),"fallbackContent":title,"grants":{"canSendMessage":true}});
        let mut foreign = args("Foreign"); foreign["threadId"] = target["thread"]["id"].clone();
        let code = format!("for (const args of [{},{},{}]) text(await tools.mcp__kodex_control__create_app_surface(args));",args("First"),args("Revised"),foreign);
        let (final_response,release) = ModelResponse::gated_message("Cards ready");
        fixture.enqueue([ModelResponse::Items(vec![json!({"type":"custom_tool_call","call_id":"generate-cards","name":"exec","input":code})]),final_response]);
        api(&session.app,"POST",&format!("/v1/threads/{thread}/input"),Some(json!({"input":[{"type":"text","text":"Create inline cards"}]}))).await?;
        fixture.next_model_request().await?;
        let next = loop {
            tokio::select! {
                next = fixture.next_model_request() => break next?,
                request = session.next_server_request() => {
                    let (_,method) = request?;
                    let approvals = api(&session.app,"GET",&format!("/v1/approvals?threadId={thread}"),None).await?;
                    let approval = approvals["approvals"].as_array().unwrap().iter().find(|a|a["status"]=="pending").unwrap();
                    let decision = if method == "mcpServer/elicitation/request" { json!({"action":"accept","content":{}}) } else { json!({"decision":"accept"}) };
                    api(&session.app,"POST",&format!("/v1/approvals/{}/decision",approval["id"].as_str().unwrap()),Some(json!({"decision":decision}))).await?;
                }
            }
        };
        let output = next["input"].as_array().unwrap().iter().find(|item|item["call_id"]=="generate-cards" && item["type"]=="custom_tool_call_output").unwrap();
        let cards = session.state.store.generated_apps(&thread).await?;
        anyhow::ensure!(cards.len()==2,"creation failed: {output}");
        anyhow::ensure!(session.state.store.generated_apps(target["thread"]["id"].as_str().unwrap()).await?.is_empty());
        let view = session.canonical_view(&thread).await?;
        anyhow::ensure!(view["activeTurnId"].is_string(),"cards must arrive before final completion");
        let inline = view["rows"].as_array().unwrap().iter().filter(|row|row["kind"]=="generated_app").collect::<Vec<_>>();
        anyhow::ensure!(inline.len()==2,"cards hidden or absent: {view}");
        anyhow::ensure!(inline[0]["item"]["payload"]["item"]["generatedApp"]["id"]==cards[0].card.id);
        let first = session.state.store.get_app_surface_session(&cards[0].card.id).await?;
        release.send(()).unwrap();
        session.completed_turn(&thread,"completed").await?;
        let final_view = session.canonical_view(&thread).await?;
        anyhow::ensure!(final_view["rows"].as_array().unwrap().iter().filter(|row|row["kind"]=="generated_app").count()==2,"completion hid inline cards");
        anyhow::ensure!(api(&session.app,"GET",&format!("/v1/threads/{thread}/app-surface"),None).await?["session"].is_null());
        Ok::<_,anyhow::Error>((thread,first))
    }).await;
    serving.abort();
    let _ = serving.await;
    session.shutdown().await?;
    let (thread, first) = result??;
    let reopened = NativeSession::start(&fixture).await?;
    let result = async {
        let detail = api(&reopened.app,"GET",&format!("/v1/threads/{thread}"),None).await?;
        anyhow::ensure!(detail["timeline"]["rows"].as_array().unwrap().iter().filter(|row|row["kind"]=="generated_app").count()==2);
        let read = api(&reopened.app,"GET",&format!("/v1/app-surfaces/{}",first.id),None).await?;
        anyhow::ensure!(read["session"]["bridgeToken"]==first.bridge_token);
        let ping = api(&reopened.app,"POST",&format!("/v1/app-surfaces/{}/bridge",first.id),Some(json!({"id":1,"revision":1,"bridgeToken":first.bridge_token,"method":"ping","params":{}}))).await?;
        anyhow::ensure!(ping["error"].is_null(),"old card bridge failed: {ping}");
        Ok::<_,anyhow::Error>(())
    }.await;
    reopened.shutdown().await?;
    result
}
