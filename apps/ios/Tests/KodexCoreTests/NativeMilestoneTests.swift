import Foundation
import Testing
@testable import KodexCore

@Test func workspaceTitleDisplayUsesNameThenPreviewThenUntitledFallback() {
    #expect(WorkspaceNormalizer.title(name: "Plan Review", preview: "ignored", id: "abcdef123") == "Plan Review")
    #expect(WorkspaceNormalizer.title(name: nil, preview: "Investigate deploy action failure", id: "abcdef123") == "Investigate deploy action failure")
    #expect(WorkspaceNormalizer.title(name: " ", preview: " \n", id: "abcdef123") == "Untitled Thread")
}

@Test func workspaceFixtureCoversConnectedDegradedAndOfflineStates() {
    let connected = FixtureStore.state(for: .connected)
    let degraded = FixtureStore.state(for: .degraded)
    let offline = FixtureStore.state(for: .offline)

    #expect(connected.workspace.firstThread?.id == "fixture-thread")
    #expect(degraded.connection == .degraded(message: "app-server unavailable"))
    #expect(offline.workspace.firstThread == nil)
    #expect(offline.connection == .offline(message: "Could not reach http://127.0.0.1:8787"))
}

@Test func workspaceThreadStatusProjectsGatewayLiveState() {
    let projectThread = WorkspaceThread(id: "thread-1", title: "Project thread", cwd: "/repo", status: .active)
    let chatThread = WorkspaceThread(id: "thread-2", title: "Chat thread", cwd: "/repo", status: .idle)
    let pinnedThread = WorkspaceThread(id: "thread-1", title: "Pinned thread", cwd: "/repo", status: .active, pinned: true)
    let workspace = WorkspaceSnapshot(
        projects: [WorkspaceProject(id: "project-1", name: "Project", path: "/repo", threads: [projectThread])],
        chats: [chatThread],
        pinned: [pinnedThread]
    )

    let idleWorkspace = workspace.replacingThreadStatus(threadId: "thread-1", liveState: .idle)
    let activeWorkspace = idleWorkspace.replacingThreadStatus(threadId: "thread-1", liveState: .streaming)

    #expect(ThreadStatus(liveState: .idle) == .idle)
    #expect(ThreadStatus(liveState: .streaming) == .active)
    #expect(ThreadStatus(liveState: .syncing) == .active)
    #expect(ThreadStatus(liveState: .notLoaded) == .notLoaded)
    #expect(idleWorkspace.projects.first?.threads.first?.status == .idle)
    #expect(idleWorkspace.pinned.first?.status == .idle)
    #expect(idleWorkspace.chats.first?.status == .idle)
    #expect(activeWorkspace.projects.first?.threads.first?.status == .active)
    #expect(activeWorkspace.pinned.first?.status == .active)
}

@Test func timelineRowMappingCoversNativeRowFamilies() {
    #expect(TimelineRowKind(gatewayKind: "message", status: "complete") == .message)
    #expect(TimelineRowKind(gatewayKind: "work", status: "running") == .work)
    #expect(TimelineRowKind(gatewayKind: "tool_call", status: "complete") == .tool)
    #expect(TimelineRowKind(gatewayKind: "anything", status: "complete", hasFileChanges: true) == .fileChange)
    #expect(TimelineRowKind(gatewayKind: "image", status: "complete", itemType: "image") == .image)
    #expect(TimelineRowKind(gatewayKind: "warning", status: "complete") == .warning)
    #expect(TimelineRowKind(gatewayKind: "message", status: "system_error") == .error)
}

@Test func olderHistoryMergePrependsWithoutDuplicates() {
    let current = [
        TimelineRow(id: "row-2", kind: .message, displayOrder: 2, title: "Current", body: "current")
    ]
    let older = [
        TimelineRow(id: "row-1", kind: .message, displayOrder: 1, title: "Older", body: "older"),
        TimelineRow(id: "row-2", kind: .message, displayOrder: 2, title: "Duplicate", body: "duplicate")
    ]

    let merged = WorkspaceNormalizer.mergeOlderHistory(current: current, older: older)

    #expect(merged.map(\.id) == ["row-1", "row-2"])
}

