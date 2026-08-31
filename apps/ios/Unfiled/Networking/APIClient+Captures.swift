import Foundation

extension APIClient {
    public func createCapture(_ request: CaptureCreateRequest, idempotencyKey: String) async throws -> CaptureCreateResponse {
        guard (1 ... 10_000).contains(request.rawContent.utf16.count),
              !request.rawContent.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              (1 ... 100).contains(request.clientTimezone.utf16.count),
              request.deviceId.map({ $0.utf16.count <= 120 }) ?? true else { throw APIClientError.invalidRequest }
        return try await post("/captures", body: request, idempotencyKey: idempotencyKey)
    }

    func createCapture(
        _ request: CaptureCreateRequest,
        idempotencyKey: String,
        accessToken: String
    ) async throws -> CaptureCreateResponse {
        guard (1 ... 10_000).contains(request.rawContent.utf16.count),
              !request.rawContent.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              (1 ... 100).contains(request.clientTimezone.utf16.count),
              request.deviceId.map({ $0.utf16.count <= 120 }) ?? true,
              !accessToken.isEmpty else { throw APIClientError.invalidRequest }
        return try await post(
            "/captures",
            body: request,
            idempotencyKey: idempotencyKey,
            explicitToken: accessToken
        )
    }

    public func listCaptures(_ query: CaptureListQuery = .init()) async throws -> CaptureListResponse {
        if let from = query.from, let to = query.to, from >= to { throw APIClientError.invalidRequest }
        var items = try pageItems(cursor: query.cursor, limit: query.limit)
        if let status = query.status { items.append(.init(name: "status", value: status.rawValue)) }
        if let from = query.from { items.append(.init(name: "from", value: APIJSON.dateString(from))) }
        if let to = query.to { items.append(.init(name: "to", value: APIJSON.dateString(to))) }
        return try await get("/captures", query: items)
    }

    public func getCapture(_ id: CaptureID) async throws -> CaptureDetailResponse {
        try await get("/captures/\(id.rawValue)")
    }

    public func getCaptureReceipt(_ id: CaptureID) async throws -> CaptureReceiptResponse {
        try await get("/captures/\(id.rawValue)/receipt")
    }

    public func retryCapture(_ id: CaptureID, request: CaptureRetryRequest) async throws -> CaptureRetryResponse {
        try await post("/captures/\(id.rawValue)/retry", body: request, idempotencyKey: request.idempotencyKey)
    }

    public func deleteCapture(_ id: CaptureID, request: CaptureDeleteRequest) async throws -> CaptureDeleteResponse {
        try await delete("/captures/\(id.rawValue)", body: request, idempotencyKey: request.idempotencyKey)
    }
}

extension APIClient {
    func pageItems(cursor: String?, limit: Int) throws -> [URLQueryItem] {
        guard (1 ... 100).contains(limit), cursor.map({ (1 ... 512).contains($0.utf16.count) }) ?? true else {
            throw APIClientError.invalidRequest
        }
        var result = [URLQueryItem(name: "limit", value: String(limit))]
        if let cursor { result.append(.init(name: "cursor", value: cursor)) }
        return result
    }
}
