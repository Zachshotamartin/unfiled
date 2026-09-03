import Foundation
import OSLog

enum APIEndpointConfiguration {
    static let versionedBasePath = "/api/v1"

    static func normalizedVersionedBaseURL(_ url: URL) -> URL? {
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.user == nil,
              components.password == nil,
              components.query == nil,
              components.fragment == nil,
              components.path == versionedBasePath || components.path == "\(versionedBasePath)/"
        else {
            return nil
        }
        components.path = versionedBasePath
        return components.url
    }
}

public final class APIClient: Sendable {
    public struct Limits: Equatable, Sendable {
        public let requestBodyBytes: Int
        public let responseBodyBytes: Int
        public init(requestBodyBytes: Int = 1_048_576, responseBodyBytes: Int = 8_388_608) {
            self.requestBodyBytes = requestBodyBytes
            self.responseBodyBytes = responseBodyBytes
        }
    }

    private struct NoBody: Encodable {}
    private enum Authentication { case none, required, explicit(String) }

    public let baseURL: URL
    private let transport: any HTTPTransport
    private let tokenProvider: (any AccessTokenProviding)?
    private let limits: Limits

    public init(baseURL: URL, transport: any HTTPTransport = URLSessionTransport(),
                tokenProvider: (any AccessTokenProviding)? = nil, limits: Limits = .init()) throws {
        guard let normalizedBaseURL = APIEndpointConfiguration.normalizedVersionedBaseURL(baseURL),
              let scheme = normalizedBaseURL.scheme?.lowercased(),
              let host = normalizedBaseURL.host?.lowercased(),
              !host.isEmpty,
              scheme == "https" || (scheme == "http" && ["localhost", "127.0.0.1", "::1"].contains(host)),
              limits.requestBodyBytes > 0, limits.responseBodyBytes > 0 else {
            throw APIClientError.invalidConfiguration
        }
        self.baseURL = normalizedBaseURL
        self.transport = transport
        self.tokenProvider = tokenProvider
        self.limits = limits
    }

    func get<Response: Decodable>(_ path: String, query: [URLQueryItem] = [], authenticated: Bool = true,
                                  explicitToken: String? = nil,
                                  maximumResponseBytes: Int? = nil,
                                  requirePrivateNoStore: Bool = false,
                                  as: Response.Type = Response.self) async throws -> Response {
        let auth: Authentication = explicitToken.map(Authentication.explicit) ?? (authenticated ? .required : .none)
        return try await send("GET", path: path, query: query, body: Optional<NoBody>.none,
                              authentication: auth, maximumResponseBytes: maximumResponseBytes,
                              requirePrivateNoStore: requirePrivateNoStore,
                              response: Response.self)
    }

    func authenticatedArchiveStream(_ path: String) async throws -> AsyncThrowingStream<Data, any Error> {
        guard let tokenProvider else { throw APIClientError.authenticationRequired }
        let firstCredential: AccessTokenCredential
        do { firstCredential = try await tokenProvider.accessTokenCredential() }
        catch { throw sanitized(error) }

        let first = try await performArchiveStream(path, token: firstCredential.token)
        if first.http.statusCode == 401 {
            first.cancel()
            let refreshed: AccessTokenCredential
            do {
                refreshed = try await tokenProvider.refreshAfterUnauthorized(
                    rejectedCredential: firstCredential
                )
            } catch { throw sanitized(error) }
            guard refreshed.userID == firstCredential.userID,
                  refreshed.sessionGeneration == firstCredential.sessionGeneration else {
                throw APIClientError.authenticationRequired
            }
            let retry = try await performArchiveStream(path, token: refreshed.token)
            return try await validatedArchiveStream(retry)
        }
        return try await validatedArchiveStream(first)
    }

    func postEmpty<Response: Decodable>(_ path: String, authenticated: Bool = true,
                                         explicitToken: String? = nil,
                                         as: Response.Type = Response.self) async throws -> Response {
        try await post(path, body: Optional<NoBody>.none, authenticated: authenticated,
                       explicitToken: explicitToken, as: Response.self)
    }

