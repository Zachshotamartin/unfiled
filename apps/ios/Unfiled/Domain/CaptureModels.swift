import Foundation

public enum CaptureSource: String, Codable, CaseIterable, Sendable {
    case mobile, web, shareSheet = "share_sheet", `import`
    case iosLockScreenWidget = "ios_lock_screen_widget"
}

public enum CaptureProcessingState: String, Codable, CaseIterable, Sendable {
    case queued, processing, done, needsReview = "needs_review", failed, inbox
}

public struct CaptureCreateRequest: Codable, Equatable, Sendable {
    public let clientCaptureId: CaptureID
    public let rawContent: String
    public let source: CaptureSource
    public let deviceId: String?
    public let clientCreatedAt: Date
    public let clientTimezone: String
    public let privacy: PrivacyMode
    public let explicitDestinationNoteId: NoteID?
    public let expansionDisabled: Bool

    public init(clientCaptureId: CaptureID, rawContent: String, source: CaptureSource,
                deviceId: String? = nil, clientCreatedAt: Date, clientTimezone: String,
                privacy: PrivacyMode = .aiAssisted, explicitDestinationNoteId: NoteID? = nil,
                expansionDisabled: Bool = false) {
        self.clientCaptureId = clientCaptureId; self.rawContent = rawContent; self.source = source
        self.deviceId = deviceId; self.clientCreatedAt = clientCreatedAt
        self.clientTimezone = clientTimezone; self.privacy = privacy
        self.explicitDestinationNoteId = explicitDestinationNoteId
        self.expansionDisabled = expansionDisabled
    }
}

