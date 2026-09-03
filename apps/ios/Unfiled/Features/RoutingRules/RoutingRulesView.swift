import SwiftUI

struct RoutingRulesView: View {
    let rules: [RoutingRule]
    let notes: [NotePresentation]
    let spaces: [SpacePresentation]
    let isLoading: Bool
    let hasLoaded: Bool
    let errorMessage: String?
    let submittingRuleIDs: Set<String>
    let onRefresh: @MainActor () async -> Void
    let onSave: @MainActor (RoutingRuleFormDraft) async -> Bool
    let onSetEnabled: @MainActor (String, Bool) async -> Void
    let onAccept: @MainActor (String) async -> Void
    let onRemove: @MainActor (String) async -> Void

    @State private var editor: RoutingRuleEditorContext?
    @State private var pendingRemoval: RoutingRule?
    @State private var previewSample = ""
    @State private var hasPreviewed = false

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                header

                routingPreview
                    .padding(.top, UnfiledTheme.sectionTop)

                if let errorMessage, !rules.isEmpty {
                    inlineError(errorMessage)
                        .padding(.top, 20)
                }

                content
                    .padding(.top, UnfiledTheme.sectionTop)
            }
            .padding(.horizontal, UnfiledTheme.screenPadding)
            .padding(.bottom, UnfiledTheme.pushedScreenBottom)
        }
        .refreshable { await onRefresh() }
        .navigationBarTitleDisplayMode(.inline)
        .navigationTitle("Routing rules")
        .accessibilityIdentifier(RoutingRuleAccessibilityIdentifier.screen)
        .unfiledScreen()
        .sheet(item: $editor) { context in
            RoutingRuleEditorView(
                context: context,
                notes: activeNotes,
                spaces: spaces,
                onSave: onSave
            )
        }
        .confirmationDialog(
            pendingRemoval?.proposalState == .offered
                ? "Decline this suggestion?"
                : "Delete this routing rule?",
            isPresented: Binding(
                get: { pendingRemoval != nil },
                set: { if !$0 { pendingRemoval = nil } }
            ),
            titleVisibility: .visible
        ) {
            if let pendingRemoval {
                Button(
                    pendingRemoval.proposalState == .offered
                        ? "Decline suggestion"
                        : "Delete rule",
                    role: .destructive
                ) {
                    let ruleID = pendingRemoval.id.rawValue
                    self.pendingRemoval = nil
                    Task { @MainActor in await onRemove(ruleID) }
                }
            }
            Button("Cancel", role: .cancel) { pendingRemoval = nil }
        } message: {
            if pendingRemoval?.proposalState == .offered {
                Text("It will stay suppressed so Unfiled does not keep offering the same learned rule.")
            } else {
                Text("New captures will no longer use this rule. Existing notes are unchanged.")
            }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 0) {
            EditorialEyebrow(text: "Automatic filing")
                .padding(.top, UnfiledTheme.pushedHeaderTop)

            Text("Send familiar jots where they belong.")
                .font(UnfiledType.display)
                .tracking(-1.35)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, UnfiledTheme.eyebrowToTitle)

            Text("A matching rule chooses a note or space before general organization. Learned suggestions always stay off until you approve them.")
                .font(UnfiledType.body)
                .foregroundStyle(UnfiledTheme.fog)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 13)

            Button {
                editor = RoutingRuleEditorContext(rule: nil)
            } label: {
                HStack(spacing: 10) {
                    GlyphView(glyph: .plus, size: 16, weight: 2.2)
                    Text("New routing rule")
                        .font(UnfiledType.heading)
                    Spacer()
                    GlyphView(glyph: .arrow, size: 14, weight: 2)
                }
                .foregroundStyle(UnfiledTheme.ink)
                .frame(maxWidth: .infinity, minHeight: UnfiledTheme.controlHeight)
                .padding(.horizontal, UnfiledTheme.fieldPadding)
                .background(
                    isLoading && !hasLoaded ? UnfiledTheme.fog : UnfiledTheme.persimmon
                )
                .clipShape(RoundedRectangle(cornerRadius: UnfiledTheme.controlRadius))
            }
            .buttonStyle(.plain)
            .disabled(isLoading && !hasLoaded)
            .accessibilityIdentifier(RoutingRuleAccessibilityIdentifier.create)
            .padding(.top, UnfiledTheme.headerBottom)
        }
    }

    private var routingPreview: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                VStack(alignment: .leading, spacing: 7) {
                    EditorialEyebrow(text: RoutingRulePreviewPresentation.sectionLabel)
                    Text(RoutingRulePreviewPresentation.heading)
                        .font(UnfiledType.title)
                        .foregroundStyle(UnfiledTheme.paper)
                }
                Spacer(minLength: 8)
                Text("ON THIS DEVICE ONLY")
                    .font(UnfiledType.label)
                    .tracking(0.75)
                    .foregroundStyle(UnfiledTheme.persimmon)
            }

            VStack(alignment: .leading, spacing: 9) {
                Text("Sample capture")
                    .font(UnfiledType.label)
                    .tracking(0.75)
                    .foregroundStyle(UnfiledTheme.fog)

                TextField(
                    "For example: gym: squats",
                    text: previewSampleBinding,
                    axis: .vertical
                )
                .lineLimit(2 ... 5)
                .padding(.horizontal, UnfiledTheme.fieldPadding)
                .padding(.vertical, 13)
                .frame(maxWidth: .infinity, minHeight: 82, alignment: .topLeading)
                .background(UnfiledTheme.ink)
                .overlay {
                    RoundedRectangle(cornerRadius: UnfiledTheme.controlRadius)
                        .stroke(UnfiledTheme.border)
                }
                .clipShape(RoundedRectangle(cornerRadius: UnfiledTheme.controlRadius))
                .accessibilityIdentifier(RoutingRuleAccessibilityIdentifier.previewSample)

                HStack(alignment: .top, spacing: 12) {
                    Text(RoutingRulePreviewPresentation.privacyDetail)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 8)
                    Text("\(previewSample.unicodeScalars.count)/\(RoutingRulePreviewMatcher.maximumSampleCodePoints)")
                        .monospacedDigit()
                }
                .font(UnfiledType.caption)
                .foregroundStyle(UnfiledTheme.fog)
            }
            .padding(.top, 20)

            SectionRule()
                .padding(.top, 18)

            HStack(spacing: UnfiledTheme.controlGap) {
                Button("Clear") {
                    previewSample = ""
                    hasPreviewed = false
                }
                .font(UnfiledType.secondaryStrong)
                .foregroundStyle(UnfiledTheme.fog)
                .frame(minWidth: 72, minHeight: UnfiledTheme.minimumTouchTarget)
                .buttonStyle(.plain)
                .disabled(previewSample.isEmpty)

                Spacer()

                Button {
                    hasPreviewed = true
                } label: {
                    GlyphLabel(RoutingRulePreviewPresentation.actionTitle, glyph: .arrow)
                        .font(UnfiledType.secondaryStrong)
                        .frame(minHeight: UnfiledTheme.minimumTouchTarget)
                        .padding(.horizontal, UnfiledTheme.fieldPadding)
                        .foregroundStyle(UnfiledTheme.ink)
                        .background(canPreview ? UnfiledTheme.persimmon : UnfiledTheme.fog)
                        .clipShape(RoundedRectangle(cornerRadius: UnfiledTheme.controlRadius))
                }
                .buttonStyle(.plain)
                .disabled(!canPreview)
                .accessibilityIdentifier(RoutingRuleAccessibilityIdentifier.previewAction)
            }
            .padding(.top, 10)

            previewResult
                .padding(.top, 14)
        }
        .padding(UnfiledTheme.cardPadding)
        .background(UnfiledTheme.graphite)
        .clipShape(RoundedRectangle(cornerRadius: 16))
        .overlay {
            RoundedRectangle(cornerRadius: 16)
                .stroke(UnfiledTheme.border)
        }
    }

    @ViewBuilder
    private var previewResult: some View {
        let presentation = previewResultPresentation

        VStack(alignment: .leading, spacing: 5) {
            Text(presentation.title)
                .font(UnfiledType.secondaryStrong)
            ForEach(Array(presentation.details.enumerated()), id: \.offset) { _, detail in
                Text(detail)
                    .font(UnfiledType.caption)
                    .foregroundStyle(UnfiledTheme.fog)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(UnfiledTheme.cardPadding)
        .background(UnfiledTheme.raised)
        .clipShape(RoundedRectangle(cornerRadius: UnfiledTheme.controlRadius))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(presentation.accessibilityLabel)
        .accessibilityIdentifier(RoutingRuleAccessibilityIdentifier.previewResult)
    }

    private var previewResultPresentation: RoutingRulePreviewPresentation {
        guard hasPreviewed else { return .ready }
        guard let rule = previewedRule else { return .noMatch }
        return .matched(rule: rule, destinationLabel: destinationLabel(for: rule))
    }

    private var previewSampleBinding: Binding<String> {
        Binding(
            get: { previewSample },
            set: {
                previewSample = RoutingRulePreviewMatcher.boundedSample($0)
                hasPreviewed = false
            }
        )
    }

    private var canPreview: Bool {
        hasLoaded && !previewSample.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var previewedRule: RoutingRule? {
        guard hasPreviewed else { return nil }
        return RoutingRulePreviewMatcher.match(sample: previewSample, rules: rules)
    }

    @ViewBuilder
    private var content: some View {
        if isLoading, !hasLoaded {
            HStack(spacing: 12) {
                ProgressView()
                Text("Loading protected rules…")
                    .foregroundStyle(UnfiledTheme.fog)
            }
            .frame(maxWidth: .infinity, minHeight: 160)
            .accessibilityIdentifier(RoutingRuleAccessibilityIdentifier.loading)
        } else if let errorMessage, rules.isEmpty {
            VStack(alignment: .leading, spacing: 14) {
                GlyphView(glyph: .warning, size: 24, weight: 2.3)
                    .foregroundStyle(UnfiledTheme.persimmon)
                Text("Rules are unavailable")
                    .font(UnfiledType.title)
                Text(errorMessage)
                    .font(UnfiledType.secondary)
                    .foregroundStyle(UnfiledTheme.fog)
                    .fixedSize(horizontal: false, vertical: true)
                Button("Try again") {
                    Task { @MainActor in await onRefresh() }
                }
                .font(UnfiledType.secondaryStrong)
                .foregroundStyle(UnfiledTheme.persimmon)
                .frame(minHeight: UnfiledTheme.minimumTouchTarget)
            }
            .frame(maxWidth: .infinity, minHeight: 220, alignment: .leading)
            .accessibilityIdentifier(RoutingRuleAccessibilityIdentifier.error)
        } else if rules.isEmpty {
            EmptyLedgerView(
                title: "No routing rules yet",
                message: "Create one for repeated phrases such as “gym:” or “shopping.” You can pause or edit it at any time.",
                actionTitle: "Create your first rule",
                action: { editor = RoutingRuleEditorContext(rule: nil) }
            )
            .accessibilityIdentifier(RoutingRuleAccessibilityIdentifier.empty)
        } else {
            let proposals = rules.filter { $0.proposalState == .offered }
            let savedRules = rules.filter { $0.proposalState != .offered }

            if !proposals.isEmpty {
                ruleSection(
                    title: "Needs your approval",
                    message: "Suggestions appear only after repeated corrections. They cannot file anything until you accept them.",
                    rules: proposals
                )
            }

            if !savedRules.isEmpty {
                ruleSection(
                    title: "Your rules",
                    message: nil,
                    rules: savedRules
                )
                .padding(.top, proposals.isEmpty ? 0 : UnfiledTheme.sectionTop)
            }
        }
    }

    private func ruleSection(
        title: String,
        message: String?,
        rules: [RoutingRule]
    ) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            EditorialEyebrow(text: title)
            if let message {
                Text(message)
                    .font(UnfiledType.secondary)
                    .foregroundStyle(UnfiledTheme.fog)
                    .fixedSize(horizontal: false, vertical: true)
            }
            ForEach(rules, id: \.id.rawValue) { rule in
                RoutingRuleCard(
                    rule: rule,
                    destinationLabel: destinationLabel(for: rule),
                    isSubmitting: submittingRuleIDs.contains(rule.id.rawValue),
                    onEdit: {
                        guard let context = RoutingRuleEditorContext(rule: rule) else { return }
                        editor = context
                    },
                    onSetEnabled: { enabled in
                        Task { @MainActor in
                            await onSetEnabled(rule.id.rawValue, enabled)
                        }
                    },
                    onAccept: {
                        Task { @MainActor in await onAccept(rule.id.rawValue) }
                    },
                    onRemove: { pendingRemoval = rule }
                )
            }
        }
    }

    private func inlineError(_ message: String) -> some View {
        GlyphLabel(message, glyph: .warning)
            .font(UnfiledType.secondary)
            .foregroundStyle(UnfiledTheme.paper)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .background(UnfiledTheme.raised)
            .clipShape(RoundedRectangle(cornerRadius: UnfiledTheme.controlRadius))
            .accessibilityIdentifier(RoutingRuleAccessibilityIdentifier.error)
    }

    private var activeNotes: [NotePresentation] {
        notes.filter(\.isRoutableRoutingRuleDestination)
    }

    private func destinationLabel(for rule: RoutingRule) -> String {
        guard rule.destinationStatus == .active else {
            return switch rule.destinationStatus {
            case .active: "Active destination"
            case .archived: "Archived destination"
            case .deleted: "Deleted destination"
            case .missing: "Missing destination"
            }
        }
        return switch rule.destination {
        case let .note(noteID):
            activeNotes.first(where: { $0.id == noteID.rawValue })?.title ?? "Active note"
        case let .space(spaceID):
            spaces.first(where: { $0.id == spaceID.rawValue })?.name ?? "Active space"
        }
    }
}

