import Foundation
import Testing
@testable import KodexCore

@Test func simulatorDefaultUsesLoopbackGateway() {
    #expect(GatewayConfiguration.simulatorDefault.baseURL.absoluteString == "http://127.0.0.1:8787")
}

@Test func gatewayConfigurationNormalizesTrailingSlash() throws {
    let configuration = try GatewayConfiguration(userInput: " http://127.0.0.1:8787/ ")

    #expect(configuration.baseURL.absoluteString == "http://127.0.0.1:8787")
    #expect(configuration.endpoint(.readyz).absoluteString == "http://127.0.0.1:8787/readyz")
}

@Test func gatewayRoutesBuildIOSMilestoneEndpoints() throws {
    let configuration = GatewayConfiguration.simulatorDefault

    #expect(configuration.endpoint(.sidebarThreads).absoluteString == "http://127.0.0.1:8787/v1/sidebar/threads")
    #expect(configuration.endpoint(.thread("thread/with space")).absoluteString == "http://127.0.0.1:8787/v1/threads/thread%2Fwith%20space")
    #expect(configuration.endpoint(.threadTimelinePage(threadId: "abc", cursor: "older", limit: 50)).absoluteString == "http://127.0.0.1:8787/v1/threads/abc/timeline/pages?cursor=older&limit=50")
    #expect(configuration.endpoint(.threadInput("abc")).absoluteString == "http://127.0.0.1:8787/v1/threads/abc/input")
    #expect(configuration.endpoint(.threadInterruptCurrent("abc")).absoluteString == "http://127.0.0.1:8787/v1/threads/abc/interrupt-current")
    #expect(configuration.endpoint(.queuedInputSteer(threadId: "abc", queueId: "q1")).absoluteString == "http://127.0.0.1:8787/v1/threads/abc/queued-inputs/q1/steer")
    #expect(configuration.endpoint(.imageUploads).absoluteString == "http://127.0.0.1:8787/v1/uploads/images")
    #expect(configuration.endpoint(.skills(cwd: "/tmp/kodex", forceReload: true)).absoluteString == "http://127.0.0.1:8787/v1/skills?cwd=/tmp/kodex&forceReload=true")
    #expect(configuration.endpoint(.approvals(status: "pending", threadId: "abc")).absoluteString == "http://127.0.0.1:8787/v1/approvals?status=pending&threadId=abc")
    #expect(configuration.endpoint(.approvalDecision("approval 1")).absoluteString == "http://127.0.0.1:8787/v1/approvals/approval%201/decision")
    #expect(configuration.endpoint(.events(cursor: 42, projectId: "p1", threadId: "t1", excludeThreadId: "t2")).absoluteString == "http://127.0.0.1:8787/v1/events?cursor=42&projectId=p1&threadId=t1&excludeThreadId=t2")
}

@Test func gatewayConfigurationRejectsMissingHost() {
    #expect(throws: GatewayConfigurationError.missingHost) {
        try GatewayConfiguration(userInput: "http:///")
    }
}

@Test func gatewayConfigurationRejectsUnsupportedSchemes() {
    #expect(throws: GatewayConfigurationError.unsupportedScheme) {
        try GatewayConfiguration(userInput: "file:///tmp/kodex")
    }
}

