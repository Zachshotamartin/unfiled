import Foundation

public struct ReviewProposalNote: Codable, Equatable, Sendable {
    public let noteId: NoteID
    public let revision: Int

    private enum CodingKeys: String, CodingKey, CaseIterable { case noteId, revision }

    public init(noteId: NoteID, revision: Int) throws {
        guard revision > 0 else {
            throw DomainValidationError.invalidValue(
                "Review proposal revision must be positive"
            )
        }
        self.noteId = noteId
        self.revision = revision
    }

    public init(from decoder: Decoder) throws {
        try StrictJSONKey.requireExactKeys(CodingKeys.allCases.map(\.rawValue), from: decoder)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        noteId = try container.decode(NoteID.self, forKey: .noteId)
        revision = try container.decode(Int.self, forKey: .revision)
        guard revision > 0 else {
            throw DecodingError.dataCorruptedError(
                forKey: .revision,
                in: container,
                debugDescription: "Review proposal revision must be positive"
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        guard revision > 0 else {
            throw EncodingError.invalidValue(
                revision,
                EncodingError.Context(
                    codingPath: encoder.codingPath + [CodingKeys.revision],
                    debugDescription: "Review proposal revision must be positive"
                )
            )
        }
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(noteId, forKey: .noteId)
        try container.encode(revision, forKey: .revision)
    }
}

public enum ReviewConflictReason: String, Codable, CaseIterable, Sendable {
    case revision
    case candidateEligibility = "candidate_eligibility"
    case consentControls = "consent_controls"
    case structure
}

public enum ReviewProposal: Codable, Equatable, Sendable {
    case routeCapture(plan: OrganizationPlan)
    case generatedBlock(blockId: BlockID)
    case duplicateNotes(notes: [ReviewProposalNote])
    case conflict(reason: ReviewConflictReason)
    case failedJob(errorCode: APIErrorCode)

    private enum CodingKeys: String, CodingKey { case type, plan, blockId, notes, reason, errorCode }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(String.self, forKey: .type) {
        case "route_capture":
            try StrictJSONKey.requireExactKeys(["type", "plan"], from: decoder)
            self = .routeCapture(plan: try container.decode(OrganizationPlan.self, forKey: .plan))
        case "generated_block":
            try StrictJSONKey.requireExactKeys(["type", "blockId"], from: decoder)
            self = .generatedBlock(blockId: try container.decode(BlockID.self, forKey: .blockId))
        case "duplicate_notes":
            try StrictJSONKey.requireExactKeys(["type", "notes"], from: decoder)
            let notes = try container.decode([ReviewProposalNote].self, forKey: .notes)
            guard (2 ... 3).contains(notes.count), Set(notes.map(\.noteId)).count == notes.count else {
                throw DecodingError.dataCorruptedError(
                    forKey: .notes,
                    in: container,
                    debugDescription: "Duplicate-note proposal requires two or three distinct notes"
                )
            }
            self = .duplicateNotes(notes: notes)
        case "conflict":
            try StrictJSONKey.requireExactKeys(["type", "reason"], from: decoder)
            self = .conflict(
                reason: try container.decode(ReviewConflictReason.self, forKey: .reason)
            )
        case "failed_job":
            try StrictJSONKey.requireExactKeys(["type", "errorCode"], from: decoder)
            self = .failedJob(errorCode: try container.decode(APIErrorCode.self, forKey: .errorCode))
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .type,
                in: container,
                debugDescription: "Unknown Review proposal"
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        try validateForEncoding()
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .routeCapture(plan):
            try container.encode("route_capture", forKey: .type)
            try container.encode(plan, forKey: .plan)
        case let .generatedBlock(blockId):
            try container.encode("generated_block", forKey: .type)
            try container.encode(blockId, forKey: .blockId)
        case let .duplicateNotes(notes):
            try container.encode("duplicate_notes", forKey: .type)
            try container.encode(notes, forKey: .notes)
        case let .conflict(reason):
            try container.encode("conflict", forKey: .type)
            try container.encode(reason, forKey: .reason)
        case let .failedJob(errorCode):
            try container.encode("failed_job", forKey: .type)
            try container.encode(errorCode, forKey: .errorCode)
        }
    }

    private func validateForEncoding() throws {
        guard case let .duplicateNotes(notes) = self else { return }
        guard (2 ... 3).contains(notes.count),
              Set(notes.map(\.noteId)).count == notes.count,
              notes.allSatisfy({ $0.revision > 0 }) else {
            throw DomainValidationError.invalidValue(
                "Duplicate-note proposal requires two or three distinct notes with positive revisions"
            )
        }
    }
}

public enum ReviewResolution: Codable, Equatable, Sendable {
    case route(noteId: NoteID, expectedRevision: Int)
    case create(title: String, noteType: NoteType, spaceId: SpaceID?)
    case keepInbox
    case dismiss
    case keepBoth
    case acceptExpansion
    case rejectExpansion

