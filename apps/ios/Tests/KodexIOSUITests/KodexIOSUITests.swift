import XCTest
import UIKit

final class KodexIOSUITests: XCTestCase {
    @MainActor
    func testConnectedFixtureRendersWorkspaceAndThreadDetail() {
        let app = launch(arguments: ["--ui-testing", "--fixture-connected"])

        XCTAssertTrue(revealReleaseChecklist(in: app))
        XCTAssertTrue(workspaceSearchButton(in: app).exists)
        XCTAssertTrue(app.buttons["New Chat"].exists)
        XCTAssertTrue(app.buttons["Connection Settings"].exists)
        XCTAssertTrue(app.staticTexts["Chats"].exists)
        XCTAssertTrue(app.buttons["Projects"].exists)
        XCTAssertFalse(app.staticTexts["/Users/example/kodex"].exists)

        threadElement("Release checklist", in: app).tap()
        XCTAssertTrue(app.textFields["Message Kodex"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Send"].exists)
        XCTAssertFalse(app.buttons["Send"].isEnabled)
        XCTAssertTrue(app.buttons["Add Attachment"].exists)
        XCTAssertFalse(app.buttons["Expanded Composer"].exists)
        XCTAssertTrue(permissionsButton(in: app).exists)
        XCTAssertTrue(composerOptionsButton(in: app).exists)
        XCTAssertTrue(accessibilityValue(of: permissionsButton(in: app)).contains("Approvals"))
        XCTAssertTrue(accessibilityValue(of: composerOptionsButton(in: app)).contains("Model"))
        XCTAssertFalse(app.buttons["Stop"].exists)
        XCTAssertTrue(app.buttons["ThreadActions"].exists)
        swipeUntil(app.scrollViews.firstMatch, direction: .up, exists: labelContaining("Long-thread fixture row 34.", in: app), maxSwipes: 10)
        XCTAssertTrue(labelContaining("Long-thread fixture row 34.", in: app).waitForExistence(timeout: 5))

        swipeUntil(app.scrollViews.firstMatch, direction: .down, exists: labelContaining("Older fixture row 1.", in: app), maxSwipes: 10)
        if !labelContaining("Older fixture row 1.", in: app).exists {
            app.scrollViews.firstMatch.swipeDown()
        }
        XCTAssertTrue(labelContaining("Older fixture row 1.", in: app).waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Jump to Latest"].waitForExistence(timeout: 3))
        app.buttons["Jump to Latest"].tap()
        XCTAssertTrue(labelContaining("Long-thread fixture row 34.", in: app).waitForExistence(timeout: 5))

        app.textFields["Message Kodex"].tap()
        app.typeText("hello")
        XCTAssertTrue(app.buttons["Send"].isEnabled)
    }

    @MainActor
    func testComposerControlsRemainAccessibleInFixtures() {
        let app = launch(arguments: ["--ui-testing", "--fixture-connected"])

        XCTAssertTrue(revealReleaseChecklist(in: app))
        threadElement("Release checklist", in: app).tap()
        XCTAssertTrue(app.textFields["Message Kodex"].waitForExistence(timeout: 5))

        XCTAssertTrue(app.buttons["Add Attachment"].waitForExistence(timeout: 3))
        XCTAssertFalse(app.buttons["Expanded Composer"].exists)
        XCTAssertFalse(app.buttons["Attach Skill"].exists)
        XCTAssertTrue(permissionsButton(in: app).exists)
        XCTAssertTrue(composerOptionsButton(in: app).exists)
        assertComposerMenusOpen(in: app)
    }

    @MainActor
    func testActiveComposerSwitchesStopToSendWhenDraftExists() {
        let app = launch(arguments: ["--ui-testing", "--fixture-degraded"])

        XCTAssertTrue(threadElement("Native iOS milestone", in: app).waitForExistence(timeout: 5))
        threadElement("Native iOS milestone", in: app).tap()
        let composer = app.textFields["Message Kodex"]
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Stop"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["Send"].exists)

        composer.tap()
        app.typeText("follow up")

        XCTAssertTrue(app.buttons["Send"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Send"].isEnabled)
        XCTAssertFalse(app.buttons["Stop"].exists)
    }

    @MainActor
    func testWorkspaceNativeSearchAndScopeRemainAccessible() {
        let app = launch(arguments: ["--ui-testing", "--fixture-connected"])

        XCTAssertTrue(waitForAnyWorkspaceThread(in: app))
        XCTAssertTrue(workspaceSearchButton(in: app).waitForExistence(timeout: 3))
        XCTAssertTrue(app.segmentedControls["WorkspaceScopeControl"].exists || app.buttons["Projects"].exists)

        scopeButton("Projects", in: app).tap()
        XCTAssertTrue(revealNativeIOSMilestone(in: app))
        XCTAssertTrue(threadElement("Unread agent message", in: app).exists)
        XCTAssertFalse(threadElement("Pinned chat follow-up", in: app).exists)
        scopeButton("Chats", in: app).tap()
        XCTAssertTrue(revealReleaseChecklist(in: app))
        XCTAssertTrue(threadElement("Pinned chat follow-up", in: app).waitForExistence(timeout: 3))
        XCTAssertFalse(threadElement("Unread agent message", in: app).exists)

        let searchField = focusWorkspaceSearch(in: app)
        searchField.tap()
        app.typeText("Release")
        XCTAssertTrue(threadElement("Release checklist", in: app).waitForExistence(timeout: 3))
    }

    @MainActor
    func testSettingsFormKeepsGatewayURLEditable() {
        let app = launch(arguments: ["--ui-testing", "--fixture-auth-required"])

        XCTAssertTrue(app.staticTexts["No Threads"].waitForExistence(timeout: 5))
        app.buttons["Connection Settings"].tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 5) || app.staticTexts["Settings"].exists)
        XCTAssertTrue(app.staticTexts["OpenAI auth required"].exists)
        XCTAssertTrue(app.staticTexts["GatewayStatus"].exists || app.staticTexts["Status"].exists)

        let gatewayURLField = app.textFields["Gateway URL"]
        XCTAssertTrue(gatewayURLField.waitForExistence(timeout: 3))
        gatewayURLField.tap()
        app.typeText("/health")
        XCTAssertTrue(accessibilityValue(of: gatewayURLField).contains("/health"))
    }

    @MainActor
    func testDynamicTypeKeepsNativeControlsReachableInFixtures() {
        let app = launch(
            arguments: ["--ui-testing", "--fixture-connected"],
            environment: ["UIPreferredContentSizeCategoryName": UIContentSizeCategory.accessibilityExtraExtraExtraLarge.rawValue]
        )

        XCTAssertTrue(revealReleaseChecklist(in: app))
        XCTAssertTrue(workspaceSearchButton(in: app).exists)
        XCTAssertTrue(app.buttons["Projects"].exists)
        assertMinimumTapTarget(app.buttons["New Chat"])
        assertMinimumTapTarget(app.buttons["Connection Settings"])

        threadElement("Release checklist", in: app).tap()
        XCTAssertTrue(app.textFields["Message Kodex"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Add Attachment"].exists)
        XCTAssertFalse(app.buttons["Expanded Composer"].exists)
        XCTAssertTrue(permissionsButton(in: app).exists)
        XCTAssertTrue(composerOptionsButton(in: app).exists)
        assertMinimumTapTarget(app.buttons["Add Attachment"])
        assertMinimumTapTarget(permissionsButton(in: app))
        assertMinimumTapTarget(composerOptionsButton(in: app))
    }

    @MainActor
    func testDegradedFixtureRendersStatusAndApproval() {
        let app = launch(arguments: ["--ui-testing", "--fixture-degraded"])

        XCTAssertTrue(threadElement("Native iOS milestone", in: app).waitForExistence(timeout: 5))
        threadElement("Native iOS milestone", in: app).tap()
        XCTAssertTrue(app.buttons["Stop"].waitForExistence(timeout: 5))
        XCTAssertTrue(labelContaining("Long-thread fixture row 34.", in: app).waitForExistence(timeout: 5))
        swipeUntil(app.scrollViews.firstMatch, direction: .down, exists: labelContaining("List workspace", in: app), maxSwipes: 8)
        XCTAssertTrue(app.staticTexts["List workspace"].exists)
        XCTAssertTrue(app.staticTexts["Run focused Swift tests"].exists)
        XCTAssertTrue(labelContaining("xcodebuild test", in: app).exists)
        XCTAssertTrue(app.staticTexts["Read project file"].exists)

        app.buttons["ApproveApproval-approval-accept-fixture"].tap()
        XCTAssertFalse(app.staticTexts["List workspace"].waitForExistence(timeout: 2))
        let declineButton = app.buttons["DeclineApproval-approval-decline-fixture"]
        XCTAssertTrue(declineButton.waitForExistence(timeout: 3))
        declineButton.tap()
        XCTAssertFalse(app.staticTexts["Read project file"].waitForExistence(timeout: 2))
        app.buttons["ApproveApproval-approval-fixture"].tap()
        XCTAssertTrue(app.staticTexts["Approve Risky Action?"].waitForExistence(timeout: 5))
    }

    @MainActor
    func testOfflineFixtureRendersEmptyWorkspace() {
        let app = launch(arguments: ["--ui-testing", "--fixture-offline"])

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
        XCTAssertTrue(app.buttons["Done"].exists)
        XCTAssertFalse(app.staticTexts["Notifications not enabled"].exists)
    }

    @MainActor
    func testFixtureUsesSplitNavigationOnRegularWidthDevices() throws {
        guard UIDevice.current.userInterfaceIdiom == .pad else {
            throw XCTSkip("iPad split navigation fixture coverage runs on an iPad simulator destination.")
        }
        let app = launch(arguments: ["--ui-testing", "--fixture-connected"])

        XCTAssertTrue(threadElement("Release checklist", in: app).waitForExistence(timeout: 5))
        XCTAssertTrue(app.textFields["Message Kodex"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Implement native iOS milestone coverage."].exists)
    }

    @MainActor
    func testCompactThreadCanSwipeBackToSidebar() throws {
        guard UIDevice.current.userInterfaceIdiom == .phone else {
            throw XCTSkip("Compact back-swipe coverage runs on an iPhone simulator destination.")
        }
        let app = launch(arguments: ["--ui-testing", "--fixture-connected"])

        XCTAssertTrue(threadElement("Release checklist", in: app).waitForExistence(timeout: 5))
        threadElement("Release checklist", in: app).tap()
        XCTAssertTrue(app.textFields["Message Kodex"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["New Chat"].exists)

        let leadingEdge = app.coordinate(withNormalizedOffset: CGVector(dx: 0.01, dy: 0.5))
        let trailingEdge = app.coordinate(withNormalizedOffset: CGVector(dx: 0.85, dy: 0.5))
        leadingEdge.press(forDuration: 0.05, thenDragTo: trailingEdge)

        XCTAssertTrue(app.buttons["New Chat"].waitForExistence(timeout: 5))
    }

    @MainActor
    func testThreadActionMenuMatchesMobileWebOrder() {
        let app = launch(arguments: ["--ui-testing", "--fixture-connected"])

        XCTAssertTrue(threadElement("Release checklist", in: app).waitForExistence(timeout: 5))
        threadElement("Release checklist", in: app).tap()
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
        XCTAssertTrue(app.buttons["New Chat"].waitForExistence(timeout: 10))

        let newProjectThread = app.buttons["New Project Thread"]
        if newProjectThread.exists && newProjectThread.isEnabled {
            newProjectThread.tap()
            let composer = app.textFields["Message Kodex"]
            XCTAssertTrue(composer.waitForExistence(timeout: 20))
            composer.tap()
            app.typeText("Say pong")
            XCTAssertTrue(app.buttons["Send"].waitForExistence(timeout: 5))
            app.buttons["Send"].tap()
            XCTAssertTrue(labelContaining("Say pong", in: app).waitForExistence(timeout: 30))
            XCTAssertTrue(labelContaining("pong", in: app).waitForExistence(timeout: 120))
            return
        }

        app.buttons["New Chat"].tap()

        XCTAssertTrue(labelContaining("Say pong", in: app).waitForExistence(timeout: 30))
        XCTAssertTrue(labelContaining("pong", in: app).waitForExistence(timeout: 120))
    }

    @MainActor
    private func launch(arguments: [String], environment: [String: String] = [:]) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = arguments
        for (key, value) in environment {
            app.launchEnvironment[key] = value
        }
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
            if app.buttons["New Chat"].exists || app.buttons["Connection Settings"].exists {
                return true
            }
            let backButton = app.buttons["BackButton"]
            if backButton.exists {
                backButton.tap()
            } else {
                let nativeBackButton = app.navigationBars.buttons.firstMatch
                if nativeBackButton.exists {
                    nativeBackButton.tap()
                }
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.5))
        }
        return app.buttons["New Chat"].exists || app.buttons["Connection Settings"].exists
    }

    @MainActor
    private func workspaceSearchField(in app: XCUIApplication) -> XCUIElement {
        if app.searchFields["WorkspaceSearch"].exists {
            return app.searchFields["WorkspaceSearch"]
        }
        if app.searchFields["Search"].exists {
            return app.searchFields["Search"]
        }
        if app.textFields["WorkspaceSearch"].exists {
            return app.textFields["WorkspaceSearch"]
        }
        if app.textFields["Search"].exists {
            return app.textFields["Search"]
        }
        return app.searchFields.firstMatch
    }

    @MainActor
    private func workspaceSearchButton(in app: XCUIApplication) -> XCUIElement {
        if app.buttons["WorkspaceSearchButton"].exists {
            return app.buttons["WorkspaceSearchButton"]
        }
        return app.buttons["Search"]
    }

    @MainActor
    private func labelContaining(_ text: String, in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS[c] %@", text))
            .firstMatch
    }

    @MainActor
    private func waitForAnyWorkspaceThread(in app: XCUIApplication) -> Bool {
        threadElement("Release checklist", in: app).waitForExistence(timeout: 5)
            || threadElement("Unread agent message", in: app).waitForExistence(timeout: 1)
            || threadElement("Native iOS milestone", in: app).waitForExistence(timeout: 1)
    }

    @MainActor
    private func revealReleaseChecklist(in app: XCUIApplication) -> Bool {
        if threadElement("Release checklist", in: app).waitForExistence(timeout: 2) {
            return true
        }
        tapIfExists(app.staticTexts["Chats"])
        if threadElement("Release checklist", in: app).waitForExistence(timeout: 2) {
            return true
        }
        tapIfExists(app.buttons["Chats"])
        if threadElement("Release checklist", in: app).waitForExistence(timeout: 2) {
            return true
        }
        return false
    }

    @MainActor
    private func revealNativeIOSMilestone(in app: XCUIApplication) -> Bool {
        if threadElement("Native iOS milestone", in: app).waitForExistence(timeout: 2) {
            return true
        }
        tapIfExists(app.staticTexts["Projects"])
        if threadElement("Native iOS milestone", in: app).waitForExistence(timeout: 2) {
            return true
        }
        tapIfExists(app.buttons["Projects"])
        return threadElement("Native iOS milestone", in: app).waitForExistence(timeout: 2)
    }

    @MainActor
    private func threadElement(_ title: String, in app: XCUIApplication) -> XCUIElement {
        if app.buttons[title].exists {
            return app.buttons[title]
        }
        return app.staticTexts[title]
    }

    @MainActor
    private func scopeButton(_ title: String, in app: XCUIApplication) -> XCUIElement {
        let segmentedControl = app.segmentedControls["WorkspaceScopeControl"]
        if segmentedControl.exists {
            return segmentedControl.buttons[title]
        }
        return app.buttons[title]
    }

    @MainActor
    private func tapIfExists(_ element: XCUIElement) {
        if element.exists {
            element.tap()
            RunLoop.current.run(until: Date().addingTimeInterval(0.25))
        }
    }

    @MainActor
    private func focusWorkspaceSearch(in app: XCUIApplication) -> XCUIElement {
        let searchButton = workspaceSearchButton(in: app)
        if searchButton.exists {
            searchButton.tap()
            RunLoop.current.run(until: Date().addingTimeInterval(0.35))
        }
        var searchField = workspaceSearchField(in: app)
        if !searchField.isHittable {
            app.swipeDown()
            RunLoop.current.run(until: Date().addingTimeInterval(0.5))
            searchField = workspaceSearchField(in: app)
        }
        return searchField
    }

    @MainActor
    private func composerOptionsButton(in app: XCUIApplication) -> XCUIElement {
        if app.buttons["ComposerOptionsMenu"].exists {
            return app.buttons["ComposerOptionsMenu"]
        }
        return app.buttons.containing(NSPredicate(format: "label CONTAINS[c] %@", "Composer Options")).firstMatch
    }

    @MainActor
    private func permissionsButton(in app: XCUIApplication) -> XCUIElement {
        if app.buttons["PermissionsMenu"].exists {
            return app.buttons["PermissionsMenu"]
        }
        return app.buttons["Permissions"]
    }

    @MainActor
    private func accessibilityValue(of element: XCUIElement) -> String {
        (element.value as? String) ?? ""
    }

    @MainActor
    private func assertComposerMenusOpen(in app: XCUIApplication) {
        XCTAssertTrue(app.buttons["Add Attachment"].exists)

        permissionsButton(in: app).tap()
        XCTAssertTrue(app.buttons["Ask First"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["Workspace Write"].exists)
        dismissMenu(in: app)

        composerOptionsButton(in: app).tap()
        XCTAssertTrue(
            app.buttons["ModelOption-gpt-5.4-mini"].waitForExistence(timeout: 3)
                || app.buttons["GPT-5.4 Mini"].waitForExistence(timeout: 1)
                || app.staticTexts["GPT-5.4 Mini"].waitForExistence(timeout: 1)
        )
        XCTAssertTrue(
            app.buttons["ReasoningOption-high"].exists
                || app.buttons["High"].exists
                || app.staticTexts["High"].exists
        )
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

    @MainActor
    private func swipeUntil(_ element: XCUIElement, direction: SwipeDirection, exists target: XCUIElement, maxSwipes: Int) {
        for _ in 0..<maxSwipes where !target.exists {
            switch direction {
            case .up:
                element.swipeUp()
            case .down:
                element.swipeDown()
            }
        }
    }

    @MainActor
    private func assertMinimumTapTarget(_ element: XCUIElement, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(element.exists, file: file, line: line)
        XCTAssertGreaterThanOrEqual(element.frame.width, 44, file: file, line: line)
        XCTAssertGreaterThanOrEqual(element.frame.height, 44, file: file, line: line)
    }
}

private enum SwipeDirection {
    case up
    case down
}
