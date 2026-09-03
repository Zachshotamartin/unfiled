import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// Turns whatever the picker or camera hands over into the one form that leaves the phone: a JPEG
/// no longer than 1568 px on its long edge, under 700,000 bytes, re-encoded from a bare bitmap so
/// no camera, location or editing metadata survives.
enum CaptureImagePreparation {
    static let maximumLongEdge = 1568
    static let maximumBytes = 700_000
    private static let qualities: [Double] = [0.8, 0.7, 0.6, 0.5]

    struct Prepared: Equatable {
        let data: Data
        let width: Int
        let height: Int

        var mediaType: String { "image/jpeg" }
    }

    enum Failure: Error, Equatable {
        case unreadable
        case tooLarge
    }

    static func prepare(imageData: Data) throws -> Prepared {
        guard !imageData.isEmpty,
              let source = CGImageSourceCreateWithData(
                  imageData as CFData,
                  [kCGImageSourceShouldCache: false] as CFDictionary
              ),
              CGImageSourceGetCount(source) > 0 else { throw Failure.unreadable }
        var longEdge = maximumLongEdge
        for _ in 0 ..< 4 {
            guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceThumbnailMaxPixelSize: longEdge,
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceShouldCache: false
            ] as CFDictionary) else { throw Failure.unreadable }
            for quality in qualities {
                let data = try encodeJPEG(image, quality: quality)
                if data.count <= maximumBytes {
                    return Prepared(data: data, width: image.width, height: image.height)
                }
            }
            longEdge = longEdge * 3 / 4
        }
        throw Failure.tooLarge
    }

    /// Writes the bitmap alone: no properties beyond the quality, so nothing from the original
    /// file rides along.
    private static func encodeJPEG(_ image: CGImage, quality: Double) throws -> Data {
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            data, UTType.jpeg.identifier as CFString, 1, nil
        ) else { throw Failure.unreadable }
        CGImageDestinationAddImage(
            destination, image,
            [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary
        )
        guard CGImageDestinationFinalize(destination) else { throw Failure.unreadable }
        return data as Data
    }
}
