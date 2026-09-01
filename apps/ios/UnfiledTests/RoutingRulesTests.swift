import Foundation
import XCTest
@testable import Unfiled

final class RoutingRulesTests: XCTestCase {
    func testOwnerRuleContractRequiresExplicitAndProposalLifecycleCoherence() throws {
        let explicit = try rule(enabled: true, source: "explicit", proposalState: "null")
        XCTAssertNil(explicit.proposalState)
        XCTAssertEqual(explicit.destinationStatus, .active)

        let offered = try rule(
            enabled: false,
            source: "correction_suggested",
            proposalState: #""offered""#
        )
        XCTAssertEqual(offered.proposalState, .offered)
        XCTAssertFalse(offered.enabled)

        let accepted = try rule(
            enabled: true,
            source: "correction_suggested",
            proposalState: #""accepted""#
        )
        XCTAssertEqual(accepted.proposalState, .accepted)
        XCTAssertTrue(accepted.enabled)

        XCTAssertThrowsError(
            try rule(
                enabled: true,
                source: "correction_suggested",
                proposalState: #""offered""#
            )
        )
        XCTAssertThrowsError(
            try rule(enabled: false, source: "correction_suggested", proposalState: "null")
        )
        XCTAssertThrowsError(
            try rule(enabled: false, source: "explicit", proposalState: #""offered""#)
        )
        XCTAssertThrowsError(try rule(condition: "gym:", normalizedCondition: "gym:"))
    }

    func testRoutingRulePagesRequireBoundedCursorCoherence() throws {
        let decoder = APIJSON.makeDecoder()
        let encodedRule = try APIJSON.makeEncoder().encode(rule())
        let ruleJSON = try XCTUnwrap(String(data: encodedRule, encoding: .utf8))
        let terminal = #"{"items":[\#(ruleJSON)],"pageInfo":{"hasMore":false,"nextCursor":null}}"#
        let decoded = try decoder.decode(
            RoutingRuleListResponse.self,
            from: Data(terminal.utf8)
        )
        XCTAssertEqual(decoded.items.count, 1)
        XCTAssertFalse(decoded.pageInfo.hasMore)
        XCTAssertThrowsError(
            try decoder.decode(
                RoutingRuleListResponse.self,
                from: Data(
                    #"{"items":[\#(ruleJSON)],"pageInfo":{"hasMore":true,"nextCursor":"rule_00000000000000000000000000"}}"#.utf8
                )
            )
        )
        XCTAssertThrowsError(
            try decoder.decode(
                RoutingRuleListResponse.self,
                from: Data(#"{"items":[\#(ruleJSON)]}"#.utf8)
            )
        )
    }

    func testRuleRequestsTrimConditionAndEncodeSparseRevisionCAS() throws {
        let noteID = try NoteID(validating: "note_00000000000000000000000000")
        let create = try RoutingRuleCreateRequest(
            idempotencyKey: "rule-create-shape-1",
            enabled: true,
            ruleType: .prefix,
            condition: "  gym:  ",
            destination: .note(noteID),
            priority: 250
        )
        let createObject = try jsonObject(create)
        XCTAssertEqual(
            Set(createObject.keys),
            ["idempotencyKey", "enabled", "ruleType", "condition", "destination", "priority"]
        )
        XCTAssertEqual(createObject["condition"] as? String, "gym:")
        XCTAssertEqual(createObject["priority"] as? Int, 250)
        XCTAssertEqual(
            (createObject["destination"] as? [String: String])?["noteId"],
            noteID.rawValue
        )

        let update = try RoutingRuleUpdateRequest(
            expectedRevision: 7,
            idempotencyKey: "rule-update-shape-1",
            enabled: false
        )
        let updateObject = try jsonObject(update)
        XCTAssertEqual(
            Set(updateObject.keys),
            ["expectedRevision", "idempotencyKey", "enabled"]
        )
        XCTAssertEqual(updateObject["expectedRevision"] as? Int, 7)
        XCTAssertEqual(updateObject["enabled"] as? Bool, false)

        let unicodeWhitespace = try RoutingRuleCreateRequest(
            idempotencyKey: "rule-create-shape-2",
            enabled: true,
            ruleType: .phrase,
            condition: "\u{0085}gym\u{0085}",
            destination: .note(noteID),
            priority: 1
        )
        XCTAssertEqual(try jsonObject(unicodeWhitespace)["condition"] as? String, "gym")
        XCTAssertEqual(
            RoutingRuleConditionCanonicalizer.normalize("\u{FEFF}ＧＹＭ\u{FEFF}"),
            "\u{FEFF}gym\u{FEFF}"
        )
        XCTAssertThrowsError(
            try RoutingRuleCreateRequest(
                idempotencyKey: "rule-create-shape-3",
                enabled: true,
                ruleType: .phrase,
                condition: "! \u{0085} ?",
                destination: .note(noteID),
                priority: 1
            )
        )
        XCTAssertThrowsError(
            try RoutingRuleCreateRequest(
                idempotencyKey: "rule-create-shape-4",
                enabled: true,
                ruleType: .phrase,
                condition: String(repeating: "㍿", count: 126),
                destination: .note(noteID),
                priority: 1
            )
        )
    }

    func testCollectionAppliesLoadMutationAndDeleteTransitionsDeterministically() throws {
        let lower = try rule(
            id: "rule_00000000000000000000000000",
            revision: 1,
            priority: 10
        )
        let higher = try rule(
            id: "rule_11111111111111111111111111",
            revision: 1,
            priority: 500
        )
        var collection = RoutingRuleCollection()
        collection.replace(with: [lower, higher])
        XCTAssertEqual(collection.items.map(\.id.rawValue), [higher.id.rawValue, lower.id.rawValue])

        let accepted = try rule(
            id: lower.id.rawValue,
            revision: 2,
            enabled: true,
            priority: 900,
            source: "correction_suggested",
            proposalState: #""accepted""#
        )
        collection.upsert(accepted)
        XCTAssertEqual(collection.items.first?.id, lower.id)
        XCTAssertEqual(collection.items.first?.revision, 2)
        XCTAssertEqual(collection.items.first?.proposalState, .accepted)

        collection.upsert(lower)
        XCTAssertEqual(collection.items.first?.revision, 2)
        collection.replace(with: [lower, higher])
        XCTAssertEqual(collection.items.first?.revision, 2)

        let operationalRefresh = try rule(
            id: lower.id.rawValue,
            revision: 2,
            enabled: true,
            priority: 900,
            source: "correction_suggested",
            proposalState: #""accepted""#,
            destinationStatus: "archived",
            lastFiredAt: #""2026-09-01T12:30:00Z""#
        )
        collection.replace(with: [operationalRefresh, higher])
        XCTAssertEqual(collection.items.first?.destinationStatus, .archived)
        XCTAssertNotNil(collection.items.first?.lastFiredAt)

        collection.remove(ruleID: lower.id)
        XCTAssertEqual(collection.items.map(\.id), [higher.id])
    }

    func testFormDraftBlocksUnavailableDestinationAndRejectsOfferedProposalEdits() throws {
        let archived = try rule(
            enabled: false,
            destinationStatus: "archived"
        )
        var archivedDraft = RoutingRuleFormDraft(rule: archived)
        XCTAssertNil(archivedDraft.destination)
        XCTAssertFalse(archivedDraft.canSave)
        archivedDraft.destination = .space(
            try SpaceID(validating: "spc_00000000000000000000000000")
        )
        XCTAssertTrue(archivedDraft.canSave)

        let offered = try rule(
            enabled: false,
            source: "correction_suggested",
            proposalState: #""offered""#
        )
        var offeredDraft = RoutingRuleFormDraft(rule: offered)
        offeredDraft.enabled = true
        offeredDraft.priority += 1
        XCTAssertTrue(offeredDraft.isOfferedProposal)
        XCTAssertFalse(offeredDraft.hasChanges)
        XCTAssertFalse(offeredDraft.canSave)
        XCTAssertThrowsError(
            try offeredDraft.updateRequest(idempotencyKey: "learned-edit-1")
        ) { error in
            XCTAssertEqual(
                error as? DomainValidationError,
                .invalidValue("An editable routing rule is required")
            )
        }
    }

    func testRoutingDestinationEligibilityExcludesPrivateAndClosedNotes() {
        func note(
            privacy: PrivacyMode = .aiAssisted,
            isOpen: Bool = true,
            archived: Bool = false,
            deleted: Bool = false
        ) -> NotePresentation {
            NotePresentation(
                id: "note_00000000000000000000000000",
                title: "Principles",
                type: "principle",
                preview: "",
                updatedLabel: "Now",
                updatedAt: "2026-09-01T12:00:00Z",
                spaceID: nil,
                currentRevision: 1,
                isOpen: isOpen,
                privacy: privacy,
                archived: archived,
                deleted: deleted,
                pinned: false
            )
        }

        XCTAssertTrue(note().isRoutableRoutingRuleDestination)
        XCTAssertFalse(note(privacy: .privateManual).isRoutableRoutingRuleDestination)
        XCTAssertFalse(note(isOpen: false).isRoutableRoutingRuleDestination)
        XCTAssertFalse(note(archived: true).isRoutableRoutingRuleDestination)
        XCTAssertFalse(note(deleted: true).isRoutableRoutingRuleDestination)
    }

    func testEditorContextRejectsOfferedRulesButAllowsExplicitAndAcceptedRules() throws {
        let explicit = try rule(enabled: true, source: "explicit", proposalState: "null")
        let offered = try rule(
            enabled: false,
            source: "correction_suggested",
            proposalState: #""offered""#
        )
        let accepted = try rule(
            enabled: true,
            source: "correction_suggested",
            proposalState: #""accepted""#
        )

        XCTAssertNotNil(RoutingRuleEditorContext(rule: nil))
        XCTAssertNotNil(RoutingRuleEditorContext(rule: explicit))
        XCTAssertNil(RoutingRuleEditorContext(rule: offered))
        XCTAssertNotNil(RoutingRuleEditorContext(rule: accepted))

        var acceptedDraft = RoutingRuleFormDraft(rule: accepted)
        acceptedDraft.priority += 1
        XCTAssertTrue(acceptedDraft.hasChanges)
        XCTAssertTrue(acceptedDraft.canSave)
        let acceptedUpdate = try acceptedDraft.updateRequest(
            idempotencyKey: "learned-accepted-edit-1"
        )
        XCTAssertEqual(
            try jsonObject(acceptedUpdate)["priority"] as? Int,
            accepted.priority + 1
        )
    }

    func testRoutingRuleAccessibilityIdentifiersAreStableAndRuleScoped() {
        let ruleID = "rule_00000000000000000000000000"
        XCTAssertEqual(RoutingRuleAccessibilityIdentifier.settingsLink, "settings.routingRules")
        XCTAssertEqual(RoutingRuleAccessibilityIdentifier.screen, "routingRules.screen")
        XCTAssertEqual(RoutingRuleAccessibilityIdentifier.editorSave, "routingRules.editor.save")
        XCTAssertEqual(
            RoutingRuleAccessibilityIdentifier.row(ruleID),
            "routingRules.row.\(ruleID)"
        )
        XCTAssertEqual(
            RoutingRuleAccessibilityIdentifier.accept(ruleID),
            "routingRules.accept.\(ruleID)"
        )
        XCTAssertEqual(
            RoutingRuleAccessibilityIdentifier.decline(ruleID),
            "routingRules.decline.\(ruleID)"
        )
        XCTAssertEqual(
            RoutingRuleAccessibilityIdentifier.toggle(ruleID),
            "routingRules.toggle.\(ruleID)"
        )
        XCTAssertEqual(
            RoutingRuleAccessibilityIdentifier.previewSample,
            "routingRules.preview.sample"
        )
        XCTAssertEqual(
            RoutingRuleAccessibilityIdentifier.previewAction,
            "routingRules.preview.action"
        )
        XCTAssertEqual(
            RoutingRuleAccessibilityIdentifier.previewResult,
            "routingRules.preview.result"
        )
    }

    func testPreviewPresentationReportsOnlyALocalConditionMatch() throws {
        XCTAssertEqual(RoutingRulePreviewPresentation.sectionLabel, "Local condition check")
        XCTAssertEqual(RoutingRulePreviewPresentation.heading, "Preview which rule matches")
        XCTAssertEqual(RoutingRulePreviewPresentation.actionTitle, "Check rule match")

        let matched = RoutingRulePreviewPresentation.matched(
            rule: try rule(condition: "gym:"),
            destinationLabel: "Training log"
        )
        XCTAssertEqual(matched.title, "Rule condition matched locally")
        XCTAssertEqual(
            matched.details,
            [
                "Explicit rule · gym:",
                "Configured destination: Training log",
                "This local check does not confirm actual routing or destination eligibility",
            ]
        )
        XCTAssertEqual(
            matched.accessibilityLabel,
            "Rule condition matched locally. Explicit rule · gym:. Configured destination: "
                + "Training log. This local check does not confirm actual routing or "
                + "destination eligibility"
        )
        XCTAssertFalse(matched.accessibilityLabel.contains("Routes to"))
        XCTAssertFalse(matched.accessibilityLabel.contains("Would route to"))

        XCTAssertEqual(RoutingRulePreviewPresentation.noMatch.title, "No rule condition matched")
        XCTAssertTrue(
            RoutingRulePreviewPresentation.noMatch.accessibilityLabel.contains(
                "does not confirm actual routing or destination eligibility"
            )
        )
        XCTAssertFalse(
            RoutingRulePreviewPresentation.noMatch.accessibilityLabel.contains(
                "would use general organization"
            )
        )
    }

    func testPreviewMatchesPrefixOnlyBeforeColonOrSpaceWithFrozenNormalization() throws {
        let prefix = try rule(
            ruleType: "prefix",
            condition: "gym",
            normalizedCondition: "gym"
        )

        XCTAssertEqual(
            RoutingRulePreviewMatcher.match(sample: "  ＧＹＭ: squats!!!  ", rules: [prefix])?.id,
            prefix.id
        )
        XCTAssertEqual(
            RoutingRulePreviewMatcher.match(sample: "gym   squats", rules: [prefix])?.id,
            prefix.id
        )
        XCTAssertNil(RoutingRulePreviewMatcher.match(sample: "gym", rules: [prefix]))
        XCTAssertNil(RoutingRulePreviewMatcher.match(sample: "gymnastics", rules: [prefix]))
    }

    func testPreviewPhraseUsesWholePhraseInsideFirstEightyUnicodeCodePoints() throws {
        let phrase = try rule(
            ruleType: "phrase",
            condition: "mindset",
            normalizedCondition: "mindset"
        )

        XCTAssertEqual(
            RoutingRulePreviewMatcher.match(
                sample: "routine mindset reset",
                rules: [phrase]
            )?.id,
            phrase.id
        )
        XCTAssertNil(
            RoutingRulePreviewMatcher.match(sample: "mindsets are useful", rules: [phrase])
        )
        XCTAssertNil(
            RoutingRulePreviewMatcher.match(
                sample: String(repeating: "x", count: 79) + " mindset",
                rules: [phrase]
            )
        )
    }

    func testPreviewAliasAndDestinationMentionUseExactWholeTailSemantics() throws {
        let alias = try rule(
            id: "rule_00000000000000000000000000",
            ruleType: "alias",
            condition: "gym",
            normalizedCondition: "gym",
            aliases: ["lift"]
        )
        let destinationMention = try rule(
            id: "rule_11111111111111111111111111",
            ruleType: "destination_mention",
            condition: "shopping",
            normalizedCondition: "shopping"
        )

        XCTAssertEqual(
            RoutingRulePreviewMatcher.match(sample: "today I lift safely", rules: [alias])?.id,
            alias.id
        )
        XCTAssertNil(
            RoutingRulePreviewMatcher.match(sample: "weightlifting", rules: [alias])
        )
        XCTAssertEqual(
            RoutingRulePreviewMatcher.match(
                sample: "add oat milk to shopping.",
                rules: [destinationMention]
            )?.id,
            destinationMention.id
        )
        XCTAssertNil(
            RoutingRulePreviewMatcher.match(
                sample: "add oat milk to shopping later",
                rules: [destinationMention]
            )
        )
    }

    func testPreviewExcludesUnconfirmedDisabledAndInvalidRules() throws {
        let offered = try rule(
            id: "rule_00000000000000000000000000",
            enabled: false,
            priority: 900,
            source: "correction_suggested",
            proposalState: #""offered""#,
            normalizedCondition: "gym"
        )
        let disabled = try rule(
            id: "rule_11111111111111111111111111",
            enabled: false,
            priority: 800,
            normalizedCondition: "gym"
        )
        let archived = try rule(
            id: "rule_22222222222222222222222222",
            enabled: true,
            priority: 700,
            destinationStatus: "archived",
            normalizedCondition: "gym"
        )
        let accepted = try rule(
            id: "rule_33333333333333333333333333",
            enabled: true,
            priority: 10,
            source: "correction_suggested",
            proposalState: #""accepted""#,
            normalizedCondition: "gym"
        )

        XCTAssertNil(
            RoutingRulePreviewMatcher.match(
                sample: "gym: squats",
                rules: [offered, disabled, archived]
            )
        )
        XCTAssertEqual(
            RoutingRulePreviewMatcher.match(
                sample: "gym: squats",
                rules: [offered, disabled, archived, accepted]
            )?.id,
            accepted.id
        )
    }

    func testPreviewUsesPriorityThenAscendingRuleIDAndBoundsUnicodeCodePoints() throws {
        let lowerPriority = try rule(
            id: "rule_00000000000000000000000000",
            priority: 99,
            normalizedCondition: "gym"
        )
        let laterID = try rule(
            id: "rule_22222222222222222222222222",
            priority: 100,
            normalizedCondition: "gym"
        )
        let earlierID = try rule(
            id: "rule_11111111111111111111111111",
            priority: 100,
            normalizedCondition: "gym"
        )

        XCTAssertEqual(
            RoutingRulePreviewMatcher.match(
                sample: "gym: squats",
                rules: [laterID, lowerPriority, earlierID]
            )?.id,
            earlierID.id
        )

        let oversized = String(
            repeating: "📝",
            count: RoutingRulePreviewMatcher.maximumSampleCodePoints + 2
        )
        XCTAssertEqual(
            RoutingRulePreviewMatcher.boundedSample(oversized).unicodeScalars.count,
            RoutingRulePreviewMatcher.maximumSampleCodePoints
        )
    }

    func testRulePresentationShowsEverySourceAndLastFiredMetadata() throws {
        let explicit = try rule(lastFiredAt: "null")
        let learned = try rule(
            source: "correction_suggested",
            proposalState: #""accepted""#,
            lastFiredAt: #""2026-09-01T12:00:00Z""#
        )

        XCTAssertEqual(RoutingRulePresentation.sourceLabel(for: explicit), "Explicit")
        XCTAssertEqual(RoutingRulePresentation.sourceLabel(for: learned), "Learned")
        XCTAssertEqual(RoutingRulePresentation.lastFiredLabel(for: explicit), "Never fired")
        XCTAssertEqual(
            RoutingRulePresentation.lastFiredLabel(
                for: learned,
                formatDate: { _ in "Sep 1, 2026 at 12:00 PM" }
            ),
            "Last fired Sep 1, 2026 at 12:00 PM"
        )
    }

    private func jsonObject<T: Encodable>(_ value: T) throws -> [String: Any] {
        try XCTUnwrap(
            JSONSerialization.jsonObject(
                with: APIJSON.makeEncoder().encode(value)
            ) as? [String: Any]
        )
    }

    private func rule(
        id: String = "rule_00000000000000000000000000",
        revision: Int = 1,
        enabled: Bool = true,
        priority: Int = 100,
        source: String = "explicit",
        proposalState: String = "null",
        destinationStatus: String = "active",
        ruleType: String = "prefix",
        condition: String = "gym:",
        normalizedCondition: String = "gym",
        aliases: [String] = [],
        lastFiredAt: String = "null"
    ) throws -> RoutingRule {
        let aliasesData = try JSONSerialization.data(withJSONObject: aliases)
        let aliasesJSON = String(decoding: aliasesData, as: UTF8.self)
        let json = #"{"id":"\#(id)","revision":\#(revision),"enabled":\#(enabled),"ruleType":"\#(ruleType)","condition":"\#(condition)","destination":{"type":"note","noteId":"note_00000000000000000000000000"},"priority":\#(priority),"normalizedCondition":"\#(normalizedCondition)","aliases":\#(aliasesJSON),"source":"\#(source)","proposalState":\#(proposalState),"destinationStatus":"\#(destinationStatus)","lastFiredAt":\#(lastFiredAt),"createdAt":"2026-09-01T12:00:00Z","updatedAt":"2026-09-01T12:00:00Z"}"#
        return try APIJSON.makeDecoder().decode(RoutingRule.self, from: Data(json.utf8))
    }
}
