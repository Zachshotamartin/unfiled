import Foundation

enum RoutingRuleConditionCanonicalizer {
    private static let space = Unicode.Scalar(0x20)!

    static func trimUnicodeWhitespace(_ value: String) -> String {
        var scalars = Array(value.unicodeScalars)
        while scalars.first?.properties.isWhitespace == true { scalars.removeFirst() }
        while scalars.last?.properties.isWhitespace == true { scalars.removeLast() }
        return string(from: scalars)
    }

    static func normalize(_ value: String) -> String {
        let folded = value
            .precomposedStringWithCompatibilityMapping
            .lowercased(with: Locale(identifier: "und"))
        var collapsed: [Unicode.Scalar] = []
        var pendingSpace = false

        for scalar in folded.unicodeScalars {
            if scalar.properties.isWhitespace {
                pendingSpace = !collapsed.isEmpty
            } else {
                if pendingSpace { collapsed.append(space) }
                collapsed.append(scalar)
                pendingSpace = false
            }
        }

        while let final = collapsed.last, final == space || isPunctuation(final) {
            collapsed.removeLast()
        }
        return string(from: collapsed)
    }

    static func isValidRequestCondition(_ value: String) -> Bool {
        guard value.utf16.count <= 500 else { return false }
        let canonical = normalize(value)
        return (1 ... 500).contains(canonical.utf16.count)
    }

    private static func isPunctuation(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.properties.generalCategory {
        case .connectorPunctuation, .dashPunctuation, .openPunctuation,
             .closePunctuation, .initialPunctuation, .finalPunctuation,
             .otherPunctuation:
            return true
        default:
            return false
        }
    }

    private static func string(from scalars: [Unicode.Scalar]) -> String {
        scalars.map { String($0) }.joined()
    }
}

struct RoutingRuleCollection: Equatable, Sendable {
    private(set) var items: [RoutingRule] = []

    mutating func replace(with authoritativeItems: [RoutingRule]) {
        let currentByID = Dictionary(uniqueKeysWithValues: items.map { ($0.id, $0) })
        items = Self.sorted(authoritativeItems.map { authoritative in
            guard let current = currentByID[authoritative.id],
                  current.revision > authoritative.revision else { return authoritative }
            return current
        })
    }

    mutating func upsert(_ rule: RoutingRule) {
        if let current = items.first(where: { $0.id == rule.id }),
           current.revision >= rule.revision { return }
        items.removeAll { $0.id == rule.id }
        items.append(rule)
        items = Self.sorted(items)
    }

    mutating func remove(ruleID: RuleID) {
        items.removeAll { $0.id == ruleID }
    }

    private static func sorted(_ rules: [RoutingRule]) -> [RoutingRule] {
        rules.sorted {
            if $0.priority != $1.priority { return $0.priority > $1.priority }
            return $0.id.rawValue < $1.id.rawValue
        }
    }
}

enum RoutingRulePresentation {
    static func sourceLabel(for rule: RoutingRule) -> String {
        switch rule.source {
        case .explicit: "Explicit"
        case .correctionSuggested: "Learned"
        }
    }

    static func lastFiredLabel(
        for rule: RoutingRule,
        formatDate: (Date) -> String = {
            $0.formatted(date: .abbreviated, time: .shortened)
        }
    ) -> String {
        guard let lastFiredAt = rule.lastFiredAt else { return "Never fired" }
        return "Last fired \(formatDate(lastFiredAt))"
    }
}

struct RoutingRulePreviewPresentation: Equatable, Sendable {
    static let sectionLabel = "Local condition check"
    static let heading = "Preview which rule matches"
    static let actionTitle = "Check rule match"
    static let privacyDetail =
        "Rule conditions are checked in memory. This text is never sent, saved, or logged."
    static let limitation =
        "This local check does not confirm actual routing or destination eligibility"

    let title: String
    let details: [String]

    var accessibilityLabel: String {
        ([title] + details).joined(separator: ". ")
    }

    static let ready = RoutingRulePreviewPresentation(
        title: "Ready for a sample",
        details: ["Enter a jot above to compare it with current active rule conditions"]
    )

    static let noMatch = RoutingRulePreviewPresentation(
        title: "No rule condition matched",
        details: [
            "No current active rule condition matched this sample",
            limitation,
        ]
    )