    func post<Response: Decodable, Body: Encodable>(_ path: String, body: Body?, idempotencyKey: String? = nil,
                                                     authenticated: Bool = true, explicitToken: String? = nil,
                                                     maximumResponseBytes: Int? = nil,
                                                     requirePrivateNoStore: Bool = false,
                                                     as: Response.Type = Response.self) async throws -> Response {
        let auth: Authentication = explicitToken.map(Authentication.explicit) ?? (authenticated ? .required : .none)
        return try await send("POST", path: path, body: body, idempotencyKey: idempotencyKey,
                              authentication: auth, maximumResponseBytes: maximumResponseBytes,
                              requirePrivateNoStore: requirePrivateNoStore,
                              response: Response.self)
    }

    func put<Response: Decodable, Body: Encodable>(_ path: String, body: Body,
                                                    idempotencyKey: String? = nil,
                                                    authenticated: Bool = false,
                                                    maximumRequestBytes: Int? = nil,
                                                    maximumResponseBytes: Int? = nil,
                                                    requirePrivateNoStore: Bool = false,
                                                    as: Response.Type = Response.self) async throws -> Response {
        try await send("PUT", path: path, body: body, idempotencyKey: idempotencyKey,
                       authentication: authenticated ? .required : .none,
                       maximumRequestBytes: maximumRequestBytes,
                       maximumResponseBytes: maximumResponseBytes,
                       requirePrivateNoStore: requirePrivateNoStore,
                       response: Response.self)
    }

    func patch<Response: Decodable, Body: Encodable>(_ path: String, body: Body, idempotencyKey: String,
                                                      maximumRequestBytes: Int? = nil,
                                                      maximumResponseBytes: Int? = nil,
                                                      requirePrivateNoStore: Bool = false,
                                                      as: Response.Type = Response.self) async throws -> Response {
        try await send("PATCH", path: path, body: body, idempotencyKey: idempotencyKey,
                       authentication: .required,
                       maximumRequestBytes: maximumRequestBytes,
                       maximumResponseBytes: maximumResponseBytes,
                       requirePrivateNoStore: requirePrivateNoStore,
                       response: Response.self)
    }

    func delete<Response: Decodable, Body: Encodable>(_ path: String, body: Body, idempotencyKey: String,
                                                       maximumRequestBytes: Int? = nil,
                                                       maximumResponseBytes: Int? = nil,
                                                       requirePrivateNoStore: Bool = false,
                                                       as: Response.Type = Response.self) async throws -> Response {
        try await send("DELETE", path: path, body: body, idempotencyKey: idempotencyKey,
                       authentication: .required,
                       maximumRequestBytes: maximumRequestBytes,
                       maximumResponseBytes: maximumResponseBytes,
                       requirePrivateNoStore: requirePrivateNoStore,
                       response: Response.self)
    }

    /// Account-deletion capabilities stay in the encrypted HTTP body. Unlike
    /// ordinary mutation IDs, they must never be copied into an edge-loggable
    /// custom header.
    func deleteBodyOnly<Response: Decodable, Body: Encodable>(
        _ path: String,
        body: Body,
        requirePrivateNoStore: Bool = false,
        as: Response.Type = Response.self
    ) async throws -> Response {
        try await send(
            "DELETE",
            path: path,
            body: body,
            authentication: .required,
            requirePrivateNoStore: requirePrivateNoStore,
            response: Response.self
        )
    }