    private enum CodingKeys: String, CodingKey {
        case type, noteId, expectedRevision, title, noteType, spaceId
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(String.self, forKey: .type) {
        case "route":
            try StrictJSONKey.requireExactKeys(
                ["type", "noteId", "expectedRevision"],
                from: decoder
            )
            let revision = try container.decode(Int.self, forKey: .expectedRevision)
            guard revision > 0 else { throw Self.invalid(.expectedRevision, in: container) }
            self = .route(
                noteId: try container.decode(NoteID.self, forKey: .noteId),
                expectedRevision: revision
            )
        case "create":
            try StrictJSONKey.requireExactKeys(
                ["type", "title", "noteType", "spaceId"],
                from: decoder
            )
            let title = try container.decode(String.self, forKey: .title)
            guard (1 ... 200).contains(title.trimmingCharacters(in: .whitespacesAndNewlines).utf16.count)
            else { throw Self.invalid(.title, in: container) }
            let spaceId = try container.decode(RequiredNullable<SpaceID>.self, forKey: .spaceId)
            self = .create(
                title: title,
                noteType: try container.decode(NoteType.self, forKey: .noteType),
                spaceId: spaceId.wrappedValue
            )
        case "keep_inbox":
            try StrictJSONKey.requireExactKeys(["type"], from: decoder)
            self = .keepInbox
        case "dismiss":
            try StrictJSONKey.requireExactKeys(["type"], from: decoder)
            self = .dismiss
        case "keep_both":
            try StrictJSONKey.requireExactKeys(["type"], from: decoder)
            self = .keepBoth
        case "accept_expansion":
            try StrictJSONKey.requireExactKeys(["type"], from: decoder)
            self = .acceptExpansion
        case "reject_expansion":
            try StrictJSONKey.requireExactKeys(["type"], from: decoder)
            self = .rejectExpansion
        default:
            throw Self.invalid(.type, in: container)
        }
    }

    public func encode(to encoder: Encoder) throws {
        try validateForRequest()
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .route(noteId, expectedRevision):
            try container.encode("route", forKey: .type)
            try container.encode(noteId, forKey: .noteId)
            try container.encode(expectedRevision, forKey: .expectedRevision)
        case let .create(title, noteType, spaceId):
            try container.encode("create", forKey: .type)
            try container.encode(title, forKey: .title)
            try container.encode(noteType, forKey: .noteType)
            try container.encodeIfPresent(spaceId, forKey: .spaceId)
            if spaceId == nil { try container.encodeNil(forKey: .spaceId) }
        case .keepInbox: try container.encode("keep_inbox", forKey: .type)
        case .dismiss: try container.encode("dismiss", forKey: .type)
        case .keepBoth: try container.encode("keep_both", forKey: .type)
        case .acceptExpansion: try container.encode("accept_expansion", forKey: .type)
        case .rejectExpansion: try container.encode("reject_expansion", forKey: .type)
        }
    }

    fileprivate func validateForRequest() throws {
        switch self {
        case let .route(_, expectedRevision):
            guard expectedRevision > 0 else {
                throw DomainValidationError.invalidValue(
                    "Review resolution revision must be positive"
                )
            }
        case let .create(title, _, _):
            guard Self.isValidTitle(title) else {
                throw DomainValidationError.invalidValue(
                    "Review resolution title must contain between 1 and 200 characters"
                )
            }
        case .keepInbox, .dismiss, .keepBoth, .acceptExpansion, .rejectExpansion:
            break
        }
    }

    var isDismissal: Bool {
        if case .dismiss = self { return true }
        return false
    }

    private static func invalid(
        _ key: CodingKeys,
        in container: KeyedDecodingContainer<CodingKeys>
    ) -> DecodingError {
        DecodingError.dataCorruptedError(
            forKey: key,
            in: container,
            debugDescription: "Review resolution violates the API contract"
        )
    }

