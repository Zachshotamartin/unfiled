import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
import XCTest
@testable import Unfiled

/// Photos leave the phone downscaled, re-encoded as JPEG, under the byte cap, and stripped of
/// every camera and location field.
final class CaptureImagePreparationTests: XCTestCase {
    func testDownscalesReencodesUnderTheCapAndDropsLocationMetadata() throws {
        let original = try Self.jpeg(width: 4000, height: 3000, noisy: true, tagged: true)
        XCTAssertNotNil(try Self.properties(of: original)[kCGImagePropertyGPSDictionary as String])

        let prepared = try CaptureImagePreparation.prepare(imageData: original)

        XCTAssertEqual(prepared.width, CaptureImagePreparation.maximumLongEdge)
        XCTAssertEqual(prepared.height, 1176)
        XCTAssertLessThanOrEqual(prepared.data.count, CaptureImagePreparation.maximumBytes)
        XCTAssertEqual(Array(prepared.data.prefix(2)), [0xFF, 0xD8], "the upload is a JPEG")
        let properties = try Self.properties(of: prepared.data)
        XCTAssertNil(properties[kCGImagePropertyGPSDictionary as String])
        let exif = properties[kCGImagePropertyExifDictionary as String] as? [String: Any] ?? [:]
        XCTAssertNil(exif[kCGImagePropertyExifUserComment as String], "camera and editing fields never survive")
        XCTAssertNil(exif[kCGImagePropertyExifDateTimeOriginal as String])
        let tiff = properties[kCGImagePropertyTIFFDictionary as String] as? [String: Any] ?? [:]
        XCTAssertNil(tiff[kCGImagePropertyTIFFMake as String])
        XCTAssertNil(tiff[kCGImagePropertyTIFFModel as String])
        XCTAssertEqual(properties[kCGImagePropertyPixelWidth as String] as? Int, 1568)
        XCTAssertEqual(properties[kCGImagePropertyPixelHeight as String] as? Int, 1176)
    }

    func testKeepsSmallImagesAtTheirSizeAndRefusesJunk() throws {
        let small = try Self.jpeg(width: 300, height: 200, noisy: false, tagged: false)
        let prepared = try CaptureImagePreparation.prepare(imageData: small)
        XCTAssertEqual(prepared.width, 300)
        XCTAssertEqual(prepared.height, 200)
        XCTAssertEqual(prepared.mediaType, "image/jpeg")
        XCTAssertThrowsError(try CaptureImagePreparation.prepare(imageData: Data("not an image".utf8)))
        XCTAssertThrowsError(try CaptureImagePreparation.prepare(imageData: Data()))
    }

    private static func jpeg(width: Int, height: Int, noisy: Bool, tagged: Bool) throws -> Data {
        let context = try XCTUnwrap(CGContext(
            data: nil,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
        ))
        if noisy, let buffer = context.data {
            arc4random_buf(buffer, context.bytesPerRow * height)
        } else {
            context.setFillColor(CGColor(red: 0.9, green: 0.4, blue: 0.2, alpha: 1))
            context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        }
        let image = try XCTUnwrap(context.makeImage())
        let data = NSMutableData()
        let destination = try XCTUnwrap(
            CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil)
        )
        var properties: [CFString: Any] = [kCGImageDestinationLossyCompressionQuality: 0.9]
        if tagged {
            properties[kCGImagePropertyGPSDictionary] = [
                kCGImagePropertyGPSLatitude: 37.3349,
                kCGImagePropertyGPSLongitude: 122.009
            ] as [CFString: Any]
            properties[kCGImagePropertyExifDictionary] = [
                kCGImagePropertyExifUserComment: "kept private"
            ] as [CFString: Any]
        }
        CGImageDestinationAddImage(destination, image, properties as CFDictionary)
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        return data as Data
    }

    private static func properties(of data: Data) throws -> [String: Any] {
        let source = try XCTUnwrap(CGImageSourceCreateWithData(data as CFData, nil))
        return try XCTUnwrap(CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [String: Any])
    }
}