@Test func timelineCarriesOlderHistoryCursor() {
    let timeline = ThreadTimeline(
        threadId: "thread-1",
        liveState: .idle,
        viewRevision: 1,
        rows: [],
        olderCursor: "older-1",
        hasOlder: true
    )

    #expect(timeline.olderCursor == "older-1")
    #expect(timeline.hasOlder == true)
}

@Test func composerPayloadBuildsSkillMentionByteRangesAndLocalImages() {
    let text = "Use $swift to inspect café"
    let range = text.range(of: "$swift")!
    let mention = SkillMention(name: "swift", path: "/skills/swift/SKILL.md", range: range)

    let payload = ComposerPayloadBuilder.turnStartPayload(
        text: text,
        skillMentions: [mention],
        localImagePaths: ["/tmp/uploaded.png"]
    )

    let expectedRange = ByteRange(start: 4, end: 10)
    #expect(ComposerPayloadBuilder.byteRange(for: range, in: text) == expectedRange)

    guard case .object(let root) = payload, case .array(let input)? = root["input"] else {
        Issue.record("Expected object payload with input array")
        return
    }

    #expect(input.count == 3)
    #expect(input[1] == .object(["type": .string("skill"), "name": .string("swift"), "path": .string("/skills/swift/SKILL.md")]))
    #expect(input[2] == .object(["type": .string("localImage"), "path": .string("/tmp/uploaded.png")]))
}

@Test func composerPayloadCarriesNativeRunSettingsAndDetectedSkillMentions() {
    let text = "Use $swift, then ignore $swiftish"
    let mentions = SkillMentionDetector.mentions(in: text, skills: [
        SkillCatalogEntry(name: "swift", path: "/skills/swift/SKILL.md")
    ])
    let payload = ComposerPayloadBuilder.turnStartPayload(
        text: text,
        skillMentions: mentions,
        settings: ComposerRunSettings(
            model: "gpt-5.4-mini",
            effort: "high",
            approvalPolicy: "on-request",
            sandboxPolicy: .object(["type": .string("readOnly")])
        )
    )

    #expect(mentions.count == 1)
    guard case .object(let root) = payload, case .array(let input)? = root["input"] else {
        Issue.record("Expected object payload with input array")
        return
    }

    #expect(root["model"] == .string("gpt-5.4-mini"))
    #expect(root["effort"] == .string("high"))
    #expect(root["approvalPolicy"] == .string("on-request"))
    #expect(root["sandboxPolicy"] == .object(["type": .string("readOnly")]))
    #expect(input[1] == .object(["type": .string("skill"), "name": .string("swift"), "path": .string("/skills/swift/SKILL.md")]))
}

@Test func uploadAndInputRoutesMapComposerOperations() {
    #expect(UploadRouteMapper.routeForImageUpload() == .imageUploads)
    #expect(UploadRouteMapper.input(forUploadedLocalPath: "/tmp/kodex-image.png") == .localImage(path: "/tmp/kodex-image.png"))
    #expect(GatewayConfiguration.simulatorDefault.endpoint(.threadInput("t1")).path == "/v1/threads/t1/input")
    #expect(GatewayConfiguration.simulatorDefault.endpoint(.queuedInputRetry(threadId: "t1", queueId: "q1")).path == "/v1/threads/t1/queued-inputs/q1/retry")
}

@Test func approvalDecisionPayloadsUseGatewayDecisionEnvelope() {
    #expect(ApprovalDecisionPayloadBuilder.route(approvalId: "a1") == .approvalDecision("a1"))
    #expect(ApprovalDecisionPayloadBuilder.payload(for: .accept) == .object(["decision": .object(["decision": .string("accept")])]))
    #expect(ApprovalDecisionPayloadBuilder.payload(for: .decline) == .object(["decision": .object(["decision": .string("decline")])]))
    #expect(ApprovalDecisionPayloadBuilder.payload(for: .acceptForSession) == .object(["decision": .object(["decision": .string("acceptForSession")])]))
    #expect(ApprovalDecisionPayloadBuilder.payload(for: .cancel) == .object(["decision": .object(["decision": .string("cancel")])]))
}

