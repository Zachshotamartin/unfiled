import Foundation

public protocol HTTPTransport: Sendable {
    func data(for request: URLRequest, maxResponseBytes: Int) async throws -> (Data, HTTPURLResponse)
    func stream(for request: URLRequest, chunkBytes: Int) async throws -> HTTPStreamResponse
}

public struct HTTPStreamResponse: Sendable {
    public let body: AsyncThrowingStream<Data, any Error>
    public let http: HTTPURLResponse
    private let cancelOperation: @Sendable () -> Void

    public init(body: AsyncThrowingStream<Data, any Error>, http: HTTPURLResponse,
                cancel: @escaping @Sendable () -> Void) {
        self.body = body
        self.http = http
        cancelOperation = cancel
    }

    public func cancel() { cancelOperation() }
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

    public func stream(for request: URLRequest, chunkBytes: Int) async throws -> HTTPStreamResponse {
        guard (1 ... 1_048_576).contains(chunkBytes) else { throw APIClientError.invalidRequest }
        let (bytes, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse,
              http.url == request.url else {
            bytes.task.cancel()
            throw APIClientError.invalidHTTPResponse
        }
        let cancellation = URLSessionStreamCancellation(task: bytes.task)
        let stream = makeDemandDrivenByteStream(
            iterator: bytes.makeAsyncIterator(),
            chunkBytes: chunkBytes,
            isCancelled: { cancellation.isCancelled },
            onCancel: { cancellation.cancel() }
        )
        return HTTPStreamResponse(body: stream, http: http) { cancellation.cancel() }
    }
}

/// Adapts a byte iterator to fixed-size chunks without a producer-side queue.
/// The unfolding closure is invoked by `Iterator.next()`, so at most one chunk
/// is assembled for each unit of downstream demand.
func makeDemandDrivenByteStream<Iterator: AsyncIteratorProtocol>(
    iterator: Iterator,
    chunkBytes: Int,
    isCancelled: @escaping @Sendable () -> Bool,
    onCancel: @escaping @Sendable () -> Void
) -> AsyncThrowingStream<Data, any Error> where Iterator.Element == UInt8 {
    let reader = DemandDrivenByteChunkReader(
        iterator: iterator,
        chunkBytes: chunkBytes,
        isCancelled: isCancelled
    )
    return AsyncThrowingStream(unfolding: {
        try await withTaskCancellationHandler {
            try await reader.nextChunk()
        } onCancel: {
            onCancel()
        }
    })
}

private final class DemandDrivenByteChunkReader<Iterator: AsyncIteratorProtocol>: @unchecked Sendable
where Iterator.Element == UInt8 {
    private var iterator: Iterator
    private let chunkBytes: Int
    private let isCancelled: @Sendable () -> Bool
    private var isFinished = false

    init(
        iterator: Iterator,
        chunkBytes: Int,
        isCancelled: @escaping @Sendable () -> Bool
    ) {
        self.iterator = iterator
        self.chunkBytes = chunkBytes
        self.isCancelled = isCancelled
    }

    func nextChunk() async throws -> Data? {
        guard !isFinished else { return nil }
        do {
            try checkCancellation()
            var chunk = Data()
            chunk.reserveCapacity(chunkBytes)
            while chunk.count < chunkBytes {
                try checkCancellation()
                guard let byte = try await iterator.next() else {
                    isFinished = true
                    return chunk.isEmpty ? nil : chunk
                }
                chunk.append(byte)
            }
            return chunk
        } catch is CancellationError {
            isFinished = true
            throw APIClientError.transportFailure
        } catch let error as APIClientError {
            isFinished = true
            throw error
        } catch {
            isFinished = true
            throw APIClientError.transportFailure
        }
    }

    private func checkCancellation() throws {
        try Task.checkCancellation()
        if isCancelled() { throw CancellationError() }
    }
}

private final class URLSessionStreamCancellation: @unchecked Sendable {
    private let lock = NSLock()
    private let task: URLSessionTask
    private var cancelled = false

    init(task: URLSessionTask) { self.task = task }

    var isCancelled: Bool { lock.withLock { cancelled } }

    func cancel() {
        let shouldCancel = lock.withLock {
            guard !cancelled else { return false }
            cancelled = true
            return true
        }
        if shouldCancel { task.cancel() }
    }

    deinit { task.cancel() }
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