struct RoutingRuleEditorContext: Identifiable {
    let rule: RoutingRule?
    let id: String

    init?(rule: RoutingRule?) {
        guard rule?.proposalState != .offered else { return nil }
        self.rule = rule
        id = rule?.id.rawValue ?? "new-routing-rule"
    }
}

private struct RoutingRuleCard: View {
    let rule: RoutingRule
    let destinationLabel: String
    let isSubmitting: Bool
    let onEdit: @MainActor () -> Void
    let onSetEnabled: @MainActor (Bool) -> Void
    let onAccept: @MainActor () -> Void
    let onRemove: @MainActor () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 7) {
                    Text(rule.condition)
                        .font(UnfiledType.title)
                        .foregroundStyle(UnfiledTheme.paper)
                        .fixedSize(horizontal: false, vertical: true)
                    GlyphLabel(destinationLabel, glyph: destinationIcon, size: 14, weight: 1.9)
                        .font(UnfiledType.secondary)
                        .foregroundStyle(isDestinationAvailable ? UnfiledTheme.fog : UnfiledTheme.persimmon)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 8)
                badge
            }

            HStack(spacing: 8) {
                Text(ruleTypeLabel)
                Text("P\(rule.priority)")
                Text(RoutingRulePresentation.sourceLabel(for: rule))
            }
            .font(UnfiledType.label)
            .tracking(0.7)
            .foregroundStyle(UnfiledTheme.fog)
            .padding(.top, 13)

            Text(RoutingRulePresentation.lastFiredLabel(for: rule))
                .font(UnfiledType.caption)
                .foregroundStyle(UnfiledTheme.fog)
                .padding(.top, 7)

            if !isDestinationAvailable {
                Text(unavailableDestinationMessage)
                    .font(UnfiledType.caption)
                    .foregroundStyle(UnfiledTheme.persimmon)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 13)
            }

            if rule.proposalState == .offered {
                Text("Suggested from repeated corrections. It is off and will never activate without your confirmation.")
                    .font(UnfiledType.caption)
                    .foregroundStyle(UnfiledTheme.fog)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 13)
                proposalActions
                    .padding(.top, 18)
            } else {
                savedRuleActions
                    .padding(.top, 18)
            }
        }
        .padding(UnfiledTheme.cardPadding)
        .background(UnfiledTheme.graphite)
        .clipShape(RoundedRectangle(cornerRadius: 16))
        .overlay {
            RoundedRectangle(cornerRadius: 16)
                .stroke(isDestinationAvailable ? UnfiledTheme.border : UnfiledTheme.persimmon.opacity(0.5))
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(RoutingRuleAccessibilityIdentifier.row(rule.id.rawValue))
    }

    private var proposalActions: some View {
        VStack(spacing: UnfiledTheme.controlGap) {
            Button(action: onAccept) {
                HStack(spacing: 7) {
                    if isSubmitting { ProgressView().controlSize(.small) }
                    Text(isDestinationAvailable ? "Accept and turn on" : "Cannot accept")
                        .font(UnfiledType.secondaryStrong)
                }
                .frame(maxWidth: .infinity, minHeight: UnfiledTheme.controlHeight)
                .foregroundStyle(UnfiledTheme.ink)
                .background(isDestinationAvailable ? UnfiledTheme.persimmon : UnfiledTheme.fog)
                .clipShape(RoundedRectangle(cornerRadius: 11))
            }
            .buttonStyle(.plain)
            .disabled(isSubmitting || !isDestinationAvailable)
            .accessibilityIdentifier(RoutingRuleAccessibilityIdentifier.accept(rule.id.rawValue))

            Button("Decline suggestion", role: .destructive, action: onRemove)
                .font(UnfiledType.caption)
                .foregroundStyle(UnfiledTheme.persimmon)
                .frame(maxWidth: .infinity, minHeight: UnfiledTheme.minimumTouchTarget)
                .buttonStyle(.plain)
                .disabled(isSubmitting)
                .accessibilityHint("Prevents this same suggestion from being offered again")
                .accessibilityIdentifier(RoutingRuleAccessibilityIdentifier.decline(rule.id.rawValue))
        }
    }

    private var savedRuleActions: some View {
        VStack(spacing: UnfiledTheme.controlGap) {
            HStack(spacing: UnfiledTheme.controlGap) {
                Text(isDestinationAvailable ? (rule.enabled ? "On" : "Off") : "Blocked")
                    .font(UnfiledType.secondaryStrong)
                    .foregroundStyle(isDestinationAvailable ? UnfiledTheme.paper : UnfiledTheme.persimmon)
                Spacer()
                Button {
                    onSetEnabled(!rule.enabled)
                } label: {
                    GlyphView(glyph: rule.enabled ? .checkCircle : .circle, size: 24, weight: 2.2)
                        .foregroundStyle(rule.enabled ? UnfiledTheme.persimmon : UnfiledTheme.fog)
                        .frame(width: UnfiledTheme.minimumTouchTarget, height: UnfiledTheme.minimumTouchTarget)
                }
                .buttonStyle(.plain)
                .disabled(isSubmitting || (!isDestinationAvailable && !rule.enabled))
                .accessibilityLabel(rule.enabled ? "Turn rule off" : "Turn rule on")
                .accessibilityValue(rule.enabled ? "On" : "Off")
                .accessibilityIdentifier(RoutingRuleAccessibilityIdentifier.toggle(rule.id.rawValue))
            }
            .frame(minHeight: UnfiledTheme.minimumTouchTarget)

            SectionRule()

            HStack(spacing: 18) {
                Button("Edit", action: onEdit)
                    .foregroundStyle(UnfiledTheme.paper)
                    .accessibilityIdentifier(RoutingRuleAccessibilityIdentifier.edit(rule.id.rawValue))
                Spacer()
                Button("Delete", role: .destructive, action: onRemove)
                    .foregroundStyle(UnfiledTheme.persimmon)
                    .accessibilityIdentifier(RoutingRuleAccessibilityIdentifier.delete(rule.id.rawValue))
            }
            .font(UnfiledType.secondaryStrong)
            .frame(minHeight: UnfiledTheme.minimumTouchTarget)
            .buttonStyle(.plain)
            .disabled(isSubmitting)
        }
    }

    private var badge: some View {
        Text(badgeLabel)
            .font(UnfiledType.label)
            .tracking(0.8)
            .foregroundStyle(badgeColor)
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .background(badgeColor.opacity(0.13))
            .clipShape(Capsule())
    }

    private var badgeLabel: String {
        if rule.proposalState == .offered { return "SUGGESTED" }
        if !isDestinationAvailable { return "BLOCKED" }
        return rule.enabled ? "ACTIVE" : "PAUSED"
    }

    private var badgeColor: Color {
        if rule.proposalState == .offered || !isDestinationAvailable {
            return UnfiledTheme.persimmon
        }
        return rule.enabled ? UnfiledTheme.paper : UnfiledTheme.fog
    }

    private var isDestinationAvailable: Bool { rule.destinationStatus == .active }

    private var unavailableDestinationMessage: String {
        if rule.proposalState == .offered {
            return "This suggestion cannot be accepted because its destination is unavailable. Decline it to remove it."
        }
        return "This rule is blocked. Choose an active destination before turning it on."
    }

    private var destinationIcon: UnfiledGlyph {
        switch rule.destination {
        case .note: .card
        case .space: .tray
        }
    }

    private var ruleTypeLabel: String {
        switch rule.ruleType {
        case .prefix: "STARTS WITH"
        case .phrase: "CONTAINS"
        case .alias: "ALIAS"
        case .destinationMention: "TO / IN"
        }
    }
}