public struct Capture: Codable, Equatable, Sendable {
    public let id: CaptureID; public let rawContent: String; public let source: CaptureSource
    public let deviceId: String; public let privacy: PrivacyMode
    @RequiredNullable public var explicitDestinationNoteId: NoteID?; public let expansionDisabled: Bool
    public let clientCreatedAt: Date; public let clientTimezone: String; public let receivedAt: Date
    public let status: CaptureProcessingState; @RequiredNullable public var lastErrorCode: APIErrorCode?

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case id, rawContent, source, deviceId, privacy, explicitDestinationNoteId
        case expansionDisabled, clientCreatedAt, clientTimezone, receivedAt, status, lastErrorCode
    }

    public init(from decoder: Decoder) throws {
        try StrictJSONKey.requireExactKeys(CodingKeys.allCases.map(\.rawValue), from: decoder)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(CaptureID.self, forKey: .id)
        rawContent = try container.decode(String.self, forKey: .rawContent)
        source = try container.decode(CaptureSource.self, forKey: .source)
        deviceId = try container.decode(String.self, forKey: .deviceId)
        privacy = try container.decode(PrivacyMode.self, forKey: .privacy)
        _explicitDestinationNoteId = try container.decode(
            RequiredNullable<NoteID>.self,
            forKey: .explicitDestinationNoteId
        )
        expansionDisabled = try container.decode(Bool.self, forKey: .expansionDisabled)
        clientCreatedAt = try container.decode(Date.self, forKey: .clientCreatedAt)
        clientTimezone = try container.decode(String.self, forKey: .clientTimezone)
        receivedAt = try container.decode(Date.self, forKey: .receivedAt)
        status = try container.decode(CaptureProcessingState.self, forKey: .status)
        _lastErrorCode = try container.decode(
            RequiredNullable<APIErrorCode>.self,
            forKey: .lastErrorCode
        )
        guard (1 ... 10_000).contains(rawContent.utf16.count),
              !rawContent.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              deviceId.utf16.count <= 120,
              (1 ... 100).contains(clientTimezone.utf16.count) else {
            throw DecodingError.dataCorruptedError(
                forKey: .rawContent,
                in: container,
                debugDescription: "Capture response violates contract bounds"
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(rawContent, forKey: .rawContent)
        try container.encode(source, forKey: .source)
        try container.encode(deviceId, forKey: .deviceId)
        try container.encode(privacy, forKey: .privacy)
        try container.encode(_explicitDestinationNoteId, forKey: .explicitDestinationNoteId)
        try container.encode(expansionDisabled, forKey: .expansionDisabled)
        try container.encode(clientCreatedAt, forKey: .clientCreatedAt)
        try container.encode(clientTimezone, forKey: .clientTimezone)
        try container.encode(receivedAt, forKey: .receivedAt)
        try container.encode(status, forKey: .status)
        try container.encode(_lastErrorCode, forKey: .lastErrorCode)
    }
}

public struct CaptureSummary: Codable, Equatable, Sendable {
    public let id: CaptureID; public let jobId: JobID; public let rawContentPreview: String
    public let source: CaptureSource; public let privacy: PrivacyMode; public let clientCreatedAt: Date
    public let receivedAt: Date; public let status: CaptureProcessingState
    @RequiredNullable public var lastErrorCode: APIErrorCode?; public let receiptAvailable: Bool

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case id, jobId, rawContentPreview, source, privacy, clientCreatedAt, receivedAt
        case status, lastErrorCode, receiptAvailable
    }

    public init(from decoder: Decoder) throws {
        try StrictJSONKey.requireExactKeys(CodingKeys.allCases.map(\.rawValue), from: decoder)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(CaptureID.self, forKey: .id)
        jobId = try container.decode(JobID.self, forKey: .jobId)
        rawContentPreview = try container.decode(String.self, forKey: .rawContentPreview)
        source = try container.decode(CaptureSource.self, forKey: .source)
        privacy = try container.decode(PrivacyMode.self, forKey: .privacy)
        clientCreatedAt = try container.decode(Date.self, forKey: .clientCreatedAt)
        receivedAt = try container.decode(Date.self, forKey: .receivedAt)
        status = try container.decode(CaptureProcessingState.self, forKey: .status)
        _lastErrorCode = try container.decode(
            RequiredNullable<APIErrorCode>.self,
            forKey: .lastErrorCode
        )
        receiptAvailable = try container.decode(Bool.self, forKey: .receiptAvailable)
        let terminal = status != .queued && status != .processing
        guard (1 ... 280).contains(rawContentPreview.utf16.count),
              !rawContentPreview.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              receiptAvailable == terminal else {
            throw DecodingError.dataCorruptedError(
                forKey: .receiptAvailable,
                in: container,
                debugDescription: "Capture summary violates the API contract"
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(jobId, forKey: .jobId)
        try container.encode(rawContentPreview, forKey: .rawContentPreview)
        try container.encode(source, forKey: .source)
        try container.encode(privacy, forKey: .privacy)
        try container.encode(clientCreatedAt, forKey: .clientCreatedAt)
        try container.encode(receivedAt, forKey: .receivedAt)
        try container.encode(status, forKey: .status)
        try container.encode(_lastErrorCode, forKey: .lastErrorCode)
        try container.encode(receiptAvailable, forKey: .receiptAvailable)
    }
}

public struct CaptureListResponse: Codable, Equatable, Sendable {
    public let items: [CaptureSummary]; public let pageInfo: PageInfo

    private enum CodingKeys: String, CodingKey, CaseIterable { case items, pageInfo }
    public init(from decoder: Decoder) throws {
        try StrictJSONKey.requireExactKeys(CodingKeys.allCases.map(\.rawValue), from: decoder)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        items = try container.decode([CaptureSummary].self, forKey: .items)
        pageInfo = try container.decode(PageInfo.self, forKey: .pageInfo)
    }
}

public struct CaptureListQuery: Equatable, Sendable {
    public let cursor: String?; public let limit: Int; public let status: CaptureProcessingState?
    public let from: Date?; public let to: Date?
    public init(cursor: String? = nil, limit: Int = 30, status: CaptureProcessingState? = nil,
                from: Date? = nil, to: Date? = nil) {
        self.cursor = cursor; self.limit = limit; self.status = status; self.from = from; self.to = to
    }
}

public enum CaptureReceiptOutcome: String, Codable, CaseIterable, Sendable {
    case createdNote = "created_note", addedToNote = "added_to_note"
    case keptInInbox = "kept_in_inbox", needsReview = "needs_review", failed
}

public struct CaptureReceiptDestination: Codable, Equatable, Sendable {
    public let noteId: NoteID; public let title: String

    private enum CodingKeys: String, CodingKey, CaseIterable { case noteId, title }
    public init(from decoder: Decoder) throws {
        try StrictJSONKey.requireExactKeys(CodingKeys.allCases.map(\.rawValue), from: decoder)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        noteId = try container.decode(NoteID.self, forKey: .noteId)
        title = try container.decode(String.self, forKey: .title)
        guard (1 ... 200).contains(title.utf16.count) else {
            throw DecodingError.dataCorruptedError(
                forKey: .title,
                in: container,
                debugDescription: "Receipt destination title violates the API contract"
            )
        }
    }
}

public enum CapturedItemID: Codable, Equatable, Sendable {
    case item(ItemID), entry(EntryID)
    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        if let id = ItemID(rawValue: raw) { self = .item(id) }
        else if let id = EntryID(rawValue: raw) { self = .entry(id) }
        else { throw EntityIdentifierError.invalidIdentifier }
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self { case let .item(id): try c.encode(id); case let .entry(id): try c.encode(id) }
    }
}

public enum CaptureReceiptContent: Codable, Equatable, Sendable {
    case captured(itemId: CapturedItemID?, content: String)
    case aiGenerated(blockId: BlockID, content: String)
    private enum Keys: String, CodingKey { case type, itemId, blockId, content }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        switch try c.decode(String.self, forKey: .type) {
        case "captured":
            try StrictJSONKey.requireExactKeys(["type", "itemId", "content"], from: decoder)
            let content = try c.decode(String.self, forKey: .content)
            guard (1 ... 10_000).contains(content.utf16.count),
                  !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                throw DecodingError.dataCorruptedError(
                    forKey: .content,
                    in: c,
                    debugDescription: "Captured receipt content violates the API contract"
                )
            }
            self = .captured(
                itemId: try c.decodeIfPresent(CapturedItemID.self, forKey: .itemId),
                content: content
            )
        case "ai_generated":
            try StrictJSONKey.requireExactKeys(["type", "blockId", "content"], from: decoder)
            let content = try c.decode(String.self, forKey: .content)
            guard (1 ... 600).contains(content.utf16.count) else {
                throw DecodingError.dataCorruptedError(
                    forKey: .content,
                    in: c,
                    debugDescription: "Generated receipt content violates the API contract"
                )
            }
            self = .aiGenerated(
                blockId: try c.decode(BlockID.self, forKey: .blockId),
                content: content
            )
        default: throw DecodingError.dataCorruptedError(forKey: .type, in: c, debugDescription: "Unknown receipt content")
        }
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        switch self {
        case let .captured(itemId, content):
            try c.encode("captured", forKey: .type); try c.encodeIfPresent(itemId, forKey: .itemId); if itemId == nil { try c.encodeNil(forKey: .itemId) }; try c.encode(content, forKey: .content)
        case let .aiGenerated(blockId, content):
            try c.encode("ai_generated", forKey: .type); try c.encode(blockId, forKey: .blockId); try c.encode(content, forKey: .content)
        }
    }
}

