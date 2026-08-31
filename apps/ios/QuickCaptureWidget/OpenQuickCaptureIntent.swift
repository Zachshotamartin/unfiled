import AppIntents

struct OpenQuickCaptureIntent: AppIntent {
    static let title: LocalizedStringResource = "Write in Unfiled"
    static let description = IntentDescription(
        "Opens a blank Unfiled capture with the keyboard ready."
    )
    static let openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult {
        AppGroupConfiguration.signalQuickCapture()
        return .result()
    }
}
