import Foundation

enum AccountDataSecurityError: Error, Equatable, Sendable {
    case invalidRecoveryRecord
    case secureStorageUnavailable
    case invalidExport
}

struct AccountExportArtifact: Identifiable, Equatable, Sendable {
    let id: UUID
    let fileURL: URL
    let directoryURL: URL

    init(id: UUID = UUID(), fileURL: URL, directoryURL: URL) {
        self.id = id
        self.fileURL = fileURL
        self.directoryURL = directoryURL
    }
}

enum SecureAccountExportWriter {
    private static let gzipSignature: [UInt8] = [0x1F, 0x8B, 0x08]
    private static let exportDirectoryName = "unfiled-secure-exports"

    static func write(
        _ stream: AsyncThrowingStream<Data, any Error>,
        baseDirectory: URL = FileManager.default.temporaryDirectory,
        fileManager: FileManager = .default
    ) async throws -> AccountExportArtifact {
        let identifier = UUID()
        let directory = exportRoot(baseDirectory: baseDirectory)
            .appendingPathComponent(identifier.uuidString.lowercased(), isDirectory: true)
        let file = directory.appendingPathComponent("unfiled-export.tar.gz", isDirectory: false)
        do {
            try fileManager.createDirectory(
                at: directory,
                withIntermediateDirectories: true,
                attributes: [.protectionKey: FileProtectionType.complete]
            )
            var directoryValues = URLResourceValues()
            directoryValues.isExcludedFromBackup = true
            var protectedDirectory = directory
            try protectedDirectory.setResourceValues(directoryValues)
            guard fileManager.createFile(
                atPath: file.path,
                contents: nil,
                attributes: [.protectionKey: FileProtectionType.complete]
            ) else {
                throw AccountDataSecurityError.invalidExport
            }

            let handle = try FileHandle(forWritingTo: file)
            defer { try? handle.close() }
            var signature: [UInt8] = []
            var receivedBytes = 0
            for try await chunk in stream {
                try Task.checkCancellation()
                guard !chunk.isEmpty else { continue }
                if signature.count < gzipSignature.count {
                    signature.append(
                        contentsOf: chunk.prefix(gzipSignature.count - signature.count)
                    )
                    if signature.count == gzipSignature.count,
                       signature != gzipSignature {
                        throw AccountDataSecurityError.invalidExport
                    }
                }
                try handle.write(contentsOf: chunk)
                receivedBytes += chunk.count
            }
            try handle.synchronize()
            guard receivedBytes >= gzipSignature.count,
                  signature == gzipSignature else {
                throw AccountDataSecurityError.invalidExport
            }
            try fileManager.setAttributes(
                [.protectionKey: FileProtectionType.complete],
                ofItemAtPath: file.path
            )
            return AccountExportArtifact(
                id: identifier,
                fileURL: file,
                directoryURL: directory
            )
        } catch {
            try? fileManager.removeItem(at: directory)
            throw error
        }
    }

    static func remove(
        _ artifact: AccountExportArtifact,
        fileManager: FileManager = .default
    ) {
        try? fileManager.removeItem(at: artifact.directoryURL)
    }

    /// Export files never survive an app relaunch. The path is app-owned and exact,
    /// so cleanup cannot expand to the surrounding temporary directory.
    static func removeStaleArtifacts(
        baseDirectory: URL = FileManager.default.temporaryDirectory,
        fileManager: FileManager = .default
    ) {
        try? fileManager.removeItem(at: exportRoot(baseDirectory: baseDirectory))
    }

    private static func exportRoot(baseDirectory: URL) -> URL {
        baseDirectory.appendingPathComponent(exportDirectoryName, isDirectory: true)
    }
}

struct AccountDeletionRecoveryRecord: Codable, Equatable, Sendable {
    let ownerID: UUID
    let capability: AccountDeletionToken
    let createdAt: Date
    let confirmedReceipt: AccountDeletionReceipt?

