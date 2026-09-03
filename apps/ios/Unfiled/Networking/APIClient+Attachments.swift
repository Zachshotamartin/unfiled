import Foundation

extension APIClient {
    private static let attachmentIDPattern = #"^att_[0-9A-HJKMNP-TV-Z]{26}$"#
    private static let captureIDPattern = #"^cap_[0-9A-HJKMNP-TV-Z]{26}$"#
    private static let attachmentResponseBytes = 16_384

    /// Uploads one photo or recording as raw bytes, described in headers, using the token the
    /// outbox already holds for its profile.
    func uploadCaptureAttachment(
        _ upload: CaptureAttachmentUpload,
        accessToken: String
    ) async throws -> CaptureAttachment {
        try Self.validate(upload)
        guard !accessToken.isEmpty else { throw APIClientError.invalidRequest }
        let (data, http) = try await rawRequest(
            "POST",
            path: "/captures/attachments",
            body: upload.bytes,
            contentType: upload.mediaType,
            headers: Self.uploadHeaders(upload),
            idempotencyKey: upload.attachmentId,
            explicitToken: accessToken,
            maximumResponseBytes: Self.attachmentResponseBytes
        )
        let stored = try decodeJSON(data, response: http, as: CaptureAttachment.self)
        guard stored.id == upload.attachmentId, stored.kind == upload.kind,
              stored.byteLength == upload.bytes.count else {
            throw APIClientError.malformedResponse(status: http.statusCode)
        }
        return stored
    }

    /// Reads the owner's attachment back as bytes. The answer must forbid caching, carry one of the
    /// two media types, and stay under the attachment cap.
    public func captureAttachment(id: String) async throws -> CaptureAttachmentBytes {
        guard id.range(of: Self.attachmentIDPattern, options: .regularExpression) != nil else {
            throw APIClientError.invalidRequest
        }
        let (data, http) = try await rawRequest(
            "GET",
            path: "/captures/attachments/\(id)",
            body: nil,
            contentType: nil,
            maximumResponseBytes: CaptureAttachmentUpload.maximumBytes
        )
        guard (200 ... 299).contains(http.statusCode) else {
            let payload = try? APIJSON.makeDecoder().decode(APIErrorPayload.self, from: data)
            throw APIClientError.http(status: http.statusCode, code: payload?.code,
                                      requestId: payload?.requestId,
                                      retryAfterSeconds: payload?.retryAfterSeconds)
        }
        let mediaType = http.value(forHTTPHeaderField: "Content-Type")?
            .lowercased().trimmingCharacters(in: .whitespaces) ?? ""
        guard http.value(forHTTPHeaderField: "Cache-Control") == "private, no-store",
              http.value(forHTTPHeaderField: "Pragma") == "no-cache",
              CaptureAttachmentUpload.mediaTypes.contains(mediaType),
              (1 ... CaptureAttachmentUpload.maximumBytes).contains(data.count) else {
            throw APIClientError.malformedResponse(status: http.statusCode)
        }
        return CaptureAttachmentBytes(bytes: data, mediaType: mediaType)
    }

    private static func validate(_ upload: CaptureAttachmentUpload) throws {
        let image = upload.kind == .image
        guard upload.attachmentId.range(of: attachmentIDPattern, options: .regularExpression) != nil,
              upload.captureId.range(of: captureIDPattern, options: .regularExpression) != nil,
              CaptureAttachmentUpload.mediaTypes.contains(upload.mediaType),
              image == (upload.mediaType == "image/jpeg"),
              (1 ... CaptureAttachmentUpload.maximumBytes).contains(upload.bytes.count),
              image ? (upload.width != nil && upload.height != nil && upload.durationMs == nil)
                    : (upload.durationMs != nil && upload.width == nil && upload.height == nil)
        else { throw APIClientError.invalidRequest }
    }

    private static func uploadHeaders(_ upload: CaptureAttachmentUpload) -> [String: String] {
        var headers = [
            "X-Unfiled-Capture-Id": upload.captureId,
            "X-Unfiled-Privacy": upload.privacy.rawValue
        ]
        if let width = upload.width { headers["X-Unfiled-Width"] = String(width) }
        if let height = upload.height { headers["X-Unfiled-Height"] = String(height) }
        if let duration = upload.durationMs { headers["X-Unfiled-Duration-Ms"] = String(duration) }
        return headers
    }
}