    private static func isValidTitle(_ title: String) -> Bool {
        (1 ... 200).contains(
            title.trimmingCharacters(in: .whitespacesAndNewlines).utf16.count
        )
    }
}

public struct ReviewResolveRequest: Codable, Equatable, Sendable {
    public let idempotencyKey: String
    public let resolution: ReviewResolution

    public init(idempotencyKey: String, resolution: ReviewResolution) throws {
        try resolution.validateForRequest()
        self.idempotencyKey = idempotencyKey
        self.resolution = resolution
    }
}

public struct ReviewResolveResponse: Codable, Equatable, Sendable {
    public let reviewItem: ReviewItem
    public let replayed: Bool

    private enum CodingKeys: String, CodingKey, CaseIterable { case reviewItem, replayed }

    public init(from decoder: Decoder) throws {
        try StrictJSONKey.requireExactKeys(CodingKeys.allCases.map(\.rawValue), from: decoder)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        reviewItem = try container.decode(ReviewItem.self, forKey: .reviewItem)
        replayed = try container.decode(Bool.self, forKey: .replayed)
    }
}

public struct CorrectionSource: Codable, Equatable, Sendable {
    public let noteId: NoteID
    public let expectedRevision: Int

    private enum CodingKeys: String, CodingKey, CaseIterable { case noteId, expectedRevision }

    public init(noteId: NoteID, expectedRevision: Int) throws {
        self.noteId = noteId
        self.expectedRevision = expectedRevision
        try validateForRequest()
    }

