import Foundation
import XCTest
@testable import Unfiled

final class APIURLProtocolStub: URLProtocol, @unchecked Sendable {
    typealias Handler = @Sendable (URLRequest) throws -> (HTTPURLResponse, Data)
    private static let lock = NSLock()
    nonisolated(unsafe) private static var handler: Handler?

    static func install(_ value: @escaping Handler) {
        lock.withLock { handler = value }
    }

    static func reset() {
        lock.withLock { handler = nil }
    }

    override class func canInit(with _: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let current = Self.lock.withLock { Self.handler }
        guard let current else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        do {
            let (response, data) = try current(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

func makeStubbedAPIClient(tokenProvider: (any AccessTokenProviding)? = nil,
                          limits: APIClient.Limits = .init()) throws -> APIClient {
    return try APIClient(baseURL: URL(string: "https://api.example.test/api/v1")!,
                         transport: URLSessionTransport(protocolClasses: [APIURLProtocolStub.self]),
                         tokenProvider: tokenProvider, limits: limits)
}

func apiResponse(for request: URLRequest, status: Int = 200, json: String) -> (HTTPURLResponse, Data) {
    let response = HTTPURLResponse(url: request.url!, statusCode: status,
                                   httpVersion: "HTTP/1.1",
                                   headerFields: ["Content-Type": "application/json"])!
    return (response, Data(json.utf8))
}

func apiRequestBody(_ request: URLRequest) throws -> Data {
    if let body = request.httpBody { return body }
    guard let stream = request.httpBodyStream else { throw URLError(.cannotDecodeContentData) }
    stream.open()
    defer { stream.close() }
    var result = Data()
    var buffer = [UInt8](repeating: 0, count: 4_096)
    while stream.hasBytesAvailable {
        let count = stream.read(&buffer, maxLength: buffer.count)
        guard count >= 0 else { throw stream.streamError ?? URLError(.cannotDecodeContentData) }
        if count == 0 { break }
        result.append(buffer, count: count)
    }
    return result
}

actor APITokenProviderStub: AccessTokenProviding {
    private(set) var accessCalls = 0
    private(set) var refreshCalls = 0
    var token = "old-token"

    func accessTokenCredential() -> AccessTokenCredential {
        accessCalls += 1
        return AccessTokenCredential(
            token: token,
            userID: UUID(uuidString: "11111111-1111-4111-8111-111111111111")!,
            sessionGeneration: 1
        )
    }

    func refreshAfterUnauthorized(
        rejectedCredential: AccessTokenCredential
    ) -> AccessTokenCredential {
        refreshCalls += 1
        token = "new-token"
        return AccessTokenCredential(
            token: token,
            userID: rejectedCredential.userID,
            sessionGeneration: rejectedCredential.sessionGeneration
        )
    }
}