    private func send<Response: Decodable, Body: Encodable>(
        _ method: String, path: String, query: [URLQueryItem] = [], body: Body?,
        idempotencyKey: String? = nil, authentication: Authentication,
        maximumRequestBytes: Int? = nil,
        maximumResponseBytes: Int? = nil,
        requirePrivateNoStore: Bool = false,
        response: Response.Type
    ) async throws -> Response {
        let firstCredential: AccessTokenCredential?
        let firstToken: String?
        switch authentication {
        case .none:
            firstCredential = nil
            firstToken = nil
        case let .explicit(token):
            firstCredential = nil
            firstToken = token
        case .required:
            guard let tokenProvider else { throw APIClientError.authenticationRequired }
            do {
                let credential = try await tokenProvider.accessTokenCredential()
                firstCredential = credential
                firstToken = credential.token
            }
            catch { throw sanitized(error) }
        }

        let first = try await perform(method, path: path, query: query, body: body,
                                      idempotencyKey: idempotencyKey, token: firstToken,
                                      maximumRequestBytes: maximumRequestBytes,
                                      maximumResponseBytes: maximumResponseBytes)
        if first.http.statusCode == 401, case .required = authentication, let tokenProvider,
           let rejectedCredential = firstCredential {
            let refreshed: AccessTokenCredential
            do {
                refreshed = try await tokenProvider.refreshAfterUnauthorized(
                    rejectedCredential: rejectedCredential
                )
            }
            catch { throw sanitized(error) }
            guard refreshed.userID == rejectedCredential.userID,
                  refreshed.sessionGeneration == rejectedCredential.sessionGeneration else {
                throw APIClientError.authenticationRequired
            }
            let retry = try await perform(method, path: path, query: query, body: body,
                                          idempotencyKey: idempotencyKey, token: refreshed.token,
                                          maximumRequestBytes: maximumRequestBytes,
                                          maximumResponseBytes: maximumResponseBytes)
            return try decode(
                retry.data,
                response: retry.http,
                requirePrivateNoStore: requirePrivateNoStore,
                as: Response.self
            )
        }
        return try decode(
            first.data,
            response: first.http,
            requirePrivateNoStore: requirePrivateNoStore,
            as: Response.self
        )
    }

    /// A request whose body is raw bytes rather than JSON, answered with raw bytes. Used for
    /// photos and recordings; every other request stays JSON.
    func rawRequest(
        _ method: String,
        path: String,
        body: Data?,
        contentType: String?,
        headers: [String: String] = [:],
        idempotencyKey: String? = nil,
        explicitToken: String? = nil,
        maximumResponseBytes: Int
    ) async throws -> (data: Data, http: HTTPURLResponse) {
        let authentication: Authentication = explicitToken.map(Authentication.explicit) ?? .required
        let firstCredential: AccessTokenCredential?
        let firstToken: String
        switch authentication {
        case .none:
            throw APIClientError.authenticationRequired
        case let .explicit(token):
            firstCredential = nil
            firstToken = token
        case .required:
            guard let tokenProvider else { throw APIClientError.authenticationRequired }
            do {
                let credential = try await tokenProvider.accessTokenCredential()
                firstCredential = credential
                firstToken = credential.token
            }
            catch { throw sanitized(error) }
        }
        let first = try await performRaw(method, path: path, body: body, contentType: contentType,
                                         headers: headers, idempotencyKey: idempotencyKey,
                                         token: firstToken, maximumResponseBytes: maximumResponseBytes)
        if first.http.statusCode == 401, case .required = authentication, let tokenProvider,
           let rejectedCredential = firstCredential {
            let refreshed: AccessTokenCredential
            do {
                refreshed = try await tokenProvider.refreshAfterUnauthorized(
                    rejectedCredential: rejectedCredential
                )
            }
            catch { throw sanitized(error) }
            guard refreshed.userID == rejectedCredential.userID,
                  refreshed.sessionGeneration == rejectedCredential.sessionGeneration else {
                throw APIClientError.authenticationRequired
            }
            return try await performRaw(method, path: path, body: body, contentType: contentType,
                                        headers: headers, idempotencyKey: idempotencyKey,
                                        token: refreshed.token, maximumResponseBytes: maximumResponseBytes)
        }
        return first
    }

    func decodeJSON<Response: Decodable>(
        _ data: Data,
        response: HTTPURLResponse,
        as: Response.Type
    ) throws -> Response {
        try decode(data, response: response, requirePrivateNoStore: false, as: Response.self)
    }

