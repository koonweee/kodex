import Foundation
import Testing
@testable import KodexCore
import KodexAPI

@Test func generatedOpenAPIOperationsCoverLiveE2ERoutes() {
    let operations = Set(KodexAPIOperation.allCases.map(\.operationId))

    #expect(operations.contains("get_sidebar_threads"))
    #expect(operations.contains("get_thread"))
    #expect(operations.contains("submit_thread_input"))
    #expect(operations.contains("list_queued_inputs"))
    #expect(operations.contains("decide_approval"))
    #expect(operations.contains("read_account"))
    #expect(operations.contains("list_skills"))
    #expect(operations.contains("native_notification_status"))
}

@Test func generatedSwiftOpenAPIClientExposesRepresentativeOperations() {
    let generatedOperationIds = [
        Operations.get_sidebar_threads.id,
        Operations.get_thread.id,
        Operations.submit_thread_input.id,
        Operations.decide_approval.id,
        Operations.read_account.id,
        Operations.list_skills.id,
        Operations.native_notification_status.id
    ]

    #expect(generatedOperationIds == [
        "get_sidebar_threads",
        "get_thread",
        "submit_thread_input",
        "decide_approval",
        "read_account",
        "list_skills",
        "native_notification_status"
    ])
}

@Test func liveGatewayServiceLoadsWorkspaceFromSidebarSnapshot() async throws {
    let service = LiveGatewayService(client: stubClient { request in
        #expect(request.url.path == "/v1/sidebar/threads")
        return jsonResponse("""
        {
          "projects": [{"id":"project-1","name":"Kodex","cwd":"/repo","createdAt":"2026-05-28T00:00:00Z","updatedAt":"2026-05-28T00:00:00Z"}],
          "projectThreads": {"project-1":{"threads":[{"id":"thread-1","name":"Build iOS","cwd":"/repo","status":"active","createdAt":1,"updatedAt":2,"seenCompletedAgentTurnSeq":0,"unreadCompletedAgentTurn":true,"notificationsEnabled":true}]}},
          "chatThreads": {"threads":[{"id":"chat-1","name":"Pong","cwd":"/repo","status":"idle","createdAt":1,"updatedAt":2,"seenCompletedAgentTurnSeq":0,"unreadCompletedAgentTurn":false,"notificationsEnabled":true}]},
          "pinnedThreads": {"threads":[{"id":"pin-1","name":"Pinned","cwd":"/repo","status":"idle","createdAt":1,"updatedAt":2,"seenCompletedAgentTurnSeq":0,"unreadCompletedAgentTurn":true,"notificationsEnabled":false,"pinnedAt":"2026-05-28T00:00:00Z"}]}
        }
        """)
    })

    let workspace = try await service.loadWorkspace()

    #expect(workspace.projects.first?.name == "Kodex")
    #expect(workspace.projects.first?.threads.first?.id == "thread-1")
    #expect(workspace.projects.first?.threads.first?.status == .active)
    #expect(workspace.chats.first?.id == "chat-1")
    #expect(workspace.pinned.first?.notificationsEnabled == false)
}