    init(
        ownerID: UUID,
        capability: AccountDeletionToken,
        createdAt: Date = Date(),
        confirmedReceipt: AccountDeletionReceipt? = nil
    ) {
        self.ownerID = ownerID
        self.capability = capability
        self.createdAt = createdAt
        self.confirmedReceipt = confirmedReceipt
    }

    func confirming(_ receipt: AccountDeletionReceipt) -> Self {
        Self(
            ownerID: ownerID,
            capability: capability,
            createdAt: createdAt,
            confirmedReceipt: receipt
        )
    }
}

protocol AccountDeletionRecoveryStoring: Sendable {
    func load() throws -> AccountDeletionRecoveryRecord?
    func save(_ record: AccountDeletionRecoveryRecord) throws
    func clear() throws
}

final class KeychainAccountDeletionRecoveryStore: AccountDeletionRecoveryStoring,
    @unchecked Sendable
{
    static let maximumRecordBytes = 64 * 1_024

    private let store: any SecureDataStore
    private let service: String
    private let account: String

    init(
        store: any SecureDataStore = SystemKeychainStore(),
        service: String,
        account: String = "pending-account-deletion-v1"
    ) {
        self.store = store
        self.service = service
        self.account = account
    }

    func load() throws -> AccountDeletionRecoveryRecord? {
        let data: Data?
        do { data = try store.read(service: service, account: account) }
        catch { throw AccountDataSecurityError.secureStorageUnavailable }
        guard let data else { return nil }
        guard data.count <= Self.maximumRecordBytes else {
            throw AccountDataSecurityError.invalidRecoveryRecord
        }
        do {
            let record = try APIJSON.makeDecoder().decode(
                AccountDeletionRecoveryRecord.self,
                from: data
            )
            guard record.createdAt <= Date().addingTimeInterval(5 * 60) else {
                throw AccountDataSecurityError.invalidRecoveryRecord
            }
            return record
        } catch let error as AccountDataSecurityError {
            throw error
        } catch {
            throw AccountDataSecurityError.invalidRecoveryRecord
        }
    }

    func save(_ record: AccountDeletionRecoveryRecord) throws {
        let data: Data
        do { data = try APIJSON.makeEncoder().encode(record) }
        catch { throw AccountDataSecurityError.invalidRecoveryRecord }
        guard data.count <= Self.maximumRecordBytes else {
            throw AccountDataSecurityError.invalidRecoveryRecord
        }
        do {
            try store.write(
                data,
                service: service,
                account: account,
                accessibility: .whenUnlockedThisDeviceOnly
            )
        } catch {
            throw AccountDataSecurityError.secureStorageUnavailable
        }
    }

    func clear() throws {
        do { try store.delete(service: service, account: account) }
        catch { throw AccountDataSecurityError.secureStorageUnavailable }
    }
}

struct AccountDeletionReceiptPresentation: Identifiable, Equatable, Sendable {
    let receipt: AccountDeletionReceipt
    let localDataRemoved: Bool
    let localSessionCleared: Bool
    let recoveryRecordCleared: Bool

    var id: String { APIJSON.dateString(receipt.deletedAt) }
    var deletedRecordCount: Int { receipt.deletedRecordCounts.values.reduce(0, +) }
    var localCleanupComplete: Bool {
        localDataRemoved && localSessionCleared && recoveryRecordCleared
    }
}

enum AccountDataPresentation {
    static func deletionConfirmationIsExact(_ value: String) -> Bool {
        value == "DELETE"
    }

    static func exportFailure(_ error: Error) -> String {
        guard let error = error as? APIClientError else {
            return "The private export could not be prepared. Try again."
        }
        switch error {
        case .transportFailure, .invalidHTTPResponse:
            return "Reconnect to prepare your private export."
        case .authenticationRequired:
            return "Sign in again before exporting your data."
        default:
            return "The private export could not be prepared. Try again."
        }
    }

    static func deletionFailure(isPendingReplay: Bool) -> String {
        isPendingReplay
            ? "Unfiled could not confirm deletion. Retry the exact request; its protected recovery key is still on this iPhone."
            : "The account was not deleted. Check your connection and try again."
    }
}
