// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "KodexIOSWorkspace",
    platforms: [
        .macOS(.v14),
        .iOS(.v17)
    ],
    products: [
        .library(name: "KodexCore", targets: ["KodexCore"]),
        .library(name: "KodexAPI", targets: ["KodexAPI"])
    ],
    dependencies: [
        .package(url: "https://github.com/apple/swift-openapi-generator.git", from: "1.10.0"),
        .package(url: "https://github.com/apple/swift-openapi-runtime.git", from: "1.8.0"),
        .package(url: "https://github.com/apple/swift-openapi-urlsession.git", from: "1.0.0")
    ],
    targets: [
        .target(
            name: "KodexCore",
            path: "Sources/KodexCore"
        ),
        .target(
            name: "KodexAPI",
            dependencies: [
                "KodexCore",
                .product(name: "OpenAPIRuntime", package: "swift-openapi-runtime"),
                .product(name: "OpenAPIURLSession", package: "swift-openapi-urlsession")
            ],
            path: "Sources/KodexAPI",
            resources: [
                .copy("openapi.json"),
                .copy("openapi-generator-config.yaml")
            ]
        ),
        .testTarget(
            name: "KodexCoreTests",
            dependencies: ["KodexCore", "KodexAPI"],
            path: "Tests/KodexCoreTests"
        )
    ]
)
