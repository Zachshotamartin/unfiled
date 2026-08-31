import Foundation
import XCTest
@testable import Unfiled

final class AuthSessionManagerTests: XCTestCase {
    func testValidSessionDoesNotRefresh() async throws {
        let current = authSession(access: "valid", expiresAt: Date(timeIntervalSince1970: 10_000))
        let remote = AuthRemoteStub(refreshedSession: authSession(access: "unused"))
        let manager = try AuthSessionManager(vault: AuthMemorySessionVault(current), remote: remote,
                                             clock: { Date(timeIntervalSince1970: 1_000) })
        let token = try await manager.accessToken()
        let refreshCount = await remote.refreshCount
        XCTAssertEqual(token, "valid")
        XCTAssertEqual(refreshCount, 0)
    }

    func testConcurrentExpiredSessionRefreshesExactlyOnceAndPersistsRotation() async throws {
        let old = authSession(access: "expired", refresh: "refresh-1", expiresAt: Date(timeIntervalSince1970: 999))
        let rotated = authSession(access: "fresh", refresh: "refresh-2", expiresAt: Date(timeIntervalSince1970: 9_000))
        let vault = AuthMemorySessionVault(old)
        let remote = AuthRemoteStub(refreshedSession: rotated)
        let manager = try AuthSessionManager(vault: vault, remote: remote,
                                             clock: { Date(timeIntervalSince1970: 1_000) })
        async let first = manager.accessToken()
        async let second = manager.accessToken()
        async let third = manager.accessToken()
        let tokens = try await [first, second, third]
        let refreshCount = await remote.refreshCount
        let receivedRefreshToken = await remote.receivedRefreshToken
        XCTAssertEqual(tokens, ["fresh", "fresh", "fresh"])
        XCTAssertEqual(refreshCount, 1)
        XCTAssertEqual(receivedRefreshToken, "refresh-1")
        XCTAssertEqual(vault.snapshot(), rotated)
        XCTAssertEqual(vault.saveCount, 1)
    }

    func testUnauthorizedForStaleTokenUsesAlreadyRotatedSession() async throws {
        let rotated = authSession(access: "new", refresh: "new-refresh", expiresAt: Date(timeIntervalSince1970: 9_000))
        let remote = AuthRemoteStub(refreshedSession: rotated)
        let manager = try AuthSessionManager(vault: AuthMemorySessionVault(rotated), remote: remote,
                                             clock: { Date(timeIntervalSince1970: 1_000) })
        let token = try await manager.refreshAfterUnauthorized(rejectedToken: "old")
        let refreshCount = await remote.refreshCount
        XCTAssertEqual(token, "new")
        XCTAssertEqual(refreshCount, 0)
    }

    func testRejectedRefreshClearsCompromisedSession() async throws {
        let old = authSession(expiresAt: Date(timeIntervalSince1970: 999))
        let vault = AuthMemorySessionVault(old)
        let remote = AuthRemoteStub(refreshedSession: old)
        await remote.setRefreshError(APIClientError.http(status: 401, code: .unauthorized,
                                                         requestId: "r", retryAfterSeconds: nil))
        let manager = try AuthSessionManager(vault: vault, remote: remote,
                                             clock: { Date(timeIntervalSince1970: 1_000) })
        await XCTAssertThrowsAuthError(try await manager.accessToken())
        XCTAssertNil(vault.snapshot())
        XCTAssertEqual(vault.clearCount, 1)
    }

    func testSignOutClearsKeychainEvenWhenRemoteFails() async throws {
        let vault = AuthMemorySessionVault(authSession())
        let remote = AuthRemoteStub(refreshedSession: authSession())
        await remote.setSignOutError(AuthRemoteStub.Failure.rejected)
        let manager = try AuthSessionManager(vault: vault, remote: remote)
        await XCTAssertThrowsAuthError(try await manager.signOut())
        XCTAssertNil(vault.snapshot())
        XCTAssertEqual(vault.clearCount, 1)
        let signOutCount = await remote.signOutCount
        XCTAssertEqual(signOutCount, 1)
    }

