import Foundation
import SwiftUI

enum LogFieldUpdateFailure: Error, Equatable, Sendable {
    case ambiguous
    case staleRevision
    case deleted
    case unavailable

    var message: String {
        switch self {
        case .ambiguous:
            "Unfiled could not confirm the update. Retry this unchanged value to safely check it."
        case .staleRevision:
            "This note changed on another device. The latest values are shown; enter the update again."
        case .deleted:
            "This note was deleted before the value could be updated."
        case .unavailable:
            "The value was not updated. Check your connection and try again."
        }
    }
}

struct LogFieldEditDraft: Equatable, Sendable {
    static let maximumNumericInputUTF16Units = 64
    static let maximumTextInputUTF16Units = 500

    let priorValue: LogFieldValue
    var input = ""

    var isNumeric: Bool {
        switch priorValue {
        case .number, .null: true
        case .string: false
        }
    }

    var priorLabel: String {
        LogFieldValuePresentation.label(priorValue)
    }

    var placeholder: String {
        switch priorValue {
        case .null: "No prior value"
        default: "Previous: \(priorLabel)"
        }
    }

    var proposedValue: LogFieldValue? {
        if isNumeric {
            let normalized = input.trimmingCharacters(in: .whitespacesAndNewlines)
                .replacingOccurrences(
                    of: Locale.current.decimalSeparator ?? ".",
                    with: "."
                )
            guard !normalized.isEmpty,
                  let value = Double(normalized),
                  value.isFinite else { return nil }
            return .number(value)
        }
        guard input.utf16.count <= 500 else { return nil }
        return .string(input)
    }

    mutating func updateInput(_ value: String) {
        input = Self.bounded(
            value,
            maximumUTF16Units: isNumeric
                ? Self.maximumNumericInputUTF16Units
                : Self.maximumTextInputUTF16Units
        )
    }

    mutating func step(by delta: Double) {
        guard delta.isFinite else { return }
        let starting: Double
        if case let .number(value)? = proposedValue {
            starting = value
        } else if case let .number(value) = priorValue {
            starting = value
        } else {
            starting = 0
        }
        let updated = starting + delta
        guard updated.isFinite else { return }
        input = LogFieldValuePresentation.number(updated)
    }

    private static func bounded(_ value: String, maximumUTF16Units: Int) -> String {
        guard value.utf16.count > maximumUTF16Units else { return value }
        var result = ""
        var units = 0
        for character in value {
            let width = String(character).utf16.count
            guard units <= maximumUTF16Units - width else { break }
            result.append(character)
            units += width
        }
        return result
    }
}

enum LogFieldValuePresentation {
    static func label(_ value: LogFieldValue) -> String {
        switch value {
        case let .string(value): value.isEmpty ? "Empty text" : value
        case let .number(value): number(value)
        case .null: "No value"
        }
    }

    static func number(_ value: Double) -> String {
        guard value.isFinite else { return "" }
        if value.rounded() == value, abs(value) <= Double(Int64.max) {
            return String(Int64(value))
        }
        return String(format: "%.8g", locale: Locale(identifier: "en_US_POSIX"), value)
    }
}

enum LogFieldAccessibilityIdentifier {
    static let section = "noteDetail.log"

    static func field(entryID: String, fieldID: String) -> String {
        "noteDetail.log.\(entryID).\(fieldID)"
    }

    static func input(entryID: String, fieldID: String) -> String {
        "\(field(entryID: entryID, fieldID: fieldID)).input"
    }

    static func decrement(entryID: String, fieldID: String) -> String {
        "\(field(entryID: entryID, fieldID: fieldID)).decrement"
    }

    static func increment(entryID: String, fieldID: String) -> String {
        "\(field(entryID: entryID, fieldID: fieldID)).increment"
    }
}

struct LogFieldsSection: View {
    let entries: [LogEntryPresentation]
    let onUpdate: @MainActor (String, [String], LogFieldValue) async throws -> Void

