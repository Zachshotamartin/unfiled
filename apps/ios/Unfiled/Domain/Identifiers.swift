import Foundation
import Security

public enum EntityIdentifierError: Error, Equatable, Sendable {
    case invalidIdentifier
    case invalidRandomness
    case timestampExhausted
    case randomSourceFailed
}

public protocol EntityIDKind: Sendable {
    static var prefix: String { get }
}

public struct EntityID<Kind: EntityIDKind>: RawRepresentable, Codable, Hashable, Sendable,
    CustomStringConvertible
{
    public let rawValue: String

    public init?(rawValue: String) {
        guard Self.isValid(rawValue) else { return nil }
        self.rawValue = rawValue
    }

    public init(validating rawValue: String) throws {
        guard Self.isValid(rawValue) else { throw EntityIdentifierError.invalidIdentifier }
        self.rawValue = rawValue
    }

    public var description: String { rawValue }

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        try self.init(validating: container.decode(String.self))
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }

    private static func isValid(_ value: String) -> Bool {
        let prefix = "\(Kind.prefix)_"
        guard value.hasPrefix(prefix) else { return false }
        let suffix = value.dropFirst(prefix.count)
        guard suffix.utf8.count == 26, suffix.count == 26 else { return false }
        return suffix.utf8.allSatisfy { byte in
            switch byte {
            case 48 ... 57, 65 ... 72, 74 ... 75, 77 ... 78, 80 ... 84, 86 ... 90: true
            default: false
            }
        }
    }
}

public enum BlockIDKind: EntityIDKind { public static let prefix = "blk" }
public enum CaptureIDKind: EntityIDKind { public static let prefix = "cap" }
public enum ChecklistIDKind: EntityIDKind { public static let prefix = "chk" }
public enum DecisionIDKind: EntityIDKind { public static let prefix = "dec" }
public enum EntryIDKind: EntityIDKind { public static let prefix = "ent" }
public enum EventIDKind: EntityIDKind { public static let prefix = "evt" }
public enum FeedbackIDKind: EntityIDKind { public static let prefix = "fbk" }
public enum ItemIDKind: EntityIDKind { public static let prefix = "itm" }
public enum JobIDKind: EntityIDKind { public static let prefix = "job" }
public enum KeyIDKind: EntityIDKind { public static let prefix = "key" }
public enum LinkIDKind: EntityIDKind { public static let prefix = "lnk" }
public enum MutationIDKind: EntityIDKind { public static let prefix = "mut" }
public enum NoteIDKind: EntityIDKind { public static let prefix = "note" }
public enum RevisionIDKind: EntityIDKind { public static let prefix = "rev" }
public enum ReviewIDKind: EntityIDKind { public static let prefix = "rvw" }
public enum RuleIDKind: EntityIDKind { public static let prefix = "rule" }
public enum SpaceIDKind: EntityIDKind { public static let prefix = "spc" }
public enum TagIDKind: EntityIDKind { public static let prefix = "tag" }

public typealias BlockID = EntityID<BlockIDKind>
public typealias CaptureID = EntityID<CaptureIDKind>
public typealias DecisionID = EntityID<DecisionIDKind>
public typealias EntryID = EntityID<EntryIDKind>
public typealias ItemID = EntityID<ItemIDKind>
public typealias JobID = EntityID<JobIDKind>
public typealias KeyID = EntityID<KeyIDKind>
public typealias LinkID = EntityID<LinkIDKind>
public typealias MutationID = EntityID<MutationIDKind>
public typealias NoteID = EntityID<NoteIDKind>
public typealias RevisionID = EntityID<RevisionIDKind>
public typealias ReviewID = EntityID<ReviewIDKind>
public typealias RuleID = EntityID<RuleIDKind>
public typealias SpaceID = EntityID<SpaceIDKind>
public typealias TagID = EntityID<TagIDKind>

public enum EntityPrefix: String, CaseIterable, Sendable {
    case attachment = "att"
    case block = "blk"
    case capture = "cap"
    case checklist = "chk"
    case decision = "dec"
    case entry = "ent"
    case event = "evt"
    case feedback = "fbk"
    case item = "itm"
    case job = "job"
    case key = "key"
    case link = "lnk"
    case mutation = "mut"
    case note
    case revision = "rev"
    case review = "rvw"
    case rule
    case space = "spc"
    case tag
}