    static func matched(
        rule: RoutingRule,
        destinationLabel: String
    ) -> RoutingRulePreviewPresentation {
        RoutingRulePreviewPresentation(
            title: "Rule condition matched locally",
            details: [
                "\(RoutingRulePresentation.sourceLabel(for: rule)) rule · \(rule.condition)",
                "Configured destination: \(destinationLabel)",
                limitation,
            ]
        )
    }
}

enum RoutingRulePreviewMatcher {
    static let maximumSampleCodePoints = 500
    private static let phraseWindowCodePoints = 80

    static func boundedSample(_ value: String) -> String {
        string(from: Array(value.unicodeScalars.prefix(maximumSampleCodePoints)))
    }

    static func match(sample: String, rules: [RoutingRule]) -> RoutingRule? {
        let capture = RoutingRuleConditionCanonicalizer.normalize(boundedSample(sample))
        return rules
            .filter(isEligible)
            .sorted { left, right in
                if left.priority != right.priority { return left.priority > right.priority }
                return left.id.rawValue < right.id.rawValue
            }
            .first { matches(capture: capture, rule: $0) }
    }

    private static func isEligible(_ rule: RoutingRule) -> Bool {
        guard rule.enabled, rule.destinationStatus == .active else { return false }
        switch rule.source {
        case .explicit:
            return rule.proposalState == nil
        case .correctionSuggested:
            return rule.proposalState == .accepted
        }
    }

    private static func matches(capture: String, rule: RoutingRule) -> Bool {
        let condition = RoutingRuleConditionCanonicalizer.normalize(rule.normalizedCondition)
        guard !condition.isEmpty else { return false }

        switch rule.ruleType {
        case .prefix:
            return capture.hasPrefix("\(condition):") || capture.hasPrefix("\(condition) ")
        case .phrase:
            let window = Array(capture.unicodeScalars.prefix(phraseWindowCodePoints))
            return containsWholePhrase(window, phrase: Array(condition.unicodeScalars))
        case .alias:
            let phrases = Set(
                [condition] + rule.aliases.map(RoutingRuleConditionCanonicalizer.normalize)
                    .filter { !$0.isEmpty }
            )
            let captureScalars = Array(capture.unicodeScalars)
            return phrases.contains {
                containsWholePhrase(captureScalars, phrase: Array($0.unicodeScalars))
            }
        case .destinationMention:
            return capture == "to \(condition)"
                || capture == "in \(condition)"
                || capture.hasSuffix(" to \(condition)")
                || capture.hasSuffix(" in \(condition)")
        }
    }

    private static func containsWholePhrase(
        _ value: [Unicode.Scalar],
        phrase: [Unicode.Scalar]
    ) -> Bool {
        guard !phrase.isEmpty, phrase.count <= value.count else { return false }
        let finalStart = value.count - phrase.count
        for start in 0 ... finalStart {
            let end = start + phrase.count
            guard value[start ..< end].elementsEqual(phrase) else { continue }
            let before = start == 0 ? nil : value[start - 1]
            let after = end == value.count ? nil : value[end]
            if !isWordCodePoint(before), !isWordCodePoint(after) { return true }
        }
        return false
    }

    private static func isWordCodePoint(_ scalar: Unicode.Scalar?) -> Bool {
        guard let scalar else { return false }
        if scalar == "'" || scalar == "’" { return true }
        switch scalar.properties.generalCategory {
        case .uppercaseLetter, .lowercaseLetter, .titlecaseLetter, .modifierLetter,
             .otherLetter, .decimalNumber, .letterNumber, .otherNumber,
             .nonspacingMark, .spacingMark, .enclosingMark, .connectorPunctuation:
            return true
        default:
            return false
        }
    }

    private static func string(from scalars: [Unicode.Scalar]) -> String {
        scalars.map { String($0) }.joined()
    }
}

struct RoutingRuleFormDraft: Equatable, Sendable {
    private struct EditableSnapshot: Equatable, Sendable {
        let enabled: Bool
        let ruleType: RoutingRuleType
        let condition: String
        let destination: RoutingRuleDestination
        let priority: Int
    }

    let existingRuleID: RuleID?
    let expectedRevision: Int?
    let source: RoutingRuleSource
    let proposalState: RoutingRuleProposalState?
    let unavailableDestinationStatus: RoutingRuleDestinationStatus?
    private let original: EditableSnapshot?

    var enabled: Bool
    var ruleType: RoutingRuleType
    var condition: String
    var destination: RoutingRuleDestination?
    var priority: Int