@Test func liveGatewayServiceLoadsThreadDetailAndMapsCanonicalRows() async throws {
    let service = LiveGatewayService(client: stubClient { request in
        #expect(request.url.path == "/v1/threads/thread-1")
        return jsonResponse("""
        {
          "thread": {"id":"thread-1","name":"Build iOS","cwd":"/repo","status":"active","createdAt":1,"updatedAt":2,"seenCompletedAgentTurnSeq":0,"unreadCompletedAgentTurn":true,"notificationsEnabled":true},
          "liveState": "streaming",
          "timeline": {
            "viewRevision": 5,
            "liveState": "streaming",
            "pendingApprovalRequests": [],
            "pendingUserInputRequests": [],
            "turns": [],
            "rows": [
              {"id":"row-1","kind":"message","displayOrder":1,"status":"complete","items":[{"id":"item-1","threadId":"thread-1","turnId":"turn-1","itemId":"item-1","itemType":"message","status":"complete","displayOrder":1,"codexMethod":"item","payload":{"item":{"type":"userMessage","content":[{"text":"Say pong","type":"text"}]}}}],"fileChanges":[],"collapsedRows":[]},
              {"id":"row-2","kind":"work","displayOrder":2,"status":"running","items":[],"fileChanges":[],"collapsedRows":[],"work":{"title":"Kodex","summary":"Thinking"}},
              {"id":"row-3","kind":"assistant_message","displayOrder":3,"status":"complete","item":{"id":"item-2","threadId":"thread-1","turnId":"turn-1","itemId":"item-2","itemType":"agentMessage","status":"complete","displayOrder":2,"codexMethod":"item/completed","payload":{"item":{"type":"agentMessage","text":"pong"}}},"items":[],"fileChanges":[],"collapsedRows":[]}
            ]
          },
          "historyPage": {"olderCursor":"older-1","newerCursor":null,"hasOlder":true,"loadedTurnCount":2,"limit":50}
        }
        """)
    })

    let detail = try await service.loadThreadDetail(threadId: "thread-1")

    #expect(detail.thread.title == "Build iOS")
    #expect(detail.timeline.viewRevision == 5)
    #expect(detail.timeline.liveState == .streaming)
    #expect(detail.timeline.rows.map(\.kind) == [.message, .work, .message])
    #expect(detail.timeline.rows.first?.body == "Say pong")
    #expect(detail.timeline.rows.last?.body == "pong")
    #expect(detail.timeline.olderCursor == "older-1")
    #expect(detail.timeline.hasOlder == true)
}

@Test func liveGatewayServiceLoadsOlderTimelineWithCursor() async throws {
    let service = LiveGatewayService(client: stubClient { request in
        #expect(request.url.path == "/v1/threads/thread-1/timeline/pages")
        #expect(request.url.query?.contains("cursor=older-1") == true)
        return jsonResponse("""
        {
          "thread": {"id":"thread-1","name":"Build iOS","cwd":"/repo","status":"idle","createdAt":1,"updatedAt":2,"seenCompletedAgentTurnSeq":0,"unreadCompletedAgentTurn":false,"notificationsEnabled":true},
          "liveState": "idle",
          "timeline": {
            "viewRevision": 6,
            "liveState": "idle",
            "pendingApprovalRequests": [],
            "pendingUserInputRequests": [],
            "turns": [],
            "rows": [
              {"id":"row-0","kind":"message","displayOrder":0,"status":"complete","items":[{"id":"item-0","threadId":"thread-1","turnId":"turn-0","itemId":"item-0","itemType":"message","status":"complete","displayOrder":0,"codexMethod":"item","payload":{"role":"user","text":"Older"}}],"fileChanges":[],"collapsedRows":[]}
            ]
          },
          "historyPage": {"olderCursor":"older-2","newerCursor":null,"hasOlder":true,"loadedTurnCount":3,"limit":50}
        }
        """)
    })

    let page = try await service.loadOlderTimeline(threadId: "thread-1", cursor: "older-1")

    #expect(page.timeline.rows.map(\.id) == ["row-0"])
    #expect(page.timeline.olderCursor == "older-2")
    #expect(page.timeline.hasOlder == true)
}

@Test func liveGatewayServiceTreatsPresentAccountAsAuthenticatedWhenAuthFlagIsTrue() async throws {
    let service = LiveGatewayService(client: stubClient { request in
        #expect(request.url.path == "/v1/account")
        return jsonResponse("""
        {
          "requiresOpenaiAuth": true,
          "account": {"type":"chatgpt","email":"dev@example.test","planType":"pro"},
          "rawPayload": {}
        }
        """)
    })

    #expect(await service.loadAccount() == .authenticated(email: "dev@example.test"))
}