@Test func approvalRiskPolicyConfirmsRiskyAcceptsOnly() {
    let medium = ApprovalRequest(id: "a1", threadId: "t1", title: "Run tests", risk: "medium")
    let destructiveTitle = ApprovalRequest(id: "a2", threadId: "t1", title: "rm -rf build", risk: "low")
    let low = ApprovalRequest(id: "a3", threadId: "t1", title: "Read file", risk: "low")

    #expect(ApprovalRiskPolicy.requiresConfirmation(medium, decision: .accept))
    #expect(ApprovalRiskPolicy.requiresConfirmation(destructiveTitle, decision: .accept))
    #expect(!ApprovalRiskPolicy.requiresConfirmation(medium, decision: .decline))
    #expect(!ApprovalRiskPolicy.requiresConfirmation(low, decision: .accept))
}

@Test func nativeNotificationPayloadParsesBadgeAndThreadRouting() throws {
    let data = Data(#"{"aps":{"badge":1},"threadId":"fixture-thread"}"#.utf8)
    let intent = try NativeNotificationParser.parseAPNSFixture(data)

    #expect(intent == .unreadAgentMessage(threadId: "fixture-thread"))
    #expect(intent.badgeDelta == 1)
    #expect(intent.routeThreadId == "fixture-thread")
    #expect(NativeNotificationParser.parse(userInfo: ["kind": "test"]) == .test)
}

@Test func nativeNotificationRoutesAndRegistrationUseApnsGatewaySurface() {
    let baseURL = GatewayConfiguration.simulatorDefault
    let intent = NativeNotificationRegistrationIntent(
        deviceToken: "abc123",
        bundleId: "dev.kodex.KodexIOS",
        environment: "sandbox",
        deviceName: "iPhone 17 Pro"
    )

    #expect(baseURL.endpoint(.nativeNotificationStatus).path == "/v1/notifications/native/status")
    #expect(baseURL.endpoint(intent.route).path == "/v1/notifications/apns/devices")
    #expect(baseURL.endpoint(.apnsDeviceDelete("device/one")).absoluteString.contains("/v1/notifications/apns/devices/device%2Fone"))
    #expect(baseURL.endpoint(.apnsTestNotification).path == "/v1/notifications/apns/test")
    #expect(intent.registration.route == .apnsDeviceRegister)
}

@Test func nativeNotificationRegistrarPostsApnsTokenToGateway() async {
    let intent = NativeNotificationRegistrationIntent(
        deviceToken: "abc123",
        bundleId: "dev.kodex.KodexIOS",
        environment: "sandbox",
        deviceName: "iPhone 17 Pro"
    )
    let client = GatewayClient(configuration: .simulatorDefault) { request in
        #expect(request.method == .post)
        #expect(request.url.path == "/v1/notifications/apns/devices")
        #expect(request.headers["Content-Type"] == "application/json")
        let decoded = try JSONDecoder().decode(ApnsDeviceRegistration.self, from: request.body ?? Data())
        #expect(decoded == intent.registration)
        return GatewayHTTPResponse(statusCode: 200, body: Data(#"{"registered":true}"#.utf8))
    }

    let result = await NativeNotificationGatewayRegistrar(client: client).upload(intent)

    #expect(result == .success(Data(#"{"registered":true}"#.utf8)))
}

@Test func gatewayLiveEventDecoderConsumesCanonicalGatewayEvents() throws {
    let decoder = GatewayLiveEventDecoder()
    let refresh = try decoder.decode(Data(#"{"kind":"thread_view.refresh_required","payload":{"threadId":"t1"}}"#.utf8))
    let read = try decoder.decode(Data(#"{"kind":"thread.read_updated","payload":{"threadId":"t1"}}"#.utf8))
    let pin = try decoder.decode(Data(#"{"kind":"thread.pin_updated","payload":{"threadId":"t1"}}"#.utf8))
    let notifications = try decoder.decode(Data(#"{"kind":"thread.notifications_updated","payload":{"threadId":"t1"}}"#.utf8))
    let upserted = try decoder.decode(Data(#"{"kind":"thread.upserted","payload":{"thread":{"id":"t1"}}}"#.utf8))
    let metadata = try decoder.decode(Data(#"{"kind":"timeline.thread_metadata","payload":{"threadId":"t1","thread":{"id":"t1"}}}"#.utf8))
    let approval = try decoder.decode(Data(#"{"kind":"approval.updated","payload":{"threadId":"t1","approvalId":"a1"}}"#.utf8))
    let unknown = try decoder.decode(Data(#"{"kind":"future.event","payload":{}}"#.utf8))

    #expect(refresh == .refreshRequired(threadId: "t1"))
    #expect(read == .threadReadUpdated(threadId: "t1"))
    #expect(pin == .threadPinUpdated(threadId: "t1"))
    #expect(notifications == .threadNotificationsUpdated(threadId: "t1"))
    #expect(upserted == .threadUpserted(threadId: "t1"))
    #expect(metadata == .threadMetadataUpdated(threadId: "t1"))
    #expect(approval == .approvalUpdated(threadId: "t1"))
    #expect(unknown == .unknown(kind: "future.event"))
}

@Test func gatewayEventStreamBuildsSelectedThreadURL() throws {
    let stream = GatewayEventStream(configuration: .simulatorDefault, cursor: 42, threadId: "thread-1", excludeThreadId: "thread-2")
    let url = stream.configuration.endpoint(.events(cursor: stream.cursor, projectId: nil, threadId: stream.threadId, excludeThreadId: stream.excludeThreadId))

    #expect(url.absoluteString == "http://127.0.0.1:8787/v1/events?cursor=42&threadId=thread-1&excludeThreadId=thread-2")
}

@Test func gatewaySSELineParserDispatchesMultilineFramesOnBlankLines() throws {
    var parser = GatewaySSELineParser()

    #expect(try parser.consume("event: thread.read_updated") == nil)
    #expect(try parser.consume(#"data: {"seq":7,"kind":"thread.read_updated","#) == nil)
    #expect(try parser.consume(#"data: "payload":{"threadId":"t1"}}"#) == nil)
    let envelope = try parser.consume("")

    #expect(envelope == GatewayLiveEnvelope(seq: 7, event: .threadReadUpdated(threadId: "t1")))
}

@Test func gatewaySSELineParserClearsMalformedFramesBeforeNextEvent() throws {
    var parser = GatewaySSELineParser()

    #expect(try parser.consume("data: {not-json") == nil)
    #expect(throws: (any Error).self) {
        _ = try parser.consume("")
    }
    #expect(try parser.consume(#"data: {"seq":8,"kind":"thread.pin_updated","payload":{"threadId":"t1"}}"#) == nil)
    let envelope = try parser.consume("")

    #expect(envelope == GatewayLiveEnvelope(seq: 8, event: .threadPinUpdated(threadId: "t1")))
}

@Test func gatewayEventStreamResponseValidatorRejectsNonSuccessResponses() throws {
    let url = URL(string: "http://127.0.0.1:8787/v1/events")!
    let ok = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!
    let unavailable = HTTPURLResponse(url: url, statusCode: 503, httpVersion: nil, headerFields: nil)!

    try GatewayEventStreamResponseValidator.validate(ok)
    #expect(throws: GatewayClientError.gateway(statusCode: 503, message: "Live event stream failed.")) {
        try GatewayEventStreamResponseValidator.validate(unavailable)
    }
}

@Test func gatewayLiveEventDecoderConsumesQueueEvents() throws {
    let decoder = GatewayLiveEventDecoder()
    let upsertData = Data(#"{"seq":44,"kind":"turn_queue.item_upsert","payload":{"threadId":"t1","id":"q1"}}"#.utf8)
    let upsert = try decoder.decode(upsertData)
    let upsertEnvelope = try decoder.decodeEnvelope(upsertData)
    let deleted = try decoder.decode(Data(#"{"kind":"turn_queue.item_deleted","payload":{"threadId":"t1","id":"q1"}}"#.utf8))

    #expect(upsert == .queuedInputUpdated(threadId: "t1"))
    #expect(upsertEnvelope == GatewayLiveEnvelope(seq: 44, event: .queuedInputUpdated(threadId: "t1")))
    #expect(deleted == .queuedInputUpdated(threadId: "t1"))
}

@Test func gatewayLiveEventDecoderConsumesThreadViewPatchPayloads() throws {
    let decoder = GatewayLiveEventDecoder()
    let data = Data("""
    {
      "seq": 45,
      "kind": "thread_view.patch",
      "payload": {
        "threadId": "t1",
        "viewRevision": 8,
        "scope": "turn",
        "liveState": "streaming",
        "activeTurnId": "turn-1",
        "affectedTurnIds": ["turn-1"],
        "rows": [
          {
            "id": "row-user",
            "kind": "user_message",
            "displayOrder": 9,
            "status": "completed",
            "turnId": "turn-1",
            "item": {
              "id": "projection-item-0",
              "threadId": "t1",
              "turnId": "turn-1",
              "itemId": "item-0",
              "itemType": "userMessage",
              "status": "completed",
              "displayOrder": 9,
              "codexMethod": "item/completed",
              "payload": {
                "item": {
                  "id": "item-0",
                  "type": "userMessage",
                  "content": [{"text": "Say pong", "type": "text"}]
                }
              }
            },
            "items": [],
            "fileChanges": [],
            "collapsedRows": []
          },
          {
            "id": "row-agent",
            "kind": "message",
            "displayOrder": 10,
            "status": "streaming",
            "turnId": "turn-1",
            "items": [
              {
                "id": "item-1",
                "threadId": "t1",
                "turnId": "turn-1",
                "itemId": "item-1",
                "itemType": "assistant_message",
                "status": "streaming",
                "displayOrder": 10,
                "codexMethod": "item/assistantmessage/delta",
                "payload": {
                  "item": {"role": "assistant", "text": "partial assistant text"}
                }
              }
            ],
            "fileChanges": [],
            "collapsedRows": []
          }
        ]
      }
    }
    """.utf8)

    let envelope = try decoder.decodeEnvelope(data)

    guard case .threadViewPatch(let patch) = envelope.event else {
        Issue.record("Expected decoded thread view patch")
        return
    }
    #expect(envelope.seq == 45)
    #expect(patch.threadId == "t1")
    #expect(patch.viewRevision == 8)
    #expect(patch.scope == .turn)
    #expect(patch.liveState == .streaming)
    #expect(patch.activeTurnId == "turn-1")
    #expect(patch.affectedTurnIds == ["turn-1"])
    #expect(patch.rows?.map(\.id) == ["row-user", "row-agent"])
    #expect(patch.rows?.first?.turnId == "turn-1")
    #expect(patch.rows?.first?.speaker == .user)
    #expect(patch.rows?.first?.body == "Say pong")
    #expect(patch.rows?.last?.speaker == .assistant)
    #expect(patch.rows?.last?.body == "partial assistant text")
    #expect(GatewayEventScope.selected(threadId: "t1").accepts(threadId: envelope.event.threadId))
}

@Test func threadTimelineAppliesCanonicalTurnPatchesAndPreservesHistoryWindow() {
    let timeline = ThreadTimeline(
        threadId: "t1",
        liveState: .streaming,
        viewRevision: 4,
        rows: [
            TimelineRow(id: "old-row", kind: .message, speaker: .assistant, displayOrder: 9, title: "Kodex", body: "old", turnId: "turn-1"),
            TimelineRow(id: "row-user", kind: .message, speaker: .user, displayOrder: 8, title: "You", body: "hello", turnId: "turn-1")
        ],
        olderCursor: "older-1",
        hasOlder: true
    )
    let patch = GatewayThreadViewPatch(
        threadId: "t1",
        viewRevision: 5,
        scope: .turn,
        liveState: .streaming,
        activeTurnId: "turn-1",
        rows: [
            TimelineRow(id: "row-agent", kind: .message, speaker: .assistant, displayOrder: 10, title: "Kodex", body: "new text", status: "streaming", turnId: "turn-1")
        ],
        affectedTurnIds: ["turn-1"]
    )

    let result = timeline.applying(patch)

    guard case .applied(let updated) = result else {
        Issue.record("Expected applied timeline patch")
        return
    }
    #expect(updated.viewRevision == 5)
    #expect(updated.liveState == .streaming)
    #expect(updated.rows.map(\.id) == ["row-agent"])
    #expect(updated.rows.last?.body == "new text")
    #expect(updated.olderCursor == "older-1")
    #expect(updated.hasOlder)
}

@Test func threadTimelineHandlesSnapshotLifecycleStaleAndInvalidPatches() {
    let timeline = ThreadTimeline(
        threadId: "t1",
        liveState: .streaming,
        viewRevision: 4,
        rows: [TimelineRow(id: "row-1", kind: .message, displayOrder: 1, title: "Kodex", body: "old")],
        olderCursor: "older-1",
        hasOlder: true
    )

    let stale = GatewayThreadViewPatch(threadId: "t1", viewRevision: 4, scope: .turn, liveState: .streaming, rows: [
        TimelineRow(id: "row-1", kind: .message, displayOrder: 1, title: "Kodex", body: "stale")
    ], affectedTurnIds: ["turn-1"])
    let lifecycle = GatewayThreadViewPatch(threadId: "t1", viewRevision: 5, scope: .lifecycle, liveState: .idle)
    let fullSnapshot = GatewayThreadViewPatch(threadId: "t1", viewRevision: 6, scope: .fullSnapshot, liveState: .idle, rows: [
        TimelineRow(id: "row-2", kind: .message, displayOrder: 2, title: "Kodex", body: "snapshot")
    ])
    let invalidSnapshot = GatewayThreadViewPatch(threadId: "t1", viewRevision: 7, scope: .fullSnapshot, liveState: .idle, rows: nil)

    guard case .ignoredStale(let unchanged) = timeline.applying(stale) else {
        Issue.record("Expected stale patch to be ignored")
        return
    }
    #expect(unchanged.rows.first?.body == "old")

    guard case .applied(let lifecycleOnly) = timeline.applying(lifecycle) else {
        Issue.record("Expected lifecycle patch to apply")
        return
    }
    #expect(lifecycleOnly.liveState == .idle)
    #expect(lifecycleOnly.rows.first?.body == "old")

    guard case .applied(let replaced) = lifecycleOnly.applying(fullSnapshot) else {
        Issue.record("Expected full snapshot patch to replace rows")
        return
    }
    #expect(replaced.rows.map(\.id) == ["row-2"])
    #expect(replaced.olderCursor == "older-1")
    #expect(replaced.hasOlder)

    guard case .needsSnapshotRefresh = replaced.applying(invalidSnapshot) else {
        Issue.record("Expected invalid snapshot patch to request refresh")
        return
    }
}

@Test func threadTimelineRequestsSnapshotForUnsupportedScopeAndThreadMismatch() {
    let timeline = ThreadTimeline(
        threadId: "t1",
        liveState: .streaming,
        viewRevision: 1,
        rows: [TimelineRow(id: "row-1", kind: .message, displayOrder: 1, title: "Kodex", body: "old")]
    )
    let unsupported = GatewayThreadViewPatch(
        threadId: "t1",
        viewRevision: 2,
        scope: .unsupported("future_scope"),
        liveState: .streaming
    )
    let wrongThread = GatewayThreadViewPatch(
        threadId: "other",
        viewRevision: 2,
        scope: .turn,
        liveState: .streaming,
        rows: [TimelineRow(id: "row-2", kind: .message, displayOrder: 2, title: "Kodex", body: "new", turnId: "turn-2")],
        affectedTurnIds: ["turn-2"]
    )

    guard case .needsSnapshotRefresh(let unsupportedReason) = timeline.applying(unsupported) else {
        Issue.record("Expected unsupported scope to request snapshot refresh")
        return
    }
    guard case .needsSnapshotRefresh(let mismatchReason) = timeline.applying(wrongThread) else {
        Issue.record("Expected thread mismatch to request snapshot refresh")
        return
    }
    #expect(unsupportedReason.contains("Unsupported patch scope"))
    #expect(mismatchReason.contains("did not match"))
}

@Test func threadTimelineAppliesDuplicateRowIdsDeterministically() {
    let timeline = ThreadTimeline(
        threadId: "t1",
        liveState: .streaming,
        viewRevision: 1,
        rows: [
            TimelineRow(id: "row-1", kind: .message, displayOrder: 1, title: "First", body: "first", turnId: "turn-1"),
            TimelineRow(id: "row-1", kind: .message, displayOrder: 2, title: "Second", body: "second", turnId: "turn-1")
        ]
    )
    let patch = GatewayThreadViewPatch(
        threadId: "t1",
        viewRevision: 2,
        scope: .turn,
        liveState: .streaming,
        rows: [
            TimelineRow(id: "row-1", kind: .message, displayOrder: 3, title: "Latest", body: "latest", turnId: "turn-1")
        ],
        affectedTurnIds: ["turn-1"]
    )

    guard case .applied(let updated) = timeline.applying(patch) else {
        Issue.record("Expected duplicate row IDs to be reduced deterministically")
        return
    }
    #expect(updated.rows.map(\.id) == ["row-1"])
    #expect(updated.rows.first?.body == "latest")
}

@Test func gatewayLiveEventBatchCoalescesSupersededTurnPatches() {
    let first = GatewayLiveEnvelope(seq: 10, event: .threadViewPatch(GatewayThreadViewPatch(
        threadId: "t1",
        viewRevision: 10,
        scope: .turn,
        liveState: .streaming,
        activeTurnId: "turn-1",
        rows: [TimelineRow(id: "row-agent", kind: .message, displayOrder: 1, title: "Kodex", body: "hel", turnId: "turn-1")],
        affectedTurnIds: ["turn-1"]
    )))
    let latest = GatewayLiveEnvelope(seq: 11, event: .threadViewPatch(GatewayThreadViewPatch(
        threadId: "t1",
        viewRevision: 11,
        scope: .turn,
        liveState: .streaming,
        activeTurnId: "turn-1",
        rows: [TimelineRow(id: "row-agent", kind: .message, displayOrder: 1, title: "Kodex", body: "hello", turnId: "turn-1")],
        affectedTurnIds: ["turn-1"]
    )))
    let refresh = GatewayLiveEnvelope(seq: 12, event: .refreshRequired(threadId: "t1"))

    let coalesced = GatewayLiveEventBatch.coalesce([refresh, latest, first])

    #expect(coalesced.map(\.seq) == [11, 12])
    guard case .threadViewPatch(let patch) = coalesced.first?.event else {
        Issue.record("Expected latest patch to remain")
        return
    }
    #expect(patch.rows?.first?.body == "hello")
}

@Test func gatewayLiveEventBatchCoalescesCompleteTurnReplacementPatches() {
    let first = GatewayLiveEnvelope(seq: 10, event: .threadViewPatch(GatewayThreadViewPatch(
        threadId: "t1",
        viewRevision: 10,
        scope: .turn,
        liveState: .streaming,
        activeTurnId: "turn-1",
        rows: [TimelineRow(id: "row-agent", kind: .message, displayOrder: 1, title: "Kodex", body: "old", turnId: "turn-1")],
        affectedTurnIds: ["turn-1"]
    )))
    let removal = GatewayLiveEnvelope(seq: 11, event: .threadViewPatch(GatewayThreadViewPatch(
        threadId: "t1",
        viewRevision: 11,
        scope: .turn,
        liveState: .streaming,
        activeTurnId: "turn-1",
        rows: [TimelineRow(id: "row-agent", kind: .message, displayOrder: 1, title: "Kodex", body: "new", turnId: "turn-1")],
        affectedTurnIds: ["turn-1"]
    )))

    let coalesced = GatewayLiveEventBatch.coalesce([removal, first])

    #expect(coalesced.map(\.seq) == [11])
}

@Test func gatewayLiveEventBatchPreservesLifecycleAndSnapshotOrderingAroundTurns() {
    let turn = GatewayLiveEnvelope(seq: 10, event: .threadViewPatch(GatewayThreadViewPatch(
        threadId: "t1",
        viewRevision: 10,
        scope: .turn,
        liveState: .streaming,
        activeTurnId: "turn-1",
        rows: [TimelineRow(id: "row-agent", kind: .message, displayOrder: 1, title: "Kodex", body: "stream", turnId: "turn-1")],
        affectedTurnIds: ["turn-1"]
    )))
    let lifecycle = GatewayLiveEnvelope(seq: 11, event: .threadViewPatch(GatewayThreadViewPatch(
        threadId: "t1",
        viewRevision: 11,
        scope: .lifecycle,
        liveState: .idle,
        activeTurnId: "turn-1"
    )))
    let snapshot = GatewayLiveEnvelope(seq: 12, event: .threadViewPatch(GatewayThreadViewPatch(
        threadId: "t1",
        viewRevision: 12,
        scope: .fullSnapshot,
        liveState: .idle,
        rows: [TimelineRow(id: "row-final", kind: .message, displayOrder: 1, title: "Kodex", body: "final")]
    )))

    let coalesced = GatewayLiveEventBatch.coalesce([snapshot, lifecycle, turn])

    #expect(coalesced.map(\.seq) == [10, 11, 12])
}

@Test func gatewayStreamCheckpointAdvancesCursorAndTracksReconnects() {
    var checkpoint = GatewayStreamCheckpoint(cursor: 10)

    checkpoint.observe(GatewayLiveEnvelope(seq: 12, event: .threadUpserted(threadId: "t1")))
    checkpoint.recordDisconnect()
    checkpoint.observe(GatewayLiveEnvelope(seq: 11, event: .threadUpserted(threadId: "t1")))

    #expect(checkpoint.cursor == 12)
    #expect(checkpoint.reconnectAttempts == 0)
}

@Test func gatewayStreamCheckpointCanResetAcrossSelectedThreadChanges() {
    var checkpoint = GatewayStreamCheckpoint(cursor: 42, reconnectAttempts: 2)

    checkpoint.reset()

    #expect(checkpoint.cursor == nil)
    #expect(checkpoint.reconnectAttempts == 0)
    #expect(!checkpoint.shouldUsePollingFallback())
}

@Test func gatewayStreamScopeDedupesSelectedAndGlobalEventsAndFallsBackToPolling() {
    let selectedScope = GatewayEventScope.selected(threadId: "selected")
    let globalScope = GatewayEventScope.global(excludingThreadId: "selected")
    var checkpoint = GatewayStreamCheckpoint()

    checkpoint.recordDisconnect()
    #expect(!checkpoint.shouldUsePollingFallback())
    checkpoint.recordDisconnect()

    #expect(selectedScope.accepts(threadId: "selected"))
    #expect(!selectedScope.accepts(threadId: "other"))
    #expect(!globalScope.accepts(threadId: "selected"))
    #expect(globalScope.accepts(threadId: "other"))
    #expect(globalScope.accepts(threadId: nil))
    #expect(checkpoint.shouldUsePollingFallback())
}