    func testSignOutClearsMemoryAndVaultBeforeRemoteRevocationCompletes() async throws {
        let stored = authSession(access: "old-access", expiresAt: Date(timeIntervalSince1970: 9_000))
        let vault = AuthMemorySessionVault(stored)
        let remote = AuthControlledRemote(refreshedSession: stored, blocksSignOut: true)
        let manager = try AuthSessionManager(
            vault: vault,
            remote: remote,
            clock: { Date(timeIntervalSince1970: 1_000) }
        )

        let signOut = Task { try await manager.signOut() }
        await remote.waitUntilSignOutStarts()

        XCTAssertNil(vault.snapshot())
        let userWhileRemoteIsBlocked = await manager.currentUser()
        XCTAssertNil(userWhileRemoteIsBlocked)
        do {
            _ = try await manager.accessToken()
            XCTFail("Locally signed-out state must be visible before remote revocation completes")
        } catch {
            XCTAssertEqual(error as? AuthenticationError, .signedOut)
        }

        await remote.releaseSignOut()
        try await signOut.value
    }

    func testSignOutEpochPreventsInFlightRefreshFromRepopulatingSession() async throws {
        let old = authSession(
            access: "expired",
            refresh: "old-refresh",
            expiresAt: Date(timeIntervalSince1970: 999)
        )
        let refreshed = authSession(
            access: "stale-refresh-result",
            refresh: "rotated-refresh",
            expiresAt: Date(timeIntervalSince1970: 9_000)
        )
        let vault = AuthMemorySessionVault(old)
        let remote = AuthControlledRemote(refreshedSession: refreshed, blocksRefresh: true)
        let manager = try AuthSessionManager(
            vault: vault,
            remote: remote,
            clock: { Date(timeIntervalSince1970: 1_000) }
        )

        let token = Task { try await manager.accessToken() }
        await remote.waitUntilRefreshStarts()
        try await manager.signOut()
        await remote.releaseRefresh()

        do {
            _ = try await token.value
            XCTFail("A pre-sign-out refresh must not become the current session")
        } catch {
            XCTAssertEqual(error as? AuthenticationError, .signedOut)
        }
        XCTAssertNil(vault.snapshot())
        XCTAssertEqual(vault.saveCount, 0)
        let currentUser = await manager.currentUser()
        XCTAssertNil(currentUser)
    }

    func testAcceptEpochPreventsOlderRefreshFromOverwritingNewUser() async throws {
        let old = authSession(
            access: "expired",
            refresh: "old-refresh",
            expiresAt: Date(timeIntervalSince1970: 999)
        )
        let staleRefresh = authSession(
            access: "stale-access",
            refresh: "stale-rotated-refresh",
            expiresAt: Date(timeIntervalSince1970: 9_000)
        )
        let newUserID = UUID(uuidString: "22222222-2222-2222-2222-222222222222")!
        let replacement = authSession(
            access: "replacement-access",
            refresh: "replacement-refresh",
            expiresAt: Date(timeIntervalSince1970: 9_000),
            userID: newUserID,
            email: "replacement@example.com"
        )
        let vault = AuthMemorySessionVault(old)
        let remote = AuthControlledRemote(refreshedSession: staleRefresh, blocksRefresh: true)
        let manager = try AuthSessionManager(
            vault: vault,
            remote: remote,
            clock: { Date(timeIntervalSince1970: 1_000) }
        )

        let oldToken = Task { try await manager.accessToken() }
        await remote.waitUntilRefreshStarts()
        try await manager.accept(replacement)
        await remote.releaseRefresh()

        do {
            _ = try await oldToken.value
            XCTFail("An older refresh must not overwrite an accepted replacement session")
        } catch {
            XCTAssertEqual(error as? AuthenticationError, .signedOut)
        }
        XCTAssertEqual(vault.snapshot(), replacement)
        XCTAssertEqual(vault.saveCount, 1)
        let currentToken = try await manager.accessToken()
        XCTAssertEqual(currentToken, "replacement-access")
        let currentUser = await manager.currentUser()
        XCTAssertEqual(currentUser?.id, newUserID)
    }