    public init(from decoder: Decoder) throws {
        try StrictJSONKey.requireExactKeys(CodingKeys.allCases.map(\.rawValue), from: decoder)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        noteId = try container.decode(NoteID.self, forKey: .noteId)
        expectedRevision = try container.decode(Int.self, forKey: .expectedRevision)
        guard expectedRevision > 0 else {
            throw DecodingError.dataCorruptedError(
                forKey: .expectedRevision,
                in: container,
                debugDescription: "Expected revision must be positive"
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        try validateForRequest()
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(noteId, forKey: .noteId)
        try container.encode(expectedRevision, forKey: .expectedRevision)
    }

    fileprivate func validateForRequest() throws {
        guard expectedRevision > 0 else {
            throw DomainValidationError.invalidValue("Expected revision must be positive")
        }
    }
}

public enum CorrectionDestination: Codable, Equatable, Sendable {
    case existingNote(noteId: NoteID, expectedRevision: Int)
    case newNote(title: String, noteType: NoteType, spaceId: SpaceID?)

    private enum CodingKeys: String, CodingKey {
        case type, noteId, expectedRevision, title, noteType, spaceId
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(String.self, forKey: .type) {
        case "existing_note":
            try StrictJSONKey.requireExactKeys(
                ["type", "noteId", "expectedRevision"],
                from: decoder
            )
            let revision = try container.decode(Int.self, forKey: .expectedRevision)
            guard revision > 0 else { throw Self.invalid(.expectedRevision, in: container) }
            self = .existingNote(
                noteId: try container.decode(NoteID.self, forKey: .noteId),
                expectedRevision: revision
            )
        case "new_note":
            try StrictJSONKey.requireExactKeys(
                ["type", "title", "noteType", "spaceId"],
                from: decoder
            )
            let title = try container.decode(String.self, forKey: .title)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard (1 ... 200).contains(title.utf16.count)
            else { throw Self.invalid(.title, in: container) }
            let spaceId = try container.decode(RequiredNullable<SpaceID>.self, forKey: .spaceId)
            self = .newNote(
                title: title,
                noteType: try container.decode(NoteType.self, forKey: .noteType),
                spaceId: spaceId.wrappedValue
            )
        default: throw Self.invalid(.type, in: container)
        }
    }

    public func encode(to encoder: Encoder) throws {
        let normalized = try normalizedForRequest()
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch normalized {
        case let .existingNote(noteId, expectedRevision):
            try container.encode("existing_note", forKey: .type)
            try container.encode(noteId, forKey: .noteId)
            try container.encode(expectedRevision, forKey: .expectedRevision)
        case let .newNote(title, noteType, spaceId):
            try container.encode("new_note", forKey: .type)
            try container.encode(title, forKey: .title)
            try container.encode(noteType, forKey: .noteType)
            try container.encodeIfPresent(spaceId, forKey: .spaceId)
            if spaceId == nil { try container.encodeNil(forKey: .spaceId) }
        }
    }

    fileprivate func validateForRequest() throws {
        _ = try normalizedForRequest()
    }

    fileprivate func normalizedForRequest() throws -> Self {
        switch self {
        case let .existingNote(_, expectedRevision):
            guard expectedRevision > 0 else {
                throw DomainValidationError.invalidValue(
                    "Correction destination revision must be positive"
                )
            }
            return self
        case let .newNote(title, noteType, spaceId):
            let normalizedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
            guard Self.isValidTitle(normalizedTitle) else {
                throw DomainValidationError.invalidValue(
                    "Correction destination title must contain between 1 and 200 characters"
                )
            }
            return .newNote(title: normalizedTitle, noteType: noteType, spaceId: spaceId)
        }
    }

    var existingNoteId: NoteID? {
        if case let .existingNote(noteId, _) = self { return noteId }
        return nil
    }

    private static func invalid(
        _ key: CodingKeys,
        in container: KeyedDecodingContainer<CodingKeys>
    ) -> DecodingError {
        DecodingError.dataCorruptedError(
            forKey: key,
            in: container,
            debugDescription: "Correction destination violates the API contract"
        )
    }

    private static func isValidTitle(_ title: String) -> Bool {
        (1 ... 200).contains(
            title.trimmingCharacters(in: .whitespacesAndNewlines).utf16.count
        )
    }
}

public struct DecisionCorrectionRequest: Codable, Equatable, Sendable {
    public let idempotencyKey: String
    public let source: CorrectionSource
    public let destination: CorrectionDestination

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case idempotencyKey, source, destination
    }

    public init(
        idempotencyKey: String,
        source: CorrectionSource,
        destination: CorrectionDestination
    ) throws {
        try source.validateForRequest()
        let destination = try destination.normalizedForRequest()
        guard IdempotencyKeyContract.isValid(idempotencyKey),
              destination.existingNoteId != source.noteId else {
            throw DomainValidationError.invalidValue(
                "Decision correction request violates the API contract"
            )
        }
        self.idempotencyKey = idempotencyKey
        self.source = source
        self.destination = destination
    }

    public init(from decoder: Decoder) throws {
        try StrictJSONKey.requireExactKeys(CodingKeys.allCases.map(\.rawValue), from: decoder)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        do {
            try self.init(
                idempotencyKey: container.decode(String.self, forKey: .idempotencyKey),
                source: container.decode(CorrectionSource.self, forKey: .source),
                destination: container.decode(CorrectionDestination.self, forKey: .destination)
            )
        } catch {
            throw DecodingError.dataCorruptedError(
                forKey: .destination,
                in: container,
                debugDescription: "Decision correction request violates the API contract"
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        try source.validateForRequest()
        let destination = try destination.normalizedForRequest()
        guard IdempotencyKeyContract.isValid(idempotencyKey),
              destination.existingNoteId != source.noteId else {
            throw EncodingError.invalidValue(
                destination,
                .init(
                    codingPath: encoder.codingPath,
                    debugDescription: "Decision correction request violates the API contract"
                )
            )
        }
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(idempotencyKey, forKey: .idempotencyKey)
        try container.encode(source, forKey: .source)
        try container.encode(destination, forKey: .destination)
    }
}

public struct CorrectionAppliedNote: Codable, Equatable, Sendable {
    public let noteId: NoteID
    public let currentRevision: Int
    public let mutationId: MutationID

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case noteId, currentRevision, mutationId
    }

    public init(from decoder: Decoder) throws {
        try StrictJSONKey.requireExactKeys(CodingKeys.allCases.map(\.rawValue), from: decoder)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        noteId = try container.decode(NoteID.self, forKey: .noteId)
        currentRevision = try container.decode(Int.self, forKey: .currentRevision)
        mutationId = try container.decode(MutationID.self, forKey: .mutationId)
        guard currentRevision > 0 else {
            throw DecodingError.dataCorruptedError(
                forKey: .currentRevision,
                in: container,
                debugDescription: "Correction revision must be positive"
            )
        }
    }

    fileprivate init(noteId: NoteID, currentRevision: Int, mutationId: MutationID) {
        self.noteId = noteId
        self.currentRevision = currentRevision
        self.mutationId = mutationId
    }
}

public enum CorrectionAppliedDestination: Codable, Equatable, Sendable {
    case existingNote(CorrectionAppliedNote)
    case newNote(CorrectionAppliedNote)

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case type, noteId, currentRevision, mutationId
    }

    public init(from decoder: Decoder) throws {
        try StrictJSONKey.requireExactKeys(CodingKeys.allCases.map(\.rawValue), from: decoder)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)
        let currentRevision = try container.decode(Int.self, forKey: .currentRevision)
        guard currentRevision > 0 else {
            throw DecodingError.dataCorruptedError(
                forKey: .currentRevision,
                in: container,
                debugDescription: "Correction revision must be positive"
            )
        }
        let note = CorrectionAppliedNote(
            noteId: try container.decode(NoteID.self, forKey: .noteId),
            currentRevision: currentRevision,
            mutationId: try container.decode(MutationID.self, forKey: .mutationId)
        )
        switch type {
        case "existing_note": self = .existingNote(note)
        case "new_note": self = .newNote(note)
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .type,
                in: container,
                debugDescription: "Unknown correction destination result"
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        let type: String
        let note: CorrectionAppliedNote
        switch self {
        case let .existingNote(value): type = "existing_note"; note = value
        case let .newNote(value): type = "new_note"; note = value
        }
        try container.encode(type, forKey: .type)
        try container.encode(note.noteId, forKey: .noteId)
        try container.encode(note.currentRevision, forKey: .currentRevision)
        try container.encode(note.mutationId, forKey: .mutationId)
    }

    var note: CorrectionAppliedNote {
        switch self {
        case let .existingNote(note), let .newNote(note): note
        }
    }
}

public struct DecisionCorrectionAppliedResponse: Codable, Equatable, Sendable {
    public let decisionId: DecisionID
    public let source: CorrectionAppliedNote
    public let destination: CorrectionAppliedDestination
    public let replayed: Bool

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case outcome, decisionId, source, destination, replayed
    }