@Test func gatewayProbeReportsConnectedWhenReadyzIsReady() async {
    let probe = GatewayProbe { url in
        if url.path == "/readyz" {
            return GatewayHTTPResponse(statusCode: 200, body: Data(#"{"ready":true}"#.utf8))
        }
        return GatewayHTTPResponse(statusCode: 200, body: Data(#"{"status":"ok"}"#.utf8))
    }

    let result = await probe.check(.simulatorDefault)

    #expect(result == .connected)
}

@Test func gatewayProbeReportsDegradedWhenAppServerIsNotReady() async {
    let probe = GatewayProbe { url in
        if url.path == "/readyz" {
            return GatewayHTTPResponse(
                statusCode: 200,
                body: Data(#"{"ready":false,"message":"app-server unavailable"}"#.utf8)
            )
        }
        return GatewayHTTPResponse(statusCode: 200, body: Data(#"{"status":"ok"}"#.utf8))
    }

    let result = await probe.check(.simulatorDefault)

    #expect(result == .degraded(message: "app-server unavailable"))
}

@Test func gatewayProbeReportsOfflineWhenHealthCheckFails() async {
    let probe = GatewayProbe { _ in
        GatewayHTTPResponse(statusCode: 503)
    }

    let result = await probe.check(.simulatorDefault)

    #expect(result == .offline(message: "Gateway health check returned HTTP 503."))
}

@Test func gatewayConnectionCheckerReportsConnectedStatus() async {
    let checker = GatewayConnectionChecker(probe: GatewayProbe { url in
        if url.path == "/readyz" {
            return GatewayHTTPResponse(statusCode: 200, body: Data(#"{"ready":true}"#.utf8))
        }
        return GatewayHTTPResponse(statusCode: 200, body: Data(#"{"status":"ok"}"#.utf8))
    })

    let status = await checker.check(userInput: "http://127.0.0.1:8787")

    #expect(status == .connected(baseURL: "http://127.0.0.1:8787"))
    #expect(status.displayText == "Connected to http://127.0.0.1:8787")
    #expect(status.canLoadLiveWorkspace)
}

@Test func gatewayConnectionCheckerReportsDegradedStatus() async {
    let checker = GatewayConnectionChecker(probe: GatewayProbe { url in
        if url.path == "/readyz" {
            return GatewayHTTPResponse(
                statusCode: 200,
                body: Data(#"{"ready":false,"message":"app-server unavailable"}"#.utf8)
            )
        }
        return GatewayHTTPResponse(statusCode: 200, body: Data(#"{"status":"ok"}"#.utf8))
    })

    let status = await checker.check(userInput: "http://127.0.0.1:8787")

    #expect(status == .degraded(message: "app-server unavailable"))
    #expect(status.displayText == "Gateway degraded: app-server unavailable")
    #expect(!status.canLoadLiveWorkspace)
}

@Test func gatewayConnectionCheckerReportsOfflineStatus() async {
    let checker = GatewayConnectionChecker(probe: GatewayProbe { _ in
        GatewayHTTPResponse(statusCode: 503)
    })

    let status = await checker.check(userInput: "http://127.0.0.1:8787")

    #expect(status == .offline(message: "Gateway health check returned HTTP 503."))
    #expect(!status.canLoadLiveWorkspace)
}

@Test func gatewayConnectionCheckerReportsInvalidURLsWithoutNetwork() async {
    let checker = GatewayConnectionChecker(probe: GatewayProbe { _ in
        Issue.record("Invalid URLs should not call the network loader")
        return GatewayHTTPResponse(statusCode: 200)
    })

    let status = await checker.check(userInput: "file:///tmp/kodex")

    #expect(status == .invalidURL(message: "Use an http or https gateway URL."))
}

@Test func gatewayClientBuildsJSONRequestsAndNormalizesGatewayErrors() async {
    let client = GatewayClient(configuration: .simulatorDefault) { request in
        #expect(request.method == .post)
        #expect(request.headers["Content-Type"] == "application/json")
        #expect(request.url.path == "/v1/approvals/approval-fixture/decision")
        return GatewayHTTPResponse(statusCode: 409, body: Data(#"{"message":"approval already resolved"}"#.utf8))
    }

    let result = await client.send(
        .approvalDecision("approval-fixture"),
        method: .post,
        body: Data(#"{"decision":"accept"}"#.utf8)
    )

    #expect(result == .failure(.gateway(statusCode: 409, message: "approval already resolved")))
}

@Test func gatewayClientReportsNetworkFailure() async {
    struct StubNetworkError: LocalizedError {
        var errorDescription: String? { "network down" }
    }

    let client = GatewayClient(configuration: .simulatorDefault) { _ in
        throw StubNetworkError()
    }

    let result = await client.send(.sidebarThreads)

    #expect(result == .failure(.transport("network down")))
}
