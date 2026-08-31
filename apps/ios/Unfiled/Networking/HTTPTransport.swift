import Foundation

public protocol HTTPTransport: Sendable {
    func data(for request: URLRequest, maxResponseBytes: Int) async throws -> (Data, HTTPURLResponse)
}

final class RedirectRejectingSessionDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }
}

public final class URLSessionTransport: HTTPTransport, @unchecked Sendable {
    private let session: URLSession
    private let redirectDelegate: RedirectRejectingSessionDelegate

    public convenience init() { self.init(protocolClasses: nil) }

    init(protocolClasses: [AnyClass]?) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCredentialStorage = nil
        if let protocolClasses {
            configuration.protocolClasses = protocolClasses
        }
        let redirectDelegate = RedirectRejectingSessionDelegate()
        self.redirectDelegate = redirectDelegate
        session = URLSession(
            configuration: configuration,
            delegate: redirectDelegate,
            delegateQueue: nil
        )
    }

    public func data(for request: URLRequest, maxResponseBytes: Int) async throws -> (Data, HTTPURLResponse) {
        let (bytes, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse,
              http.url == request.url else {
            throw APIClientError.invalidHTTPResponse
        }
        if let advertised = http.value(forHTTPHeaderField: "Content-Length"),
           let count = Int(advertised), count > maxResponseBytes {
            throw APIClientError.responseBodyTooLarge(limit: maxResponseBytes)
        }
        var data = Data()
        data.reserveCapacity(min(maxResponseBytes, max(0, response.expectedContentLength > 0 ? Int(response.expectedContentLength) : 0)))
        for try await byte in bytes {
            guard data.count < maxResponseBytes else {
                throw APIClientError.responseBodyTooLarge(limit: maxResponseBytes)
            }
            data.append(byte)
        }
        return (data, http)
    }
}

public struct AccessTokenCredential: Equatable, Sendable {
    public let token: String
    public let userID: UUID
    public let sessionGeneration: UInt64

    public init(token: String, userID: UUID, sessionGeneration: UInt64) {
        self.token = token
        self.userID = userID
        self.sessionGeneration = sessionGeneration
    }
}

public protocol AccessTokenProviding: Sendable {
    func accessTokenCredential() async throws -> AccessTokenCredential
    func refreshAfterUnauthorized(
        rejectedCredential: AccessTokenCredential
    ) async throws -> AccessTokenCredential
}