    public init(from decoder: Decoder) throws {
        try StrictJSONKey.requireExactKeys(CodingKeys.allCases.map(\.rawValue), from: decoder)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        guard try container.decode(String.self, forKey: .outcome) == "applied" else {
            throw DecodingError.dataCorruptedError(
                forKey: .outcome,
                in: container,
                debugDescription: "Unknown correction outcome"
            )
        }
        decisionId = try container.decode(DecisionID.self, forKey: .decisionId)
        source = try container.decode(CorrectionAppliedNote.self, forKey: .source)
        destination = try container.decode(CorrectionAppliedDestination.self, forKey: .destination)
        replayed = try container.decode(Bool.self, forKey: .replayed)
        guard source.noteId != destination.note.noteId,
              source.mutationId != destination.note.mutationId else {
            throw DecodingError.dataCorruptedError(
                forKey: .destination,
                in: container,
                debugDescription: "Correction result must bind distinct notes and mutations"
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode("applied", forKey: .outcome)
        try container.encode(decisionId, forKey: .decisionId)
        try container.encode(source, forKey: .source)
        try container.encode(destination, forKey: .destination)
        try container.encode(replayed, forKey: .replayed)
    }
}

public enum DecisionCorrectionNeedsReviewReasonCode: String, Codable, Sendable {
    case exactInverseUnavailable = "exact_inverse_unavailable"
}

public struct DecisionCorrectionNeedsReviewResponse: Codable, Equatable, Sendable {
    public let decisionId: DecisionID
    public let reviewItemId: ReviewID
    public let reasonCode: DecisionCorrectionNeedsReviewReasonCode
    public let replayed: Bool

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case outcome, decisionId, reviewItemId, reasonCode, replayed
    }

    public init(from decoder: Decoder) throws {
        try StrictJSONKey.requireExactKeys(CodingKeys.allCases.map(\.rawValue), from: decoder)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        guard try container.decode(String.self, forKey: .outcome) == "needs_review" else {
            throw DecodingError.dataCorruptedError(
                forKey: .outcome,
                in: container,
                debugDescription: "Unknown correction outcome"
            )
        }
        decisionId = try container.decode(DecisionID.self, forKey: .decisionId)
        reviewItemId = try container.decode(ReviewID.self, forKey: .reviewItemId)
        reasonCode = try container.decode(
            DecisionCorrectionNeedsReviewReasonCode.self,
            forKey: .reasonCode
        )
        replayed = try container.decode(Bool.self, forKey: .replayed)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode("needs_review", forKey: .outcome)
        try container.encode(decisionId, forKey: .decisionId)
        try container.encode(reviewItemId, forKey: .reviewItemId)
        try container.encode(reasonCode, forKey: .reasonCode)
        try container.encode(replayed, forKey: .replayed)
    }
}

public enum DecisionCorrectionResponse: Codable, Equatable, Sendable {
    case applied(DecisionCorrectionAppliedResponse)
    case needsReview(DecisionCorrectionNeedsReviewResponse)