    func testRejectedCredentialCannotCrossAnAcceptedAccountBoundary() async throws {
        let original = authSession(
            access: "profile-a-access",
            refresh: "profile-a-refresh",
            expiresAt: Date(timeIntervalSince1970: 9_000)
        )
        let replacementUserID = UUID(uuidString: "22222222-2222-4222-8222-222222222222")!
        let replacement = authSession(
            access: "profile-b-access",
            refresh: "profile-b-refresh",
            expiresAt: Date(timeIntervalSince1970: 9_000),
            userID: replacementUserID,
            email: "profile-b@example.com"
        )
        let manager = try AuthSessionManager(
            vault: AuthMemorySessionVault(original),
            remote: AuthRemoteStub(refreshedSession: replacement),
            clock: { Date(timeIntervalSince1970: 1_000) }
        )
        let profileACredential = try await manager.accessTokenCredential()

        try await manager.accept(replacement)

        do {
            _ = try await manager.refreshAfterUnauthorized(
                rejectedCredential: profileACredential
            )
            XCTFail("A rejected profile A request must never receive profile B's bearer token")
        } catch {
            XCTAssertEqual(error as? AuthenticationError, .signedOut)
        }
        let currentToken = try await manager.accessToken()
        XCTAssertEqual(currentToken, "profile-b-access")
    }

    func testRefreshCannotChangeAuthenticatedUserIdentity() async throws {
        let old = authSession(access: "expired", expiresAt: Date(timeIntervalSince1970: 999))
        let otherUserID = UUID(uuidString: "33333333-3333-3333-3333-333333333333")!
        let wrongUser = authSession(
            access: "wrong-user-access",
            refresh: "wrong-user-refresh",
            expiresAt: Date(timeIntervalSince1970: 9_000),
            userID: otherUserID,
            email: "other@example.com"
        )
        let vault = AuthMemorySessionVault(old)
        let manager = try AuthSessionManager(
            vault: vault,
            remote: AuthRemoteStub(refreshedSession: wrongUser),
            clock: { Date(timeIntervalSince1970: 1_000) }
        )

        do {
            _ = try await manager.accessToken()
            XCTFail("Refresh must remain bound to the authenticated user")
        } catch {
            XCTAssertEqual(error as? AuthenticationError, .refreshFailed)
        }
        XCTAssertEqual(vault.snapshot(), old)
        XCTAssertEqual(vault.saveCount, 0)
        let currentUser = await manager.currentUser()
        XCTAssertEqual(currentUser?.id, old.user.id)
    }

    func testAcceptDoesNotReplaceMemoryWhenVaultWriteFails() async throws {
        let old = authSession(access: "old", expiresAt: Date(timeIntervalSince1970: 9_000))
        let vault = AuthMemorySessionVault(old); vault.failSave = true
        let remote = AuthRemoteStub(refreshedSession: old)
        let manager = try AuthSessionManager(vault: vault, remote: remote,
                                             clock: { Date(timeIntervalSince1970: 1_000) })
        do { try await manager.accept(authSession(access: "new")); XCTFail("Expected storage error") }
        catch { XCTAssertEqual(error as? AuthenticationError, .sessionStorageUnavailable) }
        let token = try await manager.accessToken()
        XCTAssertEqual(token, "old")
    }
}

private func XCTAssertThrowsAuthError<T>(_ expression: @autoclosure () async throws -> T,
                                         file: StaticString = #filePath, line: UInt = #line) async {
    do { _ = try await expression(); XCTFail("Expected error", file: file, line: line) }
    catch {}
}
