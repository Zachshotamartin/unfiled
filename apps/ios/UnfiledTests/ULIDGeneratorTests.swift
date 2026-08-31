import XCTest
@testable import Unfiled

final class ULIDGeneratorTests: XCTestCase {
    func testStrictEntityIdentifierValidation() throws {
        XCTAssertNotNil(NoteID(rawValue: "note_00000000000000000000000000"))
        XCTAssertNil(NoteID(rawValue: "tag_00000000000000000000000000"))
        XCTAssertNil(NoteID(rawValue: "note_0000000000000000000000000I"))
        XCTAssertNil(NoteID(rawValue: "note_0000000000000000000000000o"))
        XCTAssertNil(NoteID(rawValue: "note_0000000000000000000000000"))
        XCTAssertThrowsError(try NoteID(validating: "note_invalid"))
    }

    func testKnownULIDVectorAndPrefix() async throws {
        let generator = PrefixedULIDGenerator(clock: { 1 }, randomness: { Array(repeating: 0, count: 10) })
        let value = try await generator.next(.capture)
        XCTAssertEqual(value, "cap_00000000010000000000000000")
    }

    func testSameAndBackwardMillisecondsRemainMonotonic() async throws {
        final class ClockBox: @unchecked Sendable {
            private let lock = NSLock(); private var values: [UInt64] = [10, 10, 9]
            func next() -> UInt64 { lock.withLock { values.removeFirst() } }
        }
        let clock = ClockBox()
        let generator = PrefixedULIDGenerator(clock: { clock.next() }, randomness: { Array(repeating: 0, count: 10) })
        let first = try await generator.next(.note)
        let second = try await generator.next(.note)
        let third = try await generator.next(.note)
        XCTAssertLessThan(first, second); XCTAssertLessThan(second, third)
        XCTAssertTrue(first.hasSuffix("0000000000000000"))
        XCTAssertTrue(second.hasSuffix("0000000000000001"))
        XCTAssertTrue(third.hasSuffix("0000000000000002"))
    }

    func testRandomOverflowAdvancesTimestamp() async throws {
        let generator = PrefixedULIDGenerator(clock: { 1 }, randomness: { Array(repeating: .max, count: 10) })
        let first = try await generator.next(.note)
        let second = try await generator.next(.note)
        XCTAssertEqual(first, "note_0000000001ZZZZZZZZZZZZZZZZ")
        XCTAssertEqual(second, "note_00000000020000000000000000")
        XCTAssertLessThan(first, second)
    }

    func testTypedGeneratorAndRandomLengthFailure() async throws {
        let valid = PrefixedULIDGenerator(clock: { 1 }, randomness: { Array(repeating: 0, count: 10) })
        let id: NoteID = try await valid.nextID(for: NoteIDKind.self)
        XCTAssertEqual(id.rawValue, "note_00000000010000000000000000")

        let invalid = PrefixedULIDGenerator(clock: { 1 }, randomness: { [0] })
        do { _ = try await invalid.next(.note); XCTFail("Expected invalid randomness") }
        catch { XCTAssertEqual(error as? EntityIdentifierError, .invalidRandomness) }
    }

    func testTimestampAbove48BitsFails() async throws {
        let generator = PrefixedULIDGenerator(clock: { 0x1_0000_0000_0000 }, randomness: { Array(repeating: 0, count: 10) })
        do { _ = try await generator.next(.note); XCTFail("Expected exhausted timestamp") }
        catch { XCTAssertEqual(error as? EntityIdentifierError, .timestampExhausted) }
    }
}