    private enum CodingKeys: String, CodingKey { case outcome }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(String.self, forKey: .outcome) {
        case "applied":
            self = .applied(try DecisionCorrectionAppliedResponse(from: decoder))
        case "needs_review":
            self = .needsReview(try DecisionCorrectionNeedsReviewResponse(from: decoder))
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .outcome,
                in: container,
                debugDescription: "Unknown correction outcome"
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        switch self {
        case let .applied(value): try value.encode(to: encoder)
        case let .needsReview(value): try value.encode(to: encoder)
        }
    }
}

public enum RoutingRuleType: String, Codable, CaseIterable, Sendable {
    case prefix, phrase, alias
    case destinationMention = "destination_mention"
}

public enum RoutingRuleSource: String, Codable, CaseIterable, Sendable {
    case explicit
    case correctionSuggested = "correction_suggested"
}

public enum RoutingRuleDestination: Codable, Equatable, Sendable {
    case note(NoteID)
    case space(SpaceID)

    private enum CodingKeys: String, CodingKey { case type, noteId, spaceId }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(String.self, forKey: .type) {
        case "note":
            try StrictJSONKey.requireExactKeys(["type", "noteId"], from: decoder)
            self = .note(try container.decode(NoteID.self, forKey: .noteId))
        case "space":
            try StrictJSONKey.requireExactKeys(["type", "spaceId"], from: decoder)
            self = .space(try container.decode(SpaceID.self, forKey: .spaceId))
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .type,
                in: container,
                debugDescription: "Unknown routing-rule destination"
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .note(noteId):
            try container.encode("note", forKey: .type)
            try container.encode(noteId, forKey: .noteId)
        case let .space(spaceId):
            try container.encode("space", forKey: .type)
            try container.encode(spaceId, forKey: .spaceId)
        }
    }
}

public struct RoutingRule: Codable, Equatable, Sendable {
    public let id: RuleID
    public let revision: Int
    public let enabled: Bool
    public let ruleType: RoutingRuleType
    public let condition: String
    public let destination: RoutingRuleDestination
    public let priority: Int
    public let normalizedCondition: String
    public let aliases: [String]
    public let source: RoutingRuleSource
    @RequiredNullable public var lastFiredAt: Date?
    public let createdAt: Date
    public let updatedAt: Date

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case id, revision, enabled, ruleType, condition, destination, priority
        case normalizedCondition, aliases, source, lastFiredAt, createdAt, updatedAt
    }

    public init(from decoder: Decoder) throws {
        try StrictJSONKey.requireExactKeys(CodingKeys.allCases.map(\.rawValue), from: decoder)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(RuleID.self, forKey: .id)
        revision = try container.decode(Int.self, forKey: .revision)
        enabled = try container.decode(Bool.self, forKey: .enabled)
        ruleType = try container.decode(RoutingRuleType.self, forKey: .ruleType)
        condition = try container.decode(String.self, forKey: .condition)
        destination = try container.decode(RoutingRuleDestination.self, forKey: .destination)
        priority = try container.decode(Int.self, forKey: .priority)
        normalizedCondition = try container.decode(String.self, forKey: .normalizedCondition)
        aliases = try container.decode([String].self, forKey: .aliases)
        source = try container.decode(RoutingRuleSource.self, forKey: .source)
        _lastFiredAt = try container.decode(RequiredNullable<Date>.self, forKey: .lastFiredAt)
        createdAt = try container.decode(Date.self, forKey: .createdAt)
        updatedAt = try container.decode(Date.self, forKey: .updatedAt)
        guard revision > 0,
              (1 ... 500).contains(condition.trimmingCharacters(in: .whitespacesAndNewlines).utf16.count),
              (1 ... 500).contains(normalizedCondition.utf16.count),
              (0 ... 10_000).contains(priority),
              aliases.count <= 100,
              aliases.allSatisfy({ (1 ... 200).contains($0.utf16.count) }) else {
            throw DecodingError.dataCorruptedError(
                forKey: .condition,
                in: container,
                debugDescription: "Routing rule violates the API contract"
            )
        }
    }
}