public actor PrefixedULIDGenerator {
    public typealias Clock = @Sendable () -> UInt64
    public typealias Randomness = @Sendable () throws -> [UInt8]

    private static let alphabet = Array("0123456789ABCDEFGHJKMNPQRSTVWXYZ".utf8)
    private static let maximumTimestamp: UInt64 = 0xFFFF_FFFF_FFFF

    private let clock: Clock
    private let randomness: Randomness
    private var lastTimestamp: UInt64?
    private var lastRandomness: [UInt8] = []

    public init(
        clock: @escaping Clock = {
            UInt64(max(0, Date().timeIntervalSince1970 * 1_000))
        },
        randomness: @escaping Randomness = PrefixedULIDGenerator.secureRandomness
    ) {
        self.clock = clock
        self.randomness = randomness
    }

    public func next(_ prefix: EntityPrefix) throws -> String {
        let observed = clock()
        guard observed <= Self.maximumTimestamp else {
            throw EntityIdentifierError.timestampExhausted
        }

        let timestamp: UInt64
        let random: [UInt8]
        if let previousTimestamp = lastTimestamp, observed <= previousTimestamp {
            var incremented = lastRandomness
            if Self.incrementBigEndian(&incremented) {
                guard previousTimestamp < Self.maximumTimestamp else {
                    throw EntityIdentifierError.timestampExhausted
                }
                timestamp = previousTimestamp + 1
                random = Array(repeating: 0, count: 10)
            } else {
                timestamp = previousTimestamp
                random = incremented
            }
        } else {
            let generated = try randomness()
            guard generated.count == 10 else { throw EntityIdentifierError.invalidRandomness }
            timestamp = observed
            random = generated
        }

        lastTimestamp = timestamp
        lastRandomness = random
        return "\(prefix.rawValue)_\(Self.encode(timestamp: timestamp, randomness: random))"
    }

    public func nextID<Kind: EntityIDKind>(for _: Kind.Type) throws -> EntityID<Kind> {
        guard let prefix = EntityPrefix(rawValue: Kind.prefix) else {
            throw EntityIdentifierError.invalidIdentifier
        }
        return try EntityID(validating: next(prefix))
    }

    public nonisolated static func secureRandomness() throws -> [UInt8] {
        var bytes = Array(repeating: UInt8(0), count: 10)
        let status = bytes.withUnsafeMutableBytes { buffer in
            SecRandomCopyBytes(kSecRandomDefault, buffer.count, buffer.baseAddress!)
        }
        guard status == errSecSuccess else { throw EntityIdentifierError.randomSourceFailed }
        return bytes
    }

    /// Returns true on overflow.
    private static func incrementBigEndian(_ bytes: inout [UInt8]) -> Bool {
        for index in bytes.indices.reversed() {
            if bytes[index] == .max {
                bytes[index] = 0
            } else {
                bytes[index] += 1
                return false
            }
        }
        return true
    }

    private static func encode(timestamp: UInt64, randomness: [UInt8]) -> String {
        var bytes = Array(repeating: UInt8(0), count: 16)
        for index in 0 ..< 6 {
            bytes[index] = UInt8((timestamp >> ((5 - index) * 8)) & 0xFF)
        }
        for index in 0 ..< 10 {
            bytes[index + 6] = randomness[index]
        }

        var output = [UInt8]()
        output.reserveCapacity(26)
        for symbolIndex in 0 ..< 26 {
            var symbol = 0
            for bitOffset in 0 ..< 5 {
                let paddedBit = symbolIndex * 5 + bitOffset
                symbol <<= 1
                guard paddedBit >= 2 else { continue }
                let dataBit = paddedBit - 2
                let byte = bytes[dataBit / 8]
                symbol |= Int((byte >> UInt8(7 - dataBit % 8)) & 1)
            }
            output.append(alphabet[symbol])
        }
        return String(decoding: output, as: UTF8.self)
    }
}