private enum RoutingRuleDestinationKind: String, CaseIterable, Identifiable {
    case note = "Note"
    case space = "Space"

    var id: String { rawValue }
}

private struct RoutingRuleEditorView: View {
    @Environment(\.dismiss) private var dismiss

    let context: RoutingRuleEditorContext
    let notes: [NotePresentation]
    let spaces: [SpacePresentation]
    let onSave: @MainActor (RoutingRuleFormDraft) async -> Bool

    @State private var draft: RoutingRuleFormDraft
    @State private var destinationKind: RoutingRuleDestinationKind
    @State private var selectedDestinationID: String?
    @State private var isSaving = false
    @State private var errorMessage: String?
    @FocusState private var conditionFocused: Bool

    init(
        context: RoutingRuleEditorContext,
        notes: [NotePresentation],
        spaces: [SpacePresentation],
        onSave: @escaping @MainActor (RoutingRuleFormDraft) async -> Bool
    ) {
        self.context = context
        self.notes = notes
        self.spaces = spaces
        self.onSave = onSave

        var initialDraft = context.rule.map(RoutingRuleFormDraft.init(rule:))
            ?? RoutingRuleFormDraft()
        let initialKind: RoutingRuleDestinationKind
        let candidateID: String?
        switch context.rule?.destination {
        case let .note(noteID):
            initialKind = .note
            candidateID = noteID.rawValue
        case let .space(spaceID):
            initialKind = .space
            candidateID = spaceID.rawValue
        case nil:
            initialKind = .note
            candidateID = nil
        }
        let isCandidateAvailable = switch initialKind {
        case .note: notes.contains { $0.id == candidateID }
        case .space: spaces.contains { $0.id == candidateID }
        }
        let initialID = isCandidateAvailable ? candidateID : nil
        if initialID == nil { initialDraft.destination = nil }

        _draft = State(initialValue: initialDraft)
        _destinationKind = State(initialValue: initialKind)
        _selectedDestinationID = State(initialValue: initialID)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    EditorialEyebrow(text: context.rule == nil ? "New instruction" : "Edit instruction")
                    Text(context.rule == nil ? "Create a routing rule" : "Update this routing rule")
                        .font(UnfiledType.display)
                        .tracking(-1.1)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, UnfiledTheme.eyebrowToTitle)

