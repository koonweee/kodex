import Foundation

public struct GatewayConnectionChecker: Sendable {
    private let probe: GatewayProbe

    public init(probe: GatewayProbe) {
        self.probe = probe
    }

    public func check(userInput: String) async -> GatewayConnectionStatus {
        do {
            let configuration = try GatewayConfiguration(userInput: userInput)
            let readiness = await probe.check(configuration)
            switch readiness {
            case .connected:
                return .connected(baseURL: configuration.baseURL.absoluteString)
            case .degraded(let message):
                return .degraded(message: message)
            case .offline(let message):
                return .offline(message: message)
            }
        } catch GatewayConfigurationError.unsupportedScheme {
            return .invalidURL(message: "Use an http or https gateway URL.")
        } catch GatewayConfigurationError.missingHost {
            return .invalidURL(message: "Gateway URL needs a host.")
        } catch {
            return .invalidURL(message: "Gateway URL is invalid.")
        }
    }
}

public enum GatewayConnectionStatus: Equatable, Sendable {
    case connected(baseURL: String)
    case degraded(message: String)
    case offline(message: String)
    case invalidURL(message: String)

    public var displayText: String {
        switch self {
        case .connected(let baseURL):
            return "Connected to \(baseURL)"
        case .degraded(let message):
            return "Gateway degraded: \(message)"
        case .offline(let message):
            return "Gateway offline: \(message)"
        case .invalidURL(let message):
            return message
        }
    }

    public var canLoadLiveWorkspace: Bool {
        switch self {
        case .connected:
            return true
        case .degraded, .offline, .invalidURL:
            return false
        }
    }
}

public struct SkillMention: Equatable, Sendable {
    public let name: String
    public let path: String
    public let range: Range<String.Index>

    public init(name: String, path: String, range: Range<String.Index>) {
        self.name = name
        self.path = path
        self.range = range
    }
}

public struct ComposerRunSettings: Equatable, Sendable {
    public var model: String?
    public var effort: String?
    public var serviceTier: String?
    public var approvalPolicy: String?
    public var sandboxPolicy: AnySendable?

    public init(model: String? = nil, effort: String? = nil, serviceTier: String? = nil, approvalPolicy: String? = nil, sandboxPolicy: AnySendable? = nil) {
        self.model = model
        self.effort = effort
        self.serviceTier = serviceTier
        self.approvalPolicy = approvalPolicy
        self.sandboxPolicy = sandboxPolicy
    }

    public var gatewayPayload: [String: AnySendable] {
        var payload: [String: AnySendable] = [:]
        if let model {
            payload["model"] = .string(model)
        }
        if let effort {
            payload["effort"] = .string(effort)
        }
        if let serviceTier {
            payload["serviceTier"] = .string(serviceTier)
        }
        if let approvalPolicy {
            payload["approvalPolicy"] = .string(approvalPolicy)
        }
        if let sandboxPolicy {
            payload["sandboxPolicy"] = sandboxPolicy
        }
        return payload
    }

    public func with(model: String? = nil, effort: String? = nil, serviceTier: String? = nil, approvalPolicy: String? = nil, sandboxPolicy: AnySendable? = nil) -> ComposerRunSettings {
        ComposerRunSettings(
            model: model ?? self.model,
            effort: effort ?? self.effort,
            serviceTier: serviceTier ?? self.serviceTier,
            approvalPolicy: approvalPolicy ?? self.approvalPolicy,
            sandboxPolicy: sandboxPolicy ?? self.sandboxPolicy
        )
    }

    public var sandboxDisplay: String {
        guard let sandboxPolicy else {
            return "default"
        }
        switch sandboxPolicy {
        case .object(let object):
            if case .string(let type)? = object["type"] {
                return type
            }
            return "custom"
        case .string(let value):
            return value
        default:
            return "custom"
        }
    }
}

public enum SkillMentionDetector {
    public static func mentions(in text: String, skills: [SkillCatalogEntry]) -> [SkillMention] {
        skills.flatMap { skill in
            mentionRanges(for: "$\(skill.name)", in: text).map {
                SkillMention(name: skill.name, path: skill.path, range: $0)
            }
        }
        .sorted { $0.range.lowerBound < $1.range.lowerBound }
    }

    private static func mentionRanges(for mention: String, in text: String) -> [Range<String.Index>] {
        var ranges: [Range<String.Index>] = []
        var searchStart = text.startIndex
        while searchStart < text.endIndex, let range = text.range(of: mention, range: searchStart..<text.endIndex) {
            let lowerIsBoundary = range.lowerBound == text.startIndex || text[text.index(before: range.lowerBound)].isWhitespace
            let upperIsBoundary = range.upperBound == text.endIndex || !text[range.upperBound].isLetter && !text[range.upperBound].isNumber && text[range.upperBound] != "_"
            if lowerIsBoundary && upperIsBoundary {
                ranges.append(range)
            }
            searchStart = range.upperBound
        }
        return ranges
    }
}

public struct SkillCatalogEntry: Equatable, Sendable {
    public let name: String
    public let path: String

    public init(name: String, path: String) {
        self.name = name
        self.path = path
    }
}

public struct ByteRange: Codable, Equatable, Sendable {
    public let start: Int
    public let end: Int

    public init(start: Int, end: Int) {
        self.start = start
        self.end = end
    }
}

public enum ComposerInput: Equatable, Sendable {
    case text(String, textElements: [ByteRange])
    case localImage(path: String)
    case image(url: String)
    case skill(name: String, path: String)