public enum CaptureReceiptAction: Codable, Equatable, Sendable {
    case open(noteId: NoteID)
    case move(noteId: NoteID, decisionId: DecisionID)
    case undo(mutationId: MutationID, expectedRevision: Int)
    private enum Keys: String, CodingKey { case type, noteId, decisionId, mutationId, expectedRevision }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        switch try c.decode(String.self, forKey: .type) {
        case "open":
            try StrictJSONKey.requireExactKeys(["type", "noteId"], from: decoder)
            self = .open(noteId: try c.decode(NoteID.self, forKey: .noteId))
        case "move":
            try StrictJSONKey.requireExactKeys(["type", "noteId", "decisionId"], from: decoder)
            self = .move(
                noteId: try c.decode(NoteID.self, forKey: .noteId),
                decisionId: try c.decode(DecisionID.self, forKey: .decisionId)
            )
        case "undo":
            try StrictJSONKey.requireExactKeys(
                ["type", "mutationId", "expectedRevision"],
                from: decoder
            )
            let revision = try c.decode(Int.self, forKey: .expectedRevision)
            guard revision > 0 else {
                throw DecodingError.dataCorruptedError(
                    forKey: .expectedRevision,
                    in: c,
                    debugDescription: "Expected revision must be positive"
                )
            }
            self = .undo(
                mutationId: try c.decode(MutationID.self, forKey: .mutationId),
                expectedRevision: revision
            )
        default: throw DecodingError.dataCorruptedError(forKey: .type, in: c, debugDescription: "Unknown receipt action")
        }
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        switch self {
        case let .open(noteId): try c.encode("open", forKey: .type); try c.encode(noteId, forKey: .noteId)
        case let .move(noteId, decisionId): try c.encode("move", forKey: .type); try c.encode(noteId, forKey: .noteId); try c.encode(decisionId, forKey: .decisionId)
        case let .undo(mutationId, revision): try c.encode("undo", forKey: .type); try c.encode(mutationId, forKey: .mutationId); try c.encode(revision, forKey: .expectedRevision)
        }
    }
}