    init() {
        existingRuleID = nil
        expectedRevision = nil
        source = .explicit
        proposalState = nil
        unavailableDestinationStatus = nil
        original = nil
        enabled = true
        ruleType = .prefix
        condition = ""
        destination = nil
        priority = 100
    }

    init(rule: RoutingRule) {
        existingRuleID = rule.id
        expectedRevision = rule.revision
        source = rule.source
        proposalState = rule.proposalState
        unavailableDestinationStatus = rule.destinationStatus == .active
            ? nil
            : rule.destinationStatus
        original = EditableSnapshot(
            enabled: rule.enabled,
            ruleType: rule.ruleType,
            condition: rule.condition,
            destination: rule.destination,
            priority: rule.priority
        )
        enabled = rule.proposalState == .offered ? false : rule.enabled
        ruleType = rule.ruleType
        condition = rule.condition
        destination = rule.destinationStatus == .active ? rule.destination : nil
        priority = rule.priority
    }

    var normalizedCondition: String {
        RoutingRuleConditionCanonicalizer.trimUnicodeWhitespace(condition)
    }

    var isOfferedProposal: Bool {
        source == .correctionSuggested && proposalState == .offered
    }

    var canSave: Bool {
        guard !isOfferedProposal,
              RoutingRuleConditionCanonicalizer.isValidRequestCondition(condition),
              destination != nil,
              (0 ... 10_000).contains(priority) else { return false }
        if existingRuleID != nil { return hasChanges }
        return true
    }

    var hasChanges: Bool {
        guard !isOfferedProposal else { return false }
        guard let original, let destination else { return existingRuleID != nil }
        return original != EditableSnapshot(
            enabled: enabled,
            ruleType: ruleType,
            condition: normalizedCondition,
            destination: destination,
            priority: priority
        )
    }

    func createRequest(idempotencyKey: String) throws -> RoutingRuleCreateRequest {
        guard existingRuleID == nil, let destination else {
            throw DomainValidationError.invalidValue("A destination is required")
        }
        return try RoutingRuleCreateRequest(
            idempotencyKey: idempotencyKey,
            enabled: enabled,
            ruleType: ruleType,
            condition: normalizedCondition,
            destination: destination,
            priority: priority
        )
    }

    func updateRequest(
        idempotencyKey: String,
        expectedRevision revisionOverride: Int? = nil
    ) throws -> RoutingRuleUpdateRequest {
        guard !isOfferedProposal,
              let expectedRevision,
              let original,
              let destination else {
            throw DomainValidationError.invalidValue("An editable routing rule is required")
        }
        return try RoutingRuleUpdateRequest(
            expectedRevision: revisionOverride ?? expectedRevision,
            idempotencyKey: idempotencyKey,
            enabled: original.enabled == enabled ? nil : enabled,
            ruleType: original.ruleType == ruleType ? nil : ruleType,
            condition: original.condition == normalizedCondition ? nil : normalizedCondition,
            destination: original.destination == destination ? nil : destination,
            priority: original.priority == priority ? nil : priority
        )
    }
}

enum RoutingRuleAccessibilityIdentifier {
    static let settingsLink = "settings.routingRules"
    static let screen = "routingRules.screen"
    static let create = "routingRules.create"
    static let empty = "routingRules.empty"
    static let loading = "routingRules.loading"
    static let error = "routingRules.error"
    static let previewSample = "routingRules.preview.sample"
    static let previewAction = "routingRules.preview.action"
    static let previewResult = "routingRules.preview.result"
    static let editorCondition = "routingRules.editor.condition"
    static let editorType = "routingRules.editor.type"
    static let editorDestinationKind = "routingRules.editor.destinationKind"
    static let editorDestination = "routingRules.editor.destination"
    static let editorPriority = "routingRules.editor.priority"
    static let editorEnabled = "routingRules.editor.enabled"
    static let editorSave = "routingRules.editor.save"

    static func row(_ ruleID: String) -> String { "routingRules.row.\(ruleID)" }
    static func edit(_ ruleID: String) -> String { "routingRules.edit.\(ruleID)" }
    static func toggle(_ ruleID: String) -> String { "routingRules.toggle.\(ruleID)" }
    static func accept(_ ruleID: String) -> String { "routingRules.accept.\(ruleID)" }
    static func decline(_ ruleID: String) -> String { "routingRules.decline.\(ruleID)" }
    static func delete(_ ruleID: String) -> String { "routingRules.delete.\(ruleID)" }
}