    private func performRaw(_ method: String, path: String, body: Data?, contentType: String?,
                            headers: [String: String], idempotencyKey: String?, token: String,
                            maximumResponseBytes: Int) async throws -> (data: Data, http: HTTPURLResponse) {
        guard !path.contains(".."), var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            throw APIClientError.invalidRequest
        }
        let root = components.path.hasSuffix("/") ? String(components.path.dropLast()) : components.path
        components.path = root + (path.hasPrefix("/") ? path : "/\(path)")
        components.queryItems = nil
        guard let url = components.url else { throw APIClientError.invalidRequest }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 60)
        request.httpMethod = method
        request.setValue("*/*", forHTTPHeaderField: "Accept")
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        request.setValue("no-cache", forHTTPHeaderField: "Pragma")
        guard !token.isEmpty, !token.contains(where: { $0.isNewline }) else { throw APIClientError.authenticationRequired }
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let idempotencyKey {
            guard Self.isValidIdempotencyKey(idempotencyKey) else { throw APIClientError.invalidRequest }
            request.setValue(idempotencyKey, forHTTPHeaderField: "Idempotency-Key")
        }
        for (name, value) in headers {
            guard !value.contains(where: { $0.isNewline }) else { throw APIClientError.invalidRequest }
            request.setValue(value, forHTTPHeaderField: name)
        }
        if let body {
            guard let contentType, !body.isEmpty else { throw APIClientError.invalidRequest }
            request.httpBody = body
            request.setValue(contentType, forHTTPHeaderField: "Content-Type")
        }
        let responseLimit = min(maximumResponseBytes, max(limits.responseBodyBytes, maximumResponseBytes))
        guard responseLimit > 0 else { throw APIClientError.invalidRequest }
        do { return try await transport.data(for: request, maxResponseBytes: responseLimit) }
        catch let error as APIClientError { throw error }
        catch { throw APIClient.failure(from: error) }
    }

    private func perform<Body: Encodable>(_ method: String, path: String, query: [URLQueryItem],
                                           body: Body?, idempotencyKey: String?, token: String?,
                                           maximumRequestBytes: Int?,
                                           maximumResponseBytes: Int?) async throws
        -> (data: Data, http: HTTPURLResponse) {
        guard !path.contains(".."), var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            throw APIClientError.invalidRequest
        }
        let root = components.path.hasSuffix("/") ? String(components.path.dropLast()) : components.path
        components.path = root + (path.hasPrefix("/") ? path : "/\(path)")
        components.queryItems = query.isEmpty ? nil : query
        guard let url = components.url else { throw APIClientError.invalidRequest }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 30)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        request.setValue("no-cache", forHTTPHeaderField: "Pragma")
        if let token {
            guard !token.isEmpty, !token.contains(where: { $0.isNewline }) else { throw APIClientError.authenticationRequired }
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let idempotencyKey {
            guard Self.isValidIdempotencyKey(idempotencyKey) else { throw APIClientError.invalidRequest }
            request.setValue(idempotencyKey, forHTTPHeaderField: "Idempotency-Key")
        }
        if let body {
            let encoded: Data
            do { encoded = try APIJSON.makeEncoder().encode(body) }
            catch { throw APIClientError.invalidRequest }
            let requestLimit = min(
                maximumRequestBytes ?? limits.requestBodyBytes,
                limits.requestBodyBytes
            )
            guard requestLimit > 0 else { throw APIClientError.invalidRequest }
            guard encoded.count <= requestLimit else {
                throw APIClientError.requestBodyTooLarge(limit: requestLimit)
            }
            request.httpBody = encoded
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let responseLimit = min(maximumResponseBytes ?? limits.responseBodyBytes, limits.responseBodyBytes)
        guard responseLimit > 0 else { throw APIClientError.invalidRequest }
        do { return try await transport.data(for: request, maxResponseBytes: responseLimit) }
        catch let error as APIClientError { throw error }
        catch { throw APIClient.failure(from: error) }
    }

    private func performArchiveStream(_ path: String, token: String) async throws -> HTTPStreamResponse {
        guard !path.contains(".."), !token.isEmpty, !token.contains(where: { $0.isNewline }),
              var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            throw APIClientError.invalidRequest
        }
        let root = components.path.hasSuffix("/") ? String(components.path.dropLast()) : components.path
        components.path = root + (path.hasPrefix("/") ? path : "/\(path)")
        components.query = nil
        guard let url = components.url else { throw APIClientError.invalidRequest }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 300)
        request.httpMethod = "GET"
        request.setValue("application/gzip", forHTTPHeaderField: "Accept")
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        request.setValue("no-cache", forHTTPHeaderField: "Pragma")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        do { return try await transport.stream(for: request, chunkBytes: 65_536) }
        catch let error as APIClientError { throw error }
        catch { throw APIClient.failure(from: error) }
    }

    private func validatedArchiveStream(
        _ response: HTTPStreamResponse
    ) async throws -> AsyncThrowingStream<Data, any Error> {
        guard (200 ... 299).contains(response.http.statusCode) else {
            let status = response.http.statusCode
            let data = try await boundedFailureBody(response)
            let payload = try? APIJSON.makeDecoder().decode(APIErrorPayload.self, from: data)
            throw APIClientError.http(
                status: status,
                code: payload?.code,
                requestId: payload?.requestId,
                retryAfterSeconds: payload?.retryAfterSeconds
            )
        }
        let mediaType = response.http.value(forHTTPHeaderField: "Content-Type")?
            .split(separator: ";", maxSplits: 1).first.map(String.init)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        guard mediaType == "application/gzip",
              response.http.value(forHTTPHeaderField: "Cache-Control") == "private, no-store",
              response.http.value(forHTTPHeaderField: "Pragma") == "no-cache",
              response.http.value(forHTTPHeaderField: "Content-Disposition")?
              .hasPrefix("attachment;") == true else {
            response.cancel()
            throw APIClientError.malformedResponse(status: response.http.statusCode)
        }
        return response.body
    }

    private func boundedFailureBody(_ response: HTTPStreamResponse) async throws -> Data {
        var data = Data()
        do {
            for try await chunk in response.body {
                guard data.count <= limits.responseBodyBytes - chunk.count else {
                    response.cancel()
                    throw APIClientError.responseBodyTooLarge(limit: limits.responseBodyBytes)
                }
                data.append(chunk)
            }
            return data
        } catch let error as APIClientError { throw error }
        catch { throw APIClient.failure(from: error) }
    }

    private func decode<Response: Decodable>(
        _ data: Data,
        response: HTTPURLResponse,
        requirePrivateNoStore: Bool,
        as: Response.Type
    ) throws -> Response {
        if requirePrivateNoStore {
            guard response.value(forHTTPHeaderField: "Cache-Control") == "private, no-store",
                  response.value(forHTTPHeaderField: "Pragma") == "no-cache" else {
                throw APIClientError.malformedResponse(status: response.statusCode)
            }
        }
        guard (200 ... 299).contains(response.statusCode) else {
            let payload = try? APIJSON.makeDecoder().decode(APIErrorPayload.self, from: data)
            Self.failureLog.error(
                "request refused path=\(Self.pathTemplate(response.url), privacy: .public) status=\(response.statusCode, privacy: .public) code=\(payload?.code.rawValue ?? "none", privacy: .public)"
            )
            throw APIClientError.http(status: response.statusCode, code: payload?.code,
                                      requestId: payload?.requestId,
                                      retryAfterSeconds: payload?.retryAfterSeconds)
        }
        do { return try APIJSON.makeDecoder().decode(Response.self, from: data) }
        catch { throw APIClientError.malformedResponse(status: response.statusCode) }
    }


    /// A request the caller abandoned is not an outage. Reporting cancellation as a transport
    /// failure is what made an ordinary pull-to-refresh claim the phone was offline and fall
    /// back to its stored copy.
    static func failure(from error: Error) -> APIClientError {
        if error is CancellationError { return .cancelled }
        if let urlError = error as? URLError, urlError.code == .cancelled { return .cancelled }
        return .transportFailure
    }
    private static let failureLog = Logger(subsystem: "com.zachshotamartin.unfiled", category: "api")

    /// The request path with every identifier replaced, so a log line never names a record.
    nonisolated static func pathTemplate(_ url: URL?) -> String {
        guard let path = url?.path else { return "unknown" }
        return path.replacingOccurrences(
            of: #"[a-z]{2,4}_[0-9A-Za-z]{26}"#,
            with: "<id>",
            options: .regularExpression
        )
    }

    private func sanitized(_ error: Error) -> APIClientError {
        (error as? APIClientError) ?? .authenticationRequired
    }

    private static func isValidIdempotencyKey(_ value: String) -> Bool {
        guard (1 ... 80).contains(value.utf8.count),
              let first = value.utf8.first, isASCIIAlphaNumeric(first) else { return false }
        return value.utf8.dropFirst().allSatisfy {
            isASCIIAlphaNumeric($0) || $0 == 46 || $0 == 95 || $0 == 58 || $0 == 45
        }
    }

    private static func isASCIIAlphaNumeric(_ byte: UInt8) -> Bool {
        (48 ... 57).contains(byte) || (65 ... 90).contains(byte) || (97 ... 122).contains(byte)
    }
}