public struct CaptureReceipt: Codable, Equatable, Sendable {
    public let schemaVersion: Int; public let captureId: CaptureID; public let jobId: JobID
    @RequiredNullable public var decisionId: DecisionID?; @RequiredNullable public var reviewItemId: ReviewID?; @RequiredNullable public var mutationId: MutationID?
    public let outcome: CaptureReceiptOutcome; public let headline: String
    @RequiredNullable public var destination: CaptureReceiptDestination?; public let insertedContent: [CaptureReceiptContent]
    public let actions: [CaptureReceiptAction]; public let reasonCodes: [String]; public let createdAt: Date

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case schemaVersion, captureId, jobId, decisionId, reviewItemId, mutationId, outcome
        case headline, destination, insertedContent, actions, reasonCodes, createdAt
    }

    public init(from decoder: Decoder) throws {
        try StrictJSONKey.requireExactKeys(CodingKeys.allCases.map(\.rawValue), from: decoder)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        schemaVersion = try container.decode(Int.self, forKey: .schemaVersion)
        captureId = try container.decode(CaptureID.self, forKey: .captureId)
        jobId = try container.decode(JobID.self, forKey: .jobId)
        _decisionId = try container.decode(RequiredNullable<DecisionID>.self, forKey: .decisionId)
        _reviewItemId = try container.decode(RequiredNullable<ReviewID>.self, forKey: .reviewItemId)
        _mutationId = try container.decode(RequiredNullable<MutationID>.self, forKey: .mutationId)
        outcome = try container.decode(CaptureReceiptOutcome.self, forKey: .outcome)
        headline = try container.decode(String.self, forKey: .headline)
        _destination = try container.decode(
            RequiredNullable<CaptureReceiptDestination>.self,
            forKey: .destination
        )
        insertedContent = try container.decode([CaptureReceiptContent].self, forKey: .insertedContent)
        actions = try container.decode([CaptureReceiptAction].self, forKey: .actions)
        reasonCodes = try container.decode([String].self, forKey: .reasonCodes)
        createdAt = try container.decode(Date.self, forKey: .createdAt)

        guard schemaVersion == 1,
              (1 ... 240).contains(headline.utf16.count),
              insertedContent.count <= 500,
              actions.count <= 3,
              reasonCodes.count <= 20,
              reasonCodes.allSatisfy(Self.isValidReasonCode),
              Self.actionsAreBound(
                  actions,
                  destination: destination,
                  decisionId: decisionId,
                  mutationId: mutationId
              ),
              Self.effectsMatchOutcome(
                  outcome,
                  decisionId: decisionId,
                  reviewItemId: reviewItemId,
                  mutationId: mutationId,
                  destination: destination,
                  insertedContent: insertedContent,
                  actions: actions
              ) else {
            throw DecodingError.dataCorruptedError(
                forKey: .outcome,
                in: container,
                debugDescription: "Capture receipt violates the API contract"
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(schemaVersion, forKey: .schemaVersion)
        try container.encode(captureId, forKey: .captureId)
        try container.encode(jobId, forKey: .jobId)
        try container.encode(_decisionId, forKey: .decisionId)
        try container.encode(_reviewItemId, forKey: .reviewItemId)
        try container.encode(_mutationId, forKey: .mutationId)
        try container.encode(outcome, forKey: .outcome)
        try container.encode(headline, forKey: .headline)
        try container.encode(_destination, forKey: .destination)
        try container.encode(insertedContent, forKey: .insertedContent)
        try container.encode(actions, forKey: .actions)
        try container.encode(reasonCodes, forKey: .reasonCodes)
        try container.encode(createdAt, forKey: .createdAt)
    }

    private static func isValidReasonCode(_ value: String) -> Bool {
        guard (1 ... 64).contains(value.utf16.count),
              let first = value.utf8.first,
              (97 ... 122).contains(first) else { return false }
        return value.utf8.dropFirst().allSatisfy {
            (97 ... 122).contains($0) || (48 ... 57).contains($0) || $0 == 95
        }
    }

    private static func actionsAreBound(
        _ actions: [CaptureReceiptAction],
        destination: CaptureReceiptDestination?,
        decisionId: DecisionID?,
        mutationId: MutationID?
    ) -> Bool {
        var types = Set<String>()
        for action in actions {
            switch action {
            case let .open(noteId):
                guard types.insert("open").inserted, noteId == destination?.noteId else { return false }
            case let .move(noteId, actionDecisionId):
                guard types.insert("move").inserted,
                      noteId == destination?.noteId,
                      actionDecisionId == decisionId else { return false }
            case let .undo(actionMutationId, _):
                guard types.insert("undo").inserted,
                      actionMutationId == mutationId else { return false }
            }
        }
        return true
    }

    private static func effectsMatchOutcome(
        _ outcome: CaptureReceiptOutcome,
        decisionId: DecisionID?,
        reviewItemId: ReviewID?,
        mutationId: MutationID?,
        destination: CaptureReceiptDestination?,
        insertedContent: [CaptureReceiptContent],
        actions: [CaptureReceiptAction]
    ) -> Bool {
        switch outcome {
        case .createdNote, .addedToNote:
            return destination != nil && mutationId != nil && decisionId != nil && !insertedContent.isEmpty
        case .needsReview:
            return reviewItemId != nil && destination == nil && mutationId == nil &&
                insertedContent.isEmpty && actions.isEmpty
        case .keptInInbox, .failed:
            return destination == nil && mutationId == nil && insertedContent.isEmpty && actions.isEmpty
        }
    }
}

public struct CaptureDetail: Codable, Equatable, Sendable {
    public let id: CaptureID; public let rawContent: String; public let source: CaptureSource
    public let deviceId: String; public let privacy: PrivacyMode
    @RequiredNullable public var explicitDestinationNoteId: NoteID?; public let expansionDisabled: Bool
    public let clientCreatedAt: Date; public let clientTimezone: String; public let receivedAt: Date
    public let status: CaptureProcessingState; @RequiredNullable public var lastErrorCode: APIErrorCode?
    public let jobId: JobID; @RequiredNullable public var receipt: CaptureReceipt?

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case id, rawContent, source, deviceId, privacy, explicitDestinationNoteId
        case expansionDisabled, clientCreatedAt, clientTimezone, receivedAt, status, lastErrorCode
        case jobId, receipt
    }

    public init(from decoder: Decoder) throws {
        try StrictJSONKey.requireExactKeys(CodingKeys.allCases.map(\.rawValue), from: decoder)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(CaptureID.self, forKey: .id)
        rawContent = try container.decode(String.self, forKey: .rawContent)
        source = try container.decode(CaptureSource.self, forKey: .source)
        deviceId = try container.decode(String.self, forKey: .deviceId)
        privacy = try container.decode(PrivacyMode.self, forKey: .privacy)
        _explicitDestinationNoteId = try container.decode(
            RequiredNullable<NoteID>.self,
            forKey: .explicitDestinationNoteId
        )
        expansionDisabled = try container.decode(Bool.self, forKey: .expansionDisabled)
        clientCreatedAt = try container.decode(Date.self, forKey: .clientCreatedAt)
        clientTimezone = try container.decode(String.self, forKey: .clientTimezone)
        receivedAt = try container.decode(Date.self, forKey: .receivedAt)
        status = try container.decode(CaptureProcessingState.self, forKey: .status)
        _lastErrorCode = try container.decode(
            RequiredNullable<APIErrorCode>.self,
            forKey: .lastErrorCode
        )
        jobId = try container.decode(JobID.self, forKey: .jobId)
        _receipt = try container.decode(RequiredNullable<CaptureReceipt>.self, forKey: .receipt)

        guard (1 ... 10_000).contains(rawContent.utf16.count),
              !rawContent.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              deviceId.utf16.count <= 120,
              (1 ... 100).contains(clientTimezone.utf16.count),
              Self.receipt(receipt, matches: status, captureId: id, jobId: jobId) else {
            throw DecodingError.dataCorruptedError(
                forKey: .receipt,
                in: container,
                debugDescription: "Capture detail violates the API contract"
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(rawContent, forKey: .rawContent)
        try container.encode(source, forKey: .source)
        try container.encode(deviceId, forKey: .deviceId)
        try container.encode(privacy, forKey: .privacy)
        try container.encode(_explicitDestinationNoteId, forKey: .explicitDestinationNoteId)
        try container.encode(expansionDisabled, forKey: .expansionDisabled)
        try container.encode(clientCreatedAt, forKey: .clientCreatedAt)
        try container.encode(clientTimezone, forKey: .clientTimezone)
        try container.encode(receivedAt, forKey: .receivedAt)
        try container.encode(status, forKey: .status)
        try container.encode(_lastErrorCode, forKey: .lastErrorCode)
        try container.encode(jobId, forKey: .jobId)
        try container.encode(_receipt, forKey: .receipt)
    }

    private static func receipt(
        _ receipt: CaptureReceipt?,
        matches status: CaptureProcessingState,
        captureId: CaptureID,
        jobId: JobID
    ) -> Bool {
        if let receipt,
           receipt.captureId != captureId || receipt.jobId != jobId {
            return false
        }
        switch status {
        case .queued, .processing:
            return receipt == nil
        case .done:
            return receipt.map { $0.outcome == .createdNote || $0.outcome == .addedToNote } ?? false
        case .failed:
            return receipt?.outcome == .failed
        case .inbox:
            return receipt?.outcome == .keptInInbox
        case .needsReview:
            return receipt?.outcome == .needsReview
        }
    }
}

public struct CaptureDetailResponse: Codable, Equatable, Sendable {
    public let capture: CaptureDetail
    private enum CodingKeys: String, CodingKey, CaseIterable { case capture }
    public init(from decoder: Decoder) throws {
        try StrictJSONKey.requireExactKeys(CodingKeys.allCases.map(\.rawValue), from: decoder)
        capture = try decoder.container(keyedBy: CodingKeys.self).decode(CaptureDetail.self, forKey: .capture)
    }
}
public struct CaptureReceiptResponse: Codable, Equatable, Sendable {
    public let receipt: CaptureReceipt
    private enum CodingKeys: String, CodingKey, CaseIterable { case receipt }
    public init(from decoder: Decoder) throws {
        try StrictJSONKey.requireExactKeys(CodingKeys.allCases.map(\.rawValue), from: decoder)
        receipt = try decoder.container(keyedBy: CodingKeys.self).decode(CaptureReceipt.self, forKey: .receipt)
    }
}
public struct CaptureCreateResponse: Codable, Equatable, Sendable {
    public let capture: Capture; public let jobId: JobID; public let replayed: Bool

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case capture, jobId, replayed
    }

    public init(from decoder: Decoder) throws {
        try StrictJSONKey.requireExactKeys(CodingKeys.allCases.map(\.rawValue), from: decoder)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        capture = try container.decode(Capture.self, forKey: .capture)
        jobId = try container.decode(JobID.self, forKey: .jobId)
        replayed = try container.decode(Bool.self, forKey: .replayed)
        guard capture.status == .queued, capture.lastErrorCode == nil else {
            throw DecodingError.dataCorruptedError(
                forKey: .capture,
                in: container,
                debugDescription: "Capture creation was not queued cleanly"
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(capture, forKey: .capture)
        try container.encode(jobId, forKey: .jobId)
        try container.encode(replayed, forKey: .replayed)
    }
}
public typealias CaptureRetryResponse = CaptureCreateResponse

public struct CaptureRetryRequest: Codable, Equatable, Sendable {
    public let idempotencyKey: String
    public init(idempotencyKey: String) { self.idempotencyKey = idempotencyKey }
}

public struct CaptureExpectedNoteRevision: Codable, Equatable, Sendable {
    public let noteId: NoteID; public let expectedRevision: Int
    public init(noteId: NoteID, expectedRevision: Int) { self.noteId = noteId; self.expectedRevision = expectedRevision }
}

public struct CaptureDeleteRequest: Codable, Equatable, Sendable {
    public let idempotencyKey: String; public let removeInsertedContent: Bool
    public let expectedNoteRevisions: [CaptureExpectedNoteRevision]
    public init(idempotencyKey: String, removeInsertedContent: Bool = false,
                expectedNoteRevisions: [CaptureExpectedNoteRevision] = []) throws {
        guard removeInsertedContent == !expectedNoteRevisions.isEmpty else {
            throw DomainValidationError.invalidValue("Expected revisions must accompany content removal")
        }
        self.idempotencyKey = idempotencyKey; self.removeInsertedContent = removeInsertedContent
        self.expectedNoteRevisions = expectedNoteRevisions
    }
}

public struct CaptureContentRemovalMutation: Codable, Equatable, Sendable {
    public let mutationId: MutationID; public let noteId: NoteID; public let expectedRevision: Int
}
public struct CaptureDeleteResponse: Codable, Equatable, Sendable {
    public let captureId: CaptureID; public let deletedAt: Date
    public let sourceRemovedFromNoteIds: [NoteID]; public let removedInsertedContent: Bool
    public let contentRemovalMutations: [CaptureContentRemovalMutation]; public let replayed: Bool
}