                    form
                        .padding(.top, UnfiledTheme.sectionTop)

                    if let errorMessage {
                        GlyphLabel(errorMessage, glyph: .warning)
                            .font(UnfiledType.secondary)
                            .foregroundStyle(UnfiledTheme.paper)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.top, 22)
                    }
                }
                .padding(.horizontal, UnfiledTheme.screenPadding)
                .padding(.top, UnfiledTheme.pushedHeaderTop)
                .padding(.bottom, UnfiledTheme.screenBottom)
            }
            .scrollDismissesKeyboard(.interactively)
            .safeAreaInset(edge: .bottom, spacing: 0) { saveBar }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(isSaving)
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .unfiledScreen()
        }
        .interactiveDismissDisabled(isSaving)
        .onChange(of: destinationKind) { _, _ in
            selectedDestinationID = nil
            draft.destination = nil
        }
        .onChange(of: selectedDestinationID) { _, newValue in
            updateDestination(newValue)
        }
    }

    private var form: some View {
        VStack(alignment: .leading, spacing: 26) {
            fieldGroup("When a jot matches") {
                TextField("For example: gym:", text: $draft.condition, axis: .vertical)
                    .lineLimit(1 ... 4)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .focused($conditionFocused)
                    .padding(.horizontal, UnfiledTheme.fieldPadding)
                    .frame(minHeight: UnfiledTheme.controlHeight)
                    .background(UnfiledTheme.graphite)
                    .overlay {
                        RoundedRectangle(cornerRadius: UnfiledTheme.controlRadius)
                            .stroke(
                                conditionFocused ? UnfiledTheme.persimmon : UnfiledTheme.border,
                                lineWidth: conditionFocused ? 2 : 1
                            )
                    }
                    .clipShape(RoundedRectangle(cornerRadius: UnfiledTheme.controlRadius))
                    .accessibilityIdentifier(RoutingRuleAccessibilityIdentifier.editorCondition)
                Text("Matching is case-insensitive and ignores trailing punctuation.")
                    .font(UnfiledType.caption)
                    .foregroundStyle(UnfiledTheme.fog)
            }

            fieldGroup("Match style") {
                Picker("Match style", selection: $draft.ruleType) {
                    ForEach(RoutingRuleType.allCases, id: \.rawValue) { type in
                        Text(ruleTypeTitle(type)).tag(type)
                    }
                }
                .pickerStyle(.menu)
                .frame(maxWidth: .infinity, minHeight: UnfiledTheme.controlHeight, alignment: .leading)
                .padding(.horizontal, UnfiledTheme.fieldPadding)
                .background(UnfiledTheme.graphite)
                .clipShape(RoundedRectangle(cornerRadius: UnfiledTheme.controlRadius))
                .accessibilityIdentifier(RoutingRuleAccessibilityIdentifier.editorType)
                Text(ruleTypeExplanation(draft.ruleType))
                    .font(UnfiledType.caption)
                    .foregroundStyle(UnfiledTheme.fog)
                    .fixedSize(horizontal: false, vertical: true)
            }

            fieldGroup("Send it to") {
                Picker("Destination kind", selection: $destinationKind) {
                    ForEach(RoutingRuleDestinationKind.allCases) { kind in
                        Text(kind.rawValue).tag(kind)
                    }
                }
                .pickerStyle(.segmented)
                .frame(minHeight: UnfiledTheme.minimumTouchTarget)
                .accessibilityIdentifier(RoutingRuleAccessibilityIdentifier.editorDestinationKind)

                Picker("Destination", selection: $selectedDestinationID) {
                    Text("Choose a \(destinationKind.rawValue.lowercased())")
                        .tag(String?.none)
                    if destinationKind == .note {
                        ForEach(notes) { note in
                            Text(note.title).tag(String?.some(note.id))
                        }
                    } else {
                        ForEach(spaces) { space in
                            Text(space.name).tag(String?.some(space.id))
                        }
                    }
                }
                .pickerStyle(.menu)
                .frame(maxWidth: .infinity, minHeight: UnfiledTheme.controlHeight, alignment: .leading)
                .padding(.horizontal, UnfiledTheme.fieldPadding)
                .background(UnfiledTheme.graphite)
                .clipShape(RoundedRectangle(cornerRadius: UnfiledTheme.controlRadius))
                .accessibilityIdentifier(RoutingRuleAccessibilityIdentifier.editorDestination)

                if let status = draft.unavailableDestinationStatus,
                   selectedDestinationID == nil {
                    Text("The previous destination is \(statusLabel(status)). Choose an active destination to save.")
                        .font(UnfiledType.caption)
                        .foregroundStyle(UnfiledTheme.persimmon)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            fieldGroup("Priority") {
                Stepper(value: $draft.priority, in: 0 ... 10_000) {
                    HStack {
                        Text("Higher rules run first")
                        Spacer()
                        Text("\(draft.priority)")
                            .font(UnfiledType.caption.monospacedDigit())
                            .foregroundStyle(UnfiledTheme.persimmon)
                    }
                    .frame(minHeight: 48)
                }
                .padding(.horizontal, UnfiledTheme.fieldPadding)
                .background(UnfiledTheme.graphite)
                .clipShape(RoundedRectangle(cornerRadius: UnfiledTheme.controlRadius))
                .accessibilityIdentifier(RoutingRuleAccessibilityIdentifier.editorPriority)
            }

            fieldGroup("Status") {
                Toggle("Use this rule", isOn: $draft.enabled)
                    .font(UnfiledType.secondaryStrong)
                    .frame(minHeight: UnfiledTheme.controlHeight)
                    .padding(.horizontal, UnfiledTheme.fieldPadding)
                    .background(UnfiledTheme.graphite)
                    .clipShape(RoundedRectangle(cornerRadius: UnfiledTheme.controlRadius))
                    .accessibilityIdentifier(RoutingRuleAccessibilityIdentifier.editorEnabled)
                Text(draft.enabled ? "It will be active after saving." : "It will stay saved but paused.")
                    .font(UnfiledType.caption)
                    .foregroundStyle(UnfiledTheme.fog)
            }
        }
    }

    private func fieldGroup<Content: View>(
        _ title: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            EditorialEyebrow(text: title)
            content()
        }
    }

    private var saveBar: some View {
        VStack(spacing: 0) {
            SectionRule()
            Button {
                save()
            } label: {
                HStack(spacing: 9) {
                    if isSaving {
                        ProgressView()
                            .controlSize(.small)
                            .tint(UnfiledTheme.ink)
                            .accessibilityHidden(true)
                    }
                    Text(isSaving ? "Saving…" : saveTitle)
                        .font(UnfiledType.heading)
                }
                .frame(maxWidth: .infinity, minHeight: UnfiledTheme.controlHeight)
                .foregroundStyle(UnfiledTheme.ink)
                .background(draft.canSave && !isSaving ? UnfiledTheme.persimmon : UnfiledTheme.fog)
                .clipShape(RoundedRectangle(cornerRadius: UnfiledTheme.controlRadius))
            }
            .buttonStyle(.plain)
            .disabled(!draft.canSave || isSaving)
            .accessibilityIdentifier(RoutingRuleAccessibilityIdentifier.editorSave)
            .padding(.horizontal, UnfiledTheme.screenPadding)
            .padding(.top, 14)
            .padding(.bottom, 10)
        }
        .background(UnfiledTheme.ink)
    }

    private var saveTitle: String {
        context.rule == nil ? "Create rule" : "Save changes"
    }

    private func updateDestination(_ rawID: String?) {
        guard let rawID else {
            draft.destination = nil
            return
        }
        switch destinationKind {
        case .note:
            draft.destination = NoteID(rawValue: rawID).map(RoutingRuleDestination.note)
        case .space:
            draft.destination = SpaceID(rawValue: rawID).map(RoutingRuleDestination.space)
        }
    }

    private func save() {
        guard draft.canSave, !isSaving else { return }
        isSaving = true
        errorMessage = nil
        Task { @MainActor in
            let saved = await onSave(draft)
            isSaving = false
            if saved {
                dismiss()
            } else {
                errorMessage = "The rule was not saved. Check your connection, refresh, and try again."
            }
        }
    }

    private func ruleTypeTitle(_ type: RoutingRuleType) -> String {
        switch type {
        case .prefix: "Starts with"
        case .phrase: "Contains phrase"
        case .alias: "Alias or whole word"
        case .destinationMention: "“to” or “in” mention"
        }
    }

    private func ruleTypeExplanation(_ type: RoutingRuleType) -> String {
        switch type {
        case .prefix: "Matches at the beginning, followed by a space or colon."
        case .phrase: "Matches the phrase within the first 80 characters."
        case .alias: "Matches the complete phrase or whole words, never partial words."
        case .destinationMention: "Matches the exact phrase after “to” or “in” at the end."
        }
    }

    private func statusLabel(_ status: RoutingRuleDestinationStatus) -> String {
        switch status {
        case .active: "active"
        case .archived: "archived"
        case .deleted: "deleted"
        case .missing: "no longer available"
        }
    }
}