    @State private var editingID: String?
    @State private var draft: LogFieldEditDraft?
    @State private var updatingIDs = Set<String>()
    @State private var errors: [String: String] = [:]
    @FocusState private var focusedID: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Text("Log")
                    .font(UnfiledType.title)
                    .accessibilityAddTraits(.isHeader)
                Spacer(minLength: 12)
                Text("\(entries.count) \(entries.count == 1 ? "entry" : "entries")")
                    .font(UnfiledType.label)
                    .foregroundStyle(UnfiledTheme.fog)
            }
            .padding(.top, UnfiledTheme.rowVertical)
            .padding(.bottom, UnfiledTheme.labelToRule)

            ForEach(entries) { entry in
                VStack(alignment: .leading, spacing: 0) {
                    Text(entry.occurredAt, format: .dateTime.month(.abbreviated).day().year()
                        .hour().minute())
                        .font(UnfiledType.label)
                        .foregroundStyle(UnfiledTheme.fog)
                        .padding(.top, 18)
                        .padding(.bottom, 8)

                    ForEach(entry.fields) { field in
                        fieldRow(entry: entry, field: field)
                    }
                }
            }
        }
        .padding(.bottom, 18)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(LogFieldAccessibilityIdentifier.section)
    }

    private func fieldRow(
        entry: LogEntryPresentation,
        field: LogFieldPresentation
    ) -> some View {
        let identity = fieldIdentity(entry: entry, field: field)
        let isEditing = editingID == identity
        let isUpdating = updatingIDs.contains(identity)
        return VStack(alignment: .leading, spacing: 0) {
            Button {
                if isEditing {
                    closeEditor()
                } else {
                    editingID = identity
                    draft = LogFieldEditDraft(priorValue: field.value)
                    errors.removeValue(forKey: identity)
                    focusedID = identity
                }
            } label: {
                HStack(alignment: .center, spacing: 14) {
                    VStack(alignment: .leading, spacing: 5) {
                        Text(field.label)
                            .font(UnfiledType.heading)
                            .foregroundStyle(UnfiledTheme.paper)
                        Text(LogFieldValuePresentation.label(field.value))
                            .font(UnfiledType.body.monospacedDigit())
                            .foregroundStyle(UnfiledTheme.fog)
                            .lineLimit(2)
                    }
                    Spacer(minLength: 10)
                    if isUpdating {
                        ProgressView().controlSize(.small).tint(UnfiledTheme.persimmon)
                    } else {
                        Image(systemName: isEditing ? "chevron.up" : "square.and.pencil")
                            .font(UnfiledType.heading)
                            .foregroundStyle(UnfiledTheme.persimmon)
                    }
                }
                .frame(maxWidth: .infinity, minHeight: 62, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(isUpdating)
            .accessibilityLabel("\(field.label), \(LogFieldValuePresentation.label(field.value))")
            .accessibilityValue(isEditing ? "Editing" : "Not editing")
            .accessibilityHint("Double tap to edit this log value")
            .accessibilityIdentifier(
                LogFieldAccessibilityIdentifier.field(entryID: entry.id, fieldID: field.id)
            )

            if isEditing, let draft {
                editor(entry: entry, field: field, identity: identity, draft: draft)
            }

            if let error = errors[identity] {
                Label(error, systemImage: "exclamationmark.circle")
                    .font(UnfiledType.secondary)
                    .foregroundStyle(UnfiledTheme.persimmon)
                    .padding(.bottom, 12)
                    .accessibilityIdentifier("\(identity).error")
            }

            SectionRule()
        }
    }

    private func editor(
        entry: LogEntryPresentation,
        field: LogFieldPresentation,
        identity: String,
        draft currentDraft: LogFieldEditDraft
    ) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Prior value: \(currentDraft.priorLabel)")
                .font(UnfiledType.caption)
                .foregroundStyle(UnfiledTheme.fog)

            TextField(
                currentDraft.placeholder,
                text: Binding(
                    get: { draft?.input ?? "" },
                    set: { draft?.updateInput($0) }
                )
            )
            .keyboardType(currentDraft.isNumeric ? .decimalPad : .default)
            .textInputAutocapitalization(currentDraft.isNumeric ? .never : .sentences)
            .autocorrectionDisabled(currentDraft.isNumeric)
            .font(UnfiledType.body.monospacedDigit())
            .padding(.horizontal, UnfiledTheme.fieldPadding)
            .frame(maxWidth: .infinity, minHeight: UnfiledTheme.controlHeight)
            .background(UnfiledTheme.raised)
            .overlay {
                RoundedRectangle(cornerRadius: UnfiledTheme.controlRadius)
                    .stroke(UnfiledTheme.persimmon.opacity(0.7), lineWidth: 1)
            }
            .clipShape(RoundedRectangle(cornerRadius: UnfiledTheme.controlRadius))
            .focused($focusedID, equals: identity)
            .accessibilityLabel("New \(field.label) value")
            .accessibilityHint(currentDraft.placeholder)
            .accessibilityIdentifier(
                LogFieldAccessibilityIdentifier.input(entryID: entry.id, fieldID: field.id)
            )

            if currentDraft.isNumeric {
                HStack(spacing: UnfiledTheme.controlGap) {
                    stepButton(
                        title: "Decrease \(field.label)",
                        systemImage: "minus",
                        identifier: LogFieldAccessibilityIdentifier.decrement(
                            entryID: entry.id,
                            fieldID: field.id
                        ),
                        delta: -1
                    )
                    stepButton(
                        title: "Increase \(field.label)",
                        systemImage: "plus",
                        identifier: LogFieldAccessibilityIdentifier.increment(
                            entryID: entry.id,
                            fieldID: field.id
                        ),
                        delta: 1
                    )
                }
                .accessibilityElement(children: .contain)
            }

            ViewThatFits(in: .horizontal) {
                HStack(spacing: UnfiledTheme.controlGap) {
                    cancelButton
                    saveButton(entry: entry, field: field, identity: identity, draft: currentDraft)
                }
                VStack(spacing: UnfiledTheme.controlGap) {
                    saveButton(entry: entry, field: field, identity: identity, draft: currentDraft)
                    cancelButton
                }
            }
        }
        .padding(.bottom, 18)
    }

    private func stepButton(
        title: String,
        systemImage: String,
        identifier: String,
        delta: Double
    ) -> some View {
        Button {
            draft?.step(by: delta)
        } label: {
            Label(title, systemImage: systemImage)
                .labelStyle(.iconOnly)
                .font(UnfiledType.title)
                .frame(maxWidth: .infinity, minHeight: UnfiledTheme.controlHeight)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background(UnfiledTheme.raised)
        .overlay {
            RoundedRectangle(cornerRadius: UnfiledTheme.controlRadius)
                .stroke(UnfiledTheme.border, lineWidth: 1)
        }
        .clipShape(RoundedRectangle(cornerRadius: UnfiledTheme.controlRadius))
        .accessibilityLabel(title)
        .accessibilityIdentifier(identifier)
    }

    private var cancelButton: some View {
        Button("Cancel") { closeEditor() }
            .buttonStyle(.bordered)
            .tint(UnfiledTheme.fog)
            .frame(maxWidth: .infinity, minHeight: UnfiledTheme.minimumTouchTarget)
    }

    private func saveButton(
        entry: LogEntryPresentation,
        field: LogFieldPresentation,
        identity: String,
        draft currentDraft: LogFieldEditDraft
    ) -> some View {
        Button("Save value") {
            save(entry: entry, field: field, identity: identity)
        }
        .buttonStyle(.borderedProminent)
        .tint(UnfiledTheme.persimmon)
        .foregroundStyle(UnfiledTheme.ink)
        .frame(maxWidth: .infinity, minHeight: UnfiledTheme.minimumTouchTarget)
        .disabled(currentDraft.proposedValue == nil)
        .accessibilityIdentifier("\(identity).save")
    }

    private func fieldIdentity(entry: LogEntryPresentation, field: LogFieldPresentation) -> String {
        "log.\(entry.id).\(field.id)"
    }

    private func closeEditor() {
        focusedID = nil
        editingID = nil
        draft = nil
    }

    private func save(
        entry: LogEntryPresentation,
        field: LogFieldPresentation,
        identity: String
    ) {
        guard let value = draft?.proposedValue, !updatingIDs.contains(identity) else { return }
        focusedID = nil
        updatingIDs.insert(identity)
        errors.removeValue(forKey: identity)
        Task { @MainActor in
            do {
                try await onUpdate(entry.id, field.path, value)
                editingID = nil
                draft = nil
                UIAccessibility.post(
                    notification: .announcement,
                    argument: "\(field.label) updated"
                )
            } catch let failure as LogFieldUpdateFailure {
                errors[identity] = failure.message
                UIAccessibility.post(notification: .announcement, argument: failure.message)
            } catch {
                errors[identity] = LogFieldUpdateFailure.unavailable.message
                UIAccessibility.post(
                    notification: .announcement,
                    argument: LogFieldUpdateFailure.unavailable.message
                )
            }
            updatingIDs.remove(identity)
        }
    }
}