public struct RoutingRuleListResponse: Codable, Equatable, Sendable {
    public let items: [RoutingRule]

    private enum CodingKeys: String, CodingKey, CaseIterable { case items }

    public init(from decoder: Decoder) throws {
        try StrictJSONKey.requireExactKeys(CodingKeys.allCases.map(\.rawValue), from: decoder)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        items = try container.decode([RoutingRule].self, forKey: .items)
        guard items.count <= 10_000 else {
            throw DecodingError.dataCorruptedError(
                forKey: .items,
                in: container,
                debugDescription: "Routing-rule response is too large"
            )
        }
    }
}

public struct RoutingRuleCreateRequest: Codable, Equatable, Sendable {
    public let idempotencyKey: String
    public let enabled: Bool
    public let ruleType: RoutingRuleType
    public let condition: String
    public let destination: RoutingRuleDestination
    public let priority: Int

    public init(
        idempotencyKey: String,
        enabled: Bool,
        ruleType: RoutingRuleType,
        condition: String,
        destination: RoutingRuleDestination,
        priority: Int
    ) throws {
        guard (1 ... 500).contains(condition.trimmingCharacters(in: .whitespacesAndNewlines).utf16.count),
              (0 ... 10_000).contains(priority) else {
            throw DomainValidationError.invalidValue("Routing rule violates the API contract")
        }
        self.idempotencyKey = idempotencyKey
        self.enabled = enabled
        self.ruleType = ruleType
        self.condition = condition
        self.destination = destination
        self.priority = priority
    }
}

public struct RoutingRuleUpdateRequest: Encodable, Equatable, Sendable {
    public let expectedRevision: Int
    public let idempotencyKey: String
    public let enabled: Bool?
    public let ruleType: RoutingRuleType?
    public let condition: String?
    public let destination: RoutingRuleDestination?
    public let priority: Int?

    public init(
        expectedRevision: Int,
        idempotencyKey: String,
        enabled: Bool? = nil,
        ruleType: RoutingRuleType? = nil,
        condition: String? = nil,
        destination: RoutingRuleDestination? = nil,
        priority: Int? = nil
    ) throws {
        guard expectedRevision > 0,
              enabled != nil || ruleType != nil || condition != nil || destination != nil || priority != nil,
              condition.map({ (1 ... 500).contains($0.trimmingCharacters(in: .whitespacesAndNewlines).utf16.count) }) ?? true,
              priority.map({ (0 ... 10_000).contains($0) }) ?? true else {
            throw DomainValidationError.invalidValue("Routing-rule update violates the API contract")
        }
        self.expectedRevision = expectedRevision
        self.idempotencyKey = idempotencyKey
        self.enabled = enabled
        self.ruleType = ruleType
        self.condition = condition
        self.destination = destination
        self.priority = priority
    }
}

public typealias RoutingRuleDeleteRequest = RevisionMutationRequest

public struct RoutingRuleMutationResponse: Codable, Equatable, Sendable {
    public let rule: RoutingRule
    public let replayed: Bool

    private enum CodingKeys: String, CodingKey, CaseIterable { case rule, replayed }

    public init(from decoder: Decoder) throws {
        try StrictJSONKey.requireExactKeys(CodingKeys.allCases.map(\.rawValue), from: decoder)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        rule = try container.decode(RoutingRule.self, forKey: .rule)
        replayed = try container.decode(Bool.self, forKey: .replayed)
    }
}

public struct RoutingRuleDeleteResponse: Codable, Equatable, Sendable {
    public let ruleId: RuleID
    public let deleted: Bool
    public let replayed: Bool

    private enum CodingKeys: String, CodingKey, CaseIterable { case ruleId, deleted, replayed }

    public init(from decoder: Decoder) throws {
        try StrictJSONKey.requireExactKeys(CodingKeys.allCases.map(\.rawValue), from: decoder)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        ruleId = try container.decode(RuleID.self, forKey: .ruleId)
        deleted = try container.decode(Bool.self, forKey: .deleted)
        replayed = try container.decode(Bool.self, forKey: .replayed)
        guard deleted else {
            throw DecodingError.dataCorruptedError(
                forKey: .deleted,
                in: container,
                debugDescription: "Routing-rule deletion response must confirm deletion"
            )
        }
    }
}

