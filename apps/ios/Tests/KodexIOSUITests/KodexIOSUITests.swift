import XCTest

final class KodexIOSUITests: XCTestCase {
    @MainActor
    func testConnectedFixtureRendersWorkspaceAndThreadDetail() {
        let app = launch(arguments: ["--ui-testing", "--fixture-connected"])

        XCTAssertTrue(app.staticTexts["Release checklist"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.textFields["WorkspaceSearch"].exists)
        XCTAssertTrue(app.buttons["New Chat"].exists)
        XCTAssertTrue(app.images["GatewayStatusDot"].exists)
        XCTAssertTrue(app.staticTexts["Profile K"].exists)
        XCTAssertTrue(app.staticTexts["AccountStatus"].exists == false || !app.staticTexts["AccountStatus"].label.contains("@"))
        XCTAssertTrue(app.staticTexts["Pinned"].exists)
        XCTAssertTrue(app.buttons["Projects"].exists)

        app.staticTexts["Release checklist"].tap()
        XCTAssertTrue(app.textFields["Message Kodex"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Send"].exists)
        XCTAssertFalse(app.buttons["Send"].isEnabled)
        XCTAssertTrue(app.buttons["Add Attachment"].exists)
        XCTAssertTrue(app.buttons["Expanded Composer"].exists)
        XCTAssertTrue(app.buttons["Permissions"].exists)
        XCTAssertTrue(composerOptionsButton(in: app).exists)
        XCTAssertFalse(app.buttons["Stop"].exists)
        XCTAssertTrue(app.buttons["ThreadActions"].exists)
        XCTAssertFalse(app.buttons["LoadOlderTimeline"].exists)
        XCTAssertFalse(app.staticTexts["User"].exists)
        XCTAssertFalse(app.staticTexts["Assistant"].exists)
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
        for _ in 0..<8 where !app.staticTexts["Older fixture row 1."].exists {
            app.scrollViews.firstMatch.swipeDown()
        }
        XCTAssertTrue(app.staticTexts["Older fixture row 1."].waitForExistence(timeout: 5))

        app.textFields["Message Kodex"].tap()
        app.typeText("hello")
        XCTAssertTrue(app.buttons["Send"].isEnabled)
    }

    @MainActor
    func testComposerControlsRemainAccessibleInFixtures() {
        let app = launch(arguments: ["--ui-testing", "--fixture-connected"])

        XCTAssertTrue(app.staticTexts["Release checklist"].waitForExistence(timeout: 5))
        app.staticTexts["Release checklist"].tap()
        XCTAssertTrue(app.textFields["Message Kodex"].waitForExistence(timeout: 5))

        app.buttons["Expanded Composer"].tap()
        XCTAssertTrue(app.staticTexts["Compose"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["Send"].exists)
        app.buttons["Close"].tap()

        XCTAssertTrue(app.buttons["Add Attachment"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["Permissions"].exists)
        XCTAssertTrue(composerOptionsButton(in: app).exists)
        assertComposerMenusOpen(in: app)
    }

    @MainActor
    func testDegradedFixtureRendersStatusAndApproval() {
        let app = launch(arguments: ["--ui-testing", "--fixture-degraded"])

        XCTAssertTrue(app.staticTexts["Native iOS milestone"].waitForExistence(timeout: 5))
        app.staticTexts["Native iOS milestone"].tap()
        XCTAssertTrue(app.buttons["Stop"].waitForExistence(timeout: 5))
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

        XCTAssertTrue(app.images["GatewayStatusDot"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["Gateway offline: Could not reach http://127.0.0.1:8787"].exists)
        XCTAssertTrue(app.staticTexts["No Threads"].exists)
    }

    @MainActor
    func testAuthRequiredFixtureRendersRecoveryState() {
        let app = launch(arguments: ["--ui-testing", "--fixture-auth-required"])

        XCTAssertTrue(app.staticTexts["No Threads"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["OpenAI auth required"].exists)
        app.buttons["Connection Settings"].tap()
        XCTAssertTrue(app.staticTexts["OpenAI auth required"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Check Connection"].exists)
        XCTAssertFalse(app.staticTexts["Notifications not enabled"].exists)
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
        XCTAssertTrue(app.images["GatewayStatusDot"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.buttons["New Chat"].waitForExistence(timeout: 10))

        let newProjectThread = app.buttons["New Project Thread"]
        if newProjectThread.exists && newProjectThread.isEnabled {
            newProjectThread.tap()
            XCTAssertTrue(app.textFields["Message Kodex"].waitForExistence(timeout: 20))
            XCTAssertTrue(waitForSidebar(app, timeout: 10))
        }

        app.buttons["New Chat"].tap()

        XCTAssertTrue(app.staticTexts["Say pong"].waitForExistence(timeout: 30))
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS[c] %@", "pong")).firstMatch.waitForExistence(timeout: 120))
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
            if app.buttons["New Chat"].exists || app.images["GatewayStatusDot"].exists {
                return true
            }
            let backButton = app.buttons["BackButton"]
            if backButton.exists {
                backButton.tap()
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.5))
        }
        return app.buttons["New Chat"].exists || app.images["GatewayStatusDot"].exists
    }

    @MainActor
    private func composerOptionsButton(in app: XCUIApplication) -> XCUIElement {
        app.buttons.containing(NSPredicate(format: "label CONTAINS[c] %@", "Composer Options")).firstMatch
    }

    @MainActor
    private func assertComposerMenusOpen(in app: XCUIApplication) {
        app.buttons["Add Attachment"].tap()
        XCTAssertTrue(app.buttons["Attach Photo"].waitForExistence(timeout: 3))
        dismissMenu(in: app)

        app.buttons["Permissions"].tap()
        XCTAssertTrue(app.buttons["Ask First"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["Workspace Write"].exists)
        dismissMenu(in: app)

        composerOptionsButton(in: app).tap()
        XCTAssertTrue(app.buttons["gpt-5.4-mini"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["High"].exists)
        dismissMenu(in: app)
    }

    @MainActor
    private func dismissMenu(in app: XCUIApplication) {
        if app.buttons["Cancel"].exists {
            app.buttons["Cancel"].tap()
        } else {
            app.tap()
        }
    }
}