    public var gatewayPayload: [String: AnySendable] {
        switch self {
        case .text(let text, let elements):
            var payload: [String: AnySendable] = ["type": .string("text"), "text": .string(text)]
            if !elements.isEmpty {
                payload["text_elements"] = .array(elements.map { .object(["byteRange": .object(["start": .int($0.start), "end": .int($0.end)])]) })
            }
            return payload
        case .localImage(let path):
            return ["type": .string("localImage"), "path": .string(path)]
        case .image(let url):
            return ["type": .string("image"), "url": .string(url)]
        case .skill(let name, let path):
            return ["type": .string("skill"), "name": .string(name), "path": .string(path)]
        }
    }
}

public enum ComposerPayloadBuilder {
    public static func byteRange(for range: Range<String.Index>, in text: String) -> ByteRange {
        let start = text[..<range.lowerBound].utf8.count
        let end = text[..<range.upperBound].utf8.count
        return ByteRange(start: start, end: end)
    }

    public static func inputs(text: String, skillMentions: [SkillMention], localImagePaths: [String] = []) -> [ComposerInput] {
        var inputs: [ComposerInput] = []
        let textElements = skillMentions.map { byteRange(for: $0.range, in: text) }
        if !text.isEmpty {
            inputs.append(.text(text, textElements: textElements))
        }
        inputs.append(contentsOf: skillMentions.map { .skill(name: $0.name, path: $0.path) })
        inputs.append(contentsOf: localImagePaths.map { .localImage(path: $0) })
        return inputs
    }

    public static func turnStartPayload(text: String, skillMentions: [SkillMention] = [], localImagePaths: [String] = [], settings: ComposerRunSettings = ComposerRunSettings()) -> AnySendable {
        var payload = settings.gatewayPayload
        payload["input"] = .array(inputs(text: text, skillMentions: skillMentions, localImagePaths: localImagePaths).map { .object($0.gatewayPayload) })
        return .object(payload)
    }
}

public enum UploadRouteMapper {
    public static func routeForImageUpload() -> GatewayRoute {
        .imageUploads
    }

    public static func input(forUploadedLocalPath path: String) -> ComposerInput {
        .localImage(path: path)
    }
}

public struct ApprovalRequest: Identifiable, Codable, Equatable, Sendable {
    public let id: String
    public let threadId: String
    public let title: String
    public let risk: String
    public let context: String

    public init(id: String, threadId: String, title: String, risk: String, context: String = "") {
        self.id = id
        self.threadId = threadId
        self.title = title
        self.risk = risk
        self.context = context
    }
}

public enum ApprovalDecision: Equatable, Sendable {
    case accept
    case decline
    case acceptForSession
    case cancel

    public var gatewayValue: String {
        switch self {
        case .accept:
            return "accept"
        case .decline:
            return "decline"
        case .acceptForSession:
            return "acceptForSession"
        case .cancel:
            return "cancel"
        }
    }
}

public enum ApprovalDecisionPayloadBuilder {
    public static func payload(for decision: ApprovalDecision) -> AnySendable {
        .object(["decision": .object(["decision": .string(decision.gatewayValue)])])
    }

    public static func route(approvalId: String) -> GatewayRoute {
        .approvalDecision(approvalId)
    }
}

public enum ApprovalRiskPolicy {
    public static func requiresConfirmation(_ approval: ApprovalRequest, decision: ApprovalDecision) -> Bool {
        guard decision == .accept || decision == .acceptForSession else {
            return false
        }
        let risk = approval.risk.lowercased()
        if ["medium", "high", "critical", "dangerous"].contains(risk) {
            return true
        }
        let searchable = "\(approval.title) \(approval.context)".lowercased()
        return ["rm ", "delete", "reset", "checkout", "clean", "chmod", "chown", "sudo", "danger", "write", "filechange", "permissions"].contains { searchable.contains($0) }
    }
}

public enum AnySendable: Equatable, Sendable, Codable {
    case string(String)
    case int(Int)
    case double(Double)
    case bool(Bool)
    case array([AnySendable])
    case object([String: AnySendable])
    case null

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let bool = try? container.decode(Bool.self) {
            self = .bool(bool)
        } else if let int = try? container.decode(Int.self) {
            self = .int(int)
        } else if let double = try? container.decode(Double.self) {
            self = .double(double)
        } else if let string = try? container.decode(String.self) {
            self = .string(string)
        } else if let array = try? container.decode([AnySendable].self) {
            self = .array(array)
        } else {
            self = .object(try container.decode([String: AnySendable].self))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value):
            try container.encode(value)
        case .int(let value):
            try container.encode(value)
        case .double(let value):
            try container.encode(value)
        case .bool(let value):
            try container.encode(value)
        case .array(let value):
            try container.encode(value)
        case .object(let value):
            try container.encode(value)
        case .null:
            try container.encodeNil()
        }
    }

    public func flatStringValues(preferredKeys: [String] = []) -> [String] {
        switch self {
        case .string(let value):
            return value.isEmpty ? [] : [value]
        case .int(let value):
            return [String(value)]
        case .double(let value):
            return [String(value)]
        case .bool(let value):
            return [String(value)]
        case .array(let values):
            return values.flatMap { $0.flatStringValues(preferredKeys: preferredKeys) }
        case .object(let object):
            let preferred = preferredKeys.compactMap { object[$0] }.flatMap { $0.flatStringValues(preferredKeys: preferredKeys) }
            let rest = object
                .filter { !preferredKeys.contains($0.key) }
                .sorted { $0.key < $1.key }
                .flatMap { $0.value.flatStringValues(preferredKeys: preferredKeys) }
            return preferred + rest
        case .null:
            return []
        }
    }
}