public enum GeneratedBlockKind: String, Codable, CaseIterable, Sendable {
    case summary, interpretation, suggestion, label
}

public enum GeneratedBlockState: String, Codable, CaseIterable, Sendable {
    case proposed, accepted, rejected
}

public struct GeneratedBlock: Codable, Equatable, Sendable {
    public let id: BlockID
    public let noteId: NoteID
    public let decisionId: DecisionID
    public let kind: GeneratedBlockKind
    public let content: String
    public let state: GeneratedBlockState
    public let stateRevision: Int
    public let modelId: String
    public let promptVersion: String
    public let createdAt: Date
    @RequiredNullable public var resolvedAt: Date?

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case id, noteId, decisionId, kind, content, state, stateRevision
        case modelId, promptVersion, createdAt, resolvedAt
    }

    public init(from decoder: Decoder) throws {
        try StrictJSONKey.requireExactKeys(CodingKeys.allCases.map(\.rawValue), from: decoder)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(BlockID.self, forKey: .id)
        noteId = try container.decode(NoteID.self, forKey: .noteId)
        decisionId = try container.decode(DecisionID.self, forKey: .decisionId)
        kind = try container.decode(GeneratedBlockKind.self, forKey: .kind)
        content = try container.decode(String.self, forKey: .content)
        state = try container.decode(GeneratedBlockState.self, forKey: .state)
        stateRevision = try container.decode(Int.self, forKey: .stateRevision)
        modelId = try container.decode(String.self, forKey: .modelId)
        promptVersion = try container.decode(String.self, forKey: .promptVersion)
        createdAt = try container.decode(Date.self, forKey: .createdAt)
        _resolvedAt = try container.decode(RequiredNullable<Date>.self, forKey: .resolvedAt)
        guard (1 ... 600).contains(content.utf16.count),
              (state == .proposed ? stateRevision == 1 : stateRevision >= 2),
              (1 ... 120).contains(modelId.utf16.count),
              (1 ... 120).contains(promptVersion.utf16.count),
              (state == .proposed) == (resolvedAt == nil) else {
            throw DecodingError.dataCorruptedError(
                forKey: .state,
                in: container,
                debugDescription: "Generated block violates the API contract"
            )
        }
    }
}

public struct GeneratedBlockListResponse: Codable, Equatable, Sendable {
    public let items: [GeneratedBlock]

    private enum CodingKeys: String, CodingKey, CaseIterable { case items }

    public init(from decoder: Decoder) throws {
        try StrictJSONKey.requireExactKeys(CodingKeys.allCases.map(\.rawValue), from: decoder)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        items = try container.decode([GeneratedBlock].self, forKey: .items)
        guard items.count <= 1_000 else {
            throw DecodingError.dataCorruptedError(
                forKey: .items,
                in: container,
                debugDescription: "Generated-block response is too large"
            )
        }
    }
}

public enum GeneratedBlockResolution: String, Codable, CaseIterable, Sendable {
    case accept, reject
}

public struct GeneratedBlockResolveRequest: Codable, Equatable, Sendable {
    public let expectedStateRevision: Int
    public let idempotencyKey: String
    public let resolution: GeneratedBlockResolution

    public init(
        expectedStateRevision: Int,
        idempotencyKey: String,
        resolution: GeneratedBlockResolution
    ) throws {
        guard expectedStateRevision > 0 else {
            throw DomainValidationError.invalidValue("Expected state revision must be positive")
        }
        self.expectedStateRevision = expectedStateRevision
        self.idempotencyKey = idempotencyKey
        self.resolution = resolution
    }
}

public struct GeneratedBlockResolveResponse: Codable, Equatable, Sendable {
    public let block: GeneratedBlock
    public let replayed: Bool

    private enum CodingKeys: String, CodingKey, CaseIterable { case block, replayed }

    public init(from decoder: Decoder) throws {
        try StrictJSONKey.requireExactKeys(CodingKeys.allCases.map(\.rawValue), from: decoder)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        block = try container.decode(GeneratedBlock.self, forKey: .block)
        replayed = try container.decode(Bool.self, forKey: .replayed)
    }
}
