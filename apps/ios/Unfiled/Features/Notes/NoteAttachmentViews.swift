import SwiftUI

/// A photo the organizer placed in a note, shown where it sits in the body. Tapping opens it
/// full screen.
struct NoteAttachmentImage: View {
    let attachmentID: String
    let load: @MainActor (String) async -> Data?

    @State private var image: UIImage?
    @State private var failed = false
    @State private var showsFullScreen = false

    var body: some View {
        Group {
            if let image {
                Button {
                    showsFullScreen = true
                } label: {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFit()
                        .frame(maxWidth: .infinity, maxHeight: 360, alignment: .leading)
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Photo")
                .accessibilityHint("Opens the photo full screen")
                .fullScreenCover(isPresented: $showsFullScreen) {
                    NoteAttachmentFullScreen(image: image)
                }
            } else if failed {
                Text("This photo could not be loaded.")
                    .font(UnfiledType.caption)
                    .foregroundStyle(UnfiledTheme.fog)
            } else {
                UnfiledLoadingView(size: 18, label: "Loading photo")
                    .frame(height: 120)
            }
        }
        .accessibilityIdentifier("noteDetail.attachment.\(attachmentID)")
        .task(id: attachmentID) {
            guard image == nil else { return }
            if let data = await load(attachmentID), let loaded = UIImage(data: data) {
                image = loaded
            } else {
                failed = true
            }
        }
    }
}

struct NoteAttachmentFullScreen: View {
    @Environment(\.dismiss) private var dismiss
    let image: UIImage

    var body: some View {
        ZStack(alignment: .topTrailing) {
            UnfiledTheme.ink.ignoresSafeArea()
            Image(uiImage: image)
                .resizable()
                .scaledToFit()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .padding(UnfiledTheme.screenPadding)
            IconButton(glyph: .close, label: "Close photo") { dismiss() }
                .padding(UnfiledTheme.screenPadding)
        }
    }
}

/// A recording the organizer placed in a note. Playback arrives with voice notes; until then the
/// row names what is there.
struct NoteAttachmentRecordingRow: View {
    let attachmentID: String

    var body: some View {
        HStack(spacing: 10) {
            GlyphView(glyph: .microphone, size: 18, weight: 1.9)
            Text("Recording")
                .font(UnfiledType.secondary)
        }
        .foregroundStyle(UnfiledTheme.paper)
        .padding(.horizontal, 14)
        .frame(minHeight: 44)
        .background(UnfiledTheme.raised)
        .clipShape(Capsule())
        .accessibilityIdentifier("noteDetail.attachment.\(attachmentID)")
    }
}