@Test func liveGatewayServiceRequiresAuthWhenNoAccountProfileIsPresent() async throws {
    let service = LiveGatewayService(client: stubClient { request in
        #expect(request.url.path == "/v1/account")
        return jsonResponse(#"{"requiresOpenaiAuth":true,"account":null,"rawPayload":{}}"#)
    })

    #expect(await service.loadAccount() == .requiresOpenAIAuth)
}

@Test func liveGatewayServiceBuildsComposerQueueApprovalAndThreadActionRequests() async throws {
    let seen = RequestRecorder()
    let service = LiveGatewayService(client: stubClient { request in
        let payload = request.body.flatMap { try? JSONDecoder().decode(AnySendable.self, from: $0) }
        await seen.append((request.url.path, request.method, payload))
        switch request.url.path {
        case "/v1/threads/thread-1/input":
            return jsonResponse(#"{"disposition":"started"}"#)
        case "/v1/threads/thread-1/queued-inputs":
            if request.method == .post {
                return jsonResponse(#"{"queuedInput":{"id":"queue-created","threadId":"thread-1","input":[],"options":{},"status":"queued","priority":"normal","attemptCount":0,"createdAt":"2026-05-28T00:00:00Z","updatedAt":"2026-05-28T00:00:00Z"}}"#)
            }
            return jsonResponse(#"{"queuedInputs":[{"id":"queue-1","threadId":"thread-1","input":[],"options":{},"status":"queued","priority":"normal","attemptCount":0,"createdAt":"2026-05-28T00:00:00Z","updatedAt":"2026-05-28T00:00:00Z"}]}"#)
        case "/v1/approvals/approval-1/decision":
            return jsonResponse(#"{"id":"approval-1","requestId":"req","method":"exec","status":"approved","payload":{},"createdAt":"2026-05-28T00:00:00Z"}"#)
        case "/v1/threads/thread-1/interrupt-current":
            return jsonResponse(#"{"disposition":"interrupted"}"#)
        case "/v1/threads/thread-1/name":
            return jsonResponse(#"{"threadId":"thread-1","name":"New name"}"#)
        default:
            return jsonResponse(#"{}"#)
        }
    })

    let disposition = try await service.submitTextInput(threadId: "thread-1", text: "Say pong")
    let skillRange = "Use $swift".range(of: "$swift")!
    _ = try await service.submitTextInput(
        threadId: "thread-1",
        text: "Use $swift",
        skillMentions: [SkillMention(name: "swift", path: "/skills/swift/SKILL.md", range: skillRange)],
        settings: ComposerRunSettings(model: "gpt-5.4-mini", effort: "medium", approvalPolicy: "on-request")
    )
    let queued = try await service.listQueuedInputs(threadId: "thread-1")
    let createdQueue = try await service.createQueuedInput(
        threadId: "thread-1",
        text: "Queue this",
        settings: ComposerRunSettings(model: "gpt-5.4-mini")
    )
    try await service.decideApproval(approvalId: "approval-1", decision: .accept)
    try await service.stopCurrentTurn(threadId: "thread-1")
    try await service.renameThread(threadId: "thread-1", name: "New name")
    let requests = await seen.values

    #expect(disposition == .started)
    #expect(queued.first?.id == "queue-1")
    #expect(createdQueue.id == "queue-created")
    #expect(requests.map(\.0).contains("/v1/threads/thread-1/input"))
    #expect(requests[1].2 == .object([
        "approvalPolicy": .string("on-request"),
        "effort": .string("medium"),
        "input": .array([
            .object(["text": .string("Use $swift"), "text_elements": .array([.object(["byteRange": .object(["start": .int(4), "end": .int(10)])])]), "type": .string("text")]),
            .object(["name": .string("swift"), "path": .string("/skills/swift/SKILL.md"), "type": .string("skill")])
        ]),
        "model": .string("gpt-5.4-mini")
    ]))
    #expect(requests[3].2 == .object([
        "input": .array([.object(["text": .string("Queue this"), "type": .string("text")])]),
        "model": .string("gpt-5.4-mini")
    ]))
    #expect(requests.map(\.0).contains("/v1/approvals/approval-1/decision"))
    #expect(requests.last?.2 == .object(["name": .string("New name")]))
}

@Test func liveGatewayServiceCoversNotificationStatusAndUnregisterRoutes() async throws {
    let seen = RequestRecorder()
    let service = LiveGatewayService(client: stubClient { request in
        await seen.append((request.url.path, request.method, nil))
        return jsonResponse(#"{"enabled":false,"providerConfigured":false,"devices":[]}"#)
    })

    try await service.loadNativeNotificationStatus()
    try await service.unregisterApnsDevice(deviceId: "device/one")
    let requests = await seen.values

    #expect(requests.map(\.0) == ["/v1/notifications/native/status", "/v1/notifications/apns/devices/device/one"])
    #expect(requests.map(\.1) == [.get, .delete])
}

@Test func liveGatewayServiceLoadsAndPersistsComposerSettings() async throws {
    let seen = RequestRecorder()
    let service = LiveGatewayService(client: stubClient { request in
        let payload = request.body.flatMap { try? JSONDecoder().decode(AnySendable.self, from: $0) }
        await seen.append((request.url.path, request.method, payload))
        switch request.method {
        case .get:
            return jsonResponse(#"{"model":"gpt-5.4","effort":"medium","serviceTier":null,"permissionsPreset":"autoReview"}"#)
        case .patch:
            return jsonResponse(#"{"saved":true}"#)
        default:
            return jsonResponse(#"{}"#)
        }
    })

    let settings = try await service.loadComposerSettings()
    try await service.persistComposerSettings(ComposerRunSettings(model: "gpt-5.4-mini", effort: "high", serviceTier: "priority"))
    let requests = await seen.values

    #expect(settings.settings.model == "gpt-5.4")
    #expect(settings.settings.effort == "medium")
    #expect(settings.permissionsPreset == "autoReview")
    #expect(requests.map(\.0) == ["/v1/composer-settings", "/v1/composer-settings"])
    #expect(requests.last?.2 == .object(["effort": .string("high"), "model": .string("gpt-5.4-mini"), "serviceTier": .string("priority")]))
}

@Test func liveGatewayServiceMapsApprovalPayloadContextAndRisk() async throws {
    let service = LiveGatewayService(client: stubClient { request in
        #expect(request.url.path == "/v1/approvals")
        return jsonResponse("""
        {
          "approvals": [{
            "id": "approval-1",
            "requestId": "req-1",
            "threadId": "thread-1",
            "turnId": "turn-1",
            "itemId": "item-1",
            "method": "item/commandExecution/requestApproval",
            "status": "pending",
            "payload": {"command":"rm -rf build","cwd":"/repo"},
            "response": null,
            "createdAt": "2026-05-28T00:00:00Z",
            "resolvedAt": null
          }]
        }
        """)
    })

    let approvals = try await service.listPendingApprovals(threadId: "thread-1")

    #expect(approvals.first?.title == "Command Approval")
    #expect(approvals.first?.risk == "high")
    #expect(approvals.first?.context.contains("rm -rf build") == true)
    #expect(approvals.first.map { ApprovalRiskPolicy.requiresConfirmation($0, decision: .accept) } == true)
}

@Test func selectedThreadStoreAppliesLivePatchAndRefreshRequired() async throws {
    let store = SelectedThreadProjection(
        detail: ThreadDetail(
            thread: WorkspaceThread(id: "thread-1", title: "Build iOS", cwd: "/repo"),
            timeline: ThreadTimeline(threadId: "thread-1", liveState: .idle, viewRevision: 1, rows: [])
        )
    )

    let patched = store.applying(.threadViewPatch(threadId: "thread-1", viewRevision: 4))
    let refresh = patched.applying(.refreshRequired(threadId: "thread-1"))

    #expect(patched.detail?.timeline.viewRevision == 4)
    #expect(patched.needsRefresh == false)
    #expect(refresh.needsRefresh == true)
}

@Test func liveE2ESkipReasonRequiresGatewayReadyAndAccount() async {
    let ready = LiveE2EReadiness(connection: .connected(baseURL: "http://127.0.0.1:8787"), account: .authenticated(email: "dev@example.test"))
    let authRequired = LiveE2EReadiness(connection: .connected(baseURL: "http://127.0.0.1:8787"), account: .requiresOpenAIAuth)
    let offline = LiveE2EReadiness(connection: .offline(message: "down"), account: .unknown)

    #expect(ready.skipReason == nil)
    #expect(authRequired.skipReason == "OpenAI auth is required before live iOS E2E can send prompts.")
    #expect(offline.skipReason == "Gateway offline: down")
}

private func stubClient(_ handler: @escaping @Sendable (GatewayRequest) async throws -> GatewayHTTPResponse) -> GatewayClient {
    GatewayClient(configuration: .simulatorDefault, send: handler)
}

private func jsonResponse(_ body: String) -> GatewayHTTPResponse {
    GatewayHTTPResponse(statusCode: 200, body: Data(body.utf8))
}

private actor RequestRecorder {
    private var recorded: [(String, GatewayHTTPMethod, AnySendable?)] = []

    var values: [(String, GatewayHTTPMethod, AnySendable?)] {
        recorded
    }

    func append(_ value: (String, GatewayHTTPMethod, AnySendable?)) {
        recorded.append(value)
    }
}
