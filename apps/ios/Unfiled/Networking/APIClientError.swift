import Foundation

/// Public failures intentionally exclude response bodies, token values, server messages, and transport details.
public enum APIClientError: Error, Equatable, Sendable {
    case invalidConfiguration
    case invalidRequest
    case requestBodyTooLarge(limit: Int)
    case responseBodyTooLarge(limit: Int)
    case transportFailure
    /// The caller went away before the reply did. Never an outage, never shown to the owner.
    case cancelled
    case invalidHTTPResponse
    case authenticationRequired
    case http(status: Int, code: APIErrorCode?, requestId: String?, retryAfterSeconds: Int?)
    case malformedResponse(status: Int)
}

extension APIClientError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case .invalidConfiguration: "The API client is not configured."
        case .invalidRequest: "The request could not be created."
        case .requestBodyTooLarge: "The request is too large."
        case .responseBodyTooLarge: "The response is too large."
        case .transportFailure: "The service could not be reached."
        case .cancelled: "The request was cancelled."
        case .invalidHTTPResponse: "The service returned an invalid response."
        case .authenticationRequired: "Authentication is required."
        case let .http(status, code, _, _): "The service rejected the request (\(code?.rawValue ?? "http_\(status)"))."
        case .malformedResponse: "The service returned malformed data."
        }
    }
}
