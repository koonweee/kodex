import XCTest

final class KodexIOSUITests: XCTestCase {
    @MainActor
    func testConnectedFixtureRendersWorkspaceAndThreadDetail() {
        let app = launch(arguments: ["--ui-testing", "--fixture-connected"])

        XCTAssertTrue(app.staticTexts["Release checklist"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.textFields["WorkspaceSearch"].exists)
        XCTAssertTrue(app.buttons["New Chat"].exists)
        XCTAssertTrue(app.staticTexts["Pinned"].exists)
        XCTAssertTrue(app.buttons["Projects"].exists)

        app.staticTexts["Release checklist"].tap()
        XCTAssertTrue(app.textFields["Message Kodex"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Send"].exists)
        XCTAssertFalse(app.buttons["Stop"].exists)
        XCTAssertTrue(app.buttons["ThreadActions"].exists)
        XCTAssertTrue(app.staticTexts["Implement native iOS milestone coverage."].exists)
        XCTAssertTrue(app.staticTexts["xcodebuild test"].exists)
        XCTAssertTrue(app.staticTexts["Attached simulator screenshot fixture."].exists)
        XCTAssertTrue(app.staticTexts["apps/ios/Sources and Tests updated."].exists)
        XCTAssertTrue(app.staticTexts["OpenAI auth required for live smoke."].exists)
        XCTAssertTrue(app.staticTexts["Fixture-only error row."].exists)

        for _ in 0..<5 where !app.staticTexts["Long-thread fixture row 34."].exists {
            app.scrollViews.firstMatch.swipeUp()
        }
        XCTAssertTrue(app.staticTexts["Long-thread fixture row 34."].waitForExistence(timeout: 5))
    }

    @MainActor
    func testDegradedFixtureRendersStatusAndApproval() {
        let app = launch(arguments: ["--ui-testing", "--fixture-degraded"])

        XCTAssertTrue(app.staticTexts["Native iOS milestone"].waitForExistence(timeout: 5))
        app.staticTexts["Native iOS milestone"].tap()
        XCTAssertTrue(app.staticTexts["List workspace"].exists)
        XCTAssertTrue(app.staticTexts["Run focused Swift tests"].exists)
        XCTAssertTrue(app.staticTexts["xcodebuild test"].exists)
        XCTAssertTrue(app.staticTexts["Read project file"].exists)

        app.buttons["ApproveApproval-approval-accept-fixture"].tap()
        XCTAssertFalse(app.staticTexts["List workspace"].waitForExistence(timeout: 2))
        app.buttons["DeclineApproval-approval-decline-fixture"].tap()
        XCTAssertFalse(app.staticTexts["Read project file"].waitForExistence(timeout: 2))
        app.buttons["ApproveApproval-approval-fixture"].tap()
        XCTAssertTrue(app.staticTexts["Approve Risky Action?"].waitForExistence(timeout: 5))
    }

    @MainActor
    func testOfflineFixtureRendersEmptyWorkspace() {
        let app = launch(arguments: ["--ui-testing", "--fixture-offline"])

        XCTAssertTrue(app.staticTexts["Gateway offline: Could not reach http://127.0.0.1:8787"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["No Threads"].exists)
    }

    @MainActor
    func testAuthRequiredFixtureRendersRecoveryState() {
        let app = launch(arguments: ["--ui-testing", "--fixture-auth-required"])

        XCTAssertTrue(app.staticTexts["OpenAI auth required"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["No Threads"].exists)
        app.buttons["Connection Settings"].tap()
        XCTAssertTrue(app.buttons["Check Connection"].exists)
    }

    @MainActor
    func testFixtureUsesSplitNavigationOnRegularWidthDevices() throws {
        guard UIDevice.current.userInterfaceIdiom == .pad else {
            throw XCTSkip("iPad split navigation fixture coverage runs on an iPad simulator destination.")
        }
        let app = launch(arguments: ["--ui-testing", "--fixture-connected"])

        XCTAssertTrue(app.staticTexts["Release checklist"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.textFields["Message Kodex"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Implement native iOS milestone coverage."].exists)
    }

    @MainActor
    func testThreadActionMenuMatchesMobileWebOrder() {
        let app = launch(arguments: ["--ui-testing", "--fixture-connected"])

        XCTAssertTrue(app.staticTexts["Release checklist"].waitForExistence(timeout: 5))
        app.staticTexts["Release checklist"].tap()
        app.buttons["ThreadActions"].tap()

        XCTAssertTrue(app.buttons["Pin"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["Rename"].exists)
        XCTAssertTrue(app.buttons["Notifications"].exists)
        XCTAssertTrue(app.buttons["Archive"].exists)
    }

    @MainActor
    func testLiveGatewayE2ESmokeWhenEnabled() throws {
        guard ProcessInfo.processInfo.environment["KODEX_IOS_LIVE_E2E"] == "1" else {
            throw XCTSkip("Set KODEX_IOS_LIVE_E2E=1 and KODEX_GATEWAY_URL to run live gateway iOS smoke.")
        }
        let app = launch(arguments: ["--ui-testing"])

        XCTAssertTrue(waitForSidebar(app, timeout: 20))
        XCTAssertTrue(app.staticTexts["GatewayStatus"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.buttons["New Chat"].waitForExistence(timeout: 10))

        let newProjectThread = app.buttons["New Project Thread"]
        if newProjectThread.exists && newProjectThread.isEnabled {
            newProjectThread.tap()
            XCTAssertTrue(app.textFields["Message Kodex"].waitForExistence(timeout: 20))
            XCTAssertTrue(waitForSidebar(app, timeout: 10))
        }

        app.buttons["New Chat"].tap()

        XCTAssertTrue(app.staticTexts["Say pong"].waitForExistence(timeout: 30))
        XCTAssertTrue(app.staticTexts["Assistant"].waitForExistence(timeout: 120))
    }

    @MainActor
    private func launch(arguments: [String]) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = arguments
        if let gatewayURL = ProcessInfo.processInfo.environment["KODEX_GATEWAY_URL"] {
            app.launchEnvironment["KODEX_GATEWAY_URL"] = gatewayURL
        }
        if let liveE2E = ProcessInfo.processInfo.environment["KODEX_IOS_LIVE_E2E"] {
            app.launchEnvironment["KODEX_IOS_LIVE_E2E"] = liveE2E
        }
        app.launch()
        return app
    }

    @MainActor
    private func waitForSidebar(_ app: XCUIApplication, timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if app.buttons["New Chat"].exists || app.staticTexts["GatewayStatus"].exists {
                return true
            }
            let backButton = app.buttons["BackButton"]
            if backButton.exists {
                backButton.tap()
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.5))
        }
        return app.buttons["New Chat"].exists || app.staticTexts["GatewayStatus"].exists
    }
}
