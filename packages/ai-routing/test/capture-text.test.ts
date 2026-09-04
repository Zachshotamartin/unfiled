import { describe, expect, it } from "vitest";

import {
  captureKindText,
  captureRetrievalText,
  isUploadPlaceholderCapture,
  ownerCaptureText
} from "../src/index.js";

const DESCRIPTOR = "Handwritten shopping list: milk, eggs, rice";

describe("how the organizer reads a capture", () => {
  it("treats the client's upload placeholder as no owner text at all", () => {
    for (const rawContent of ["Photo", "Photos", "Voice note", " photo ", "PHOTOS"]) {
      const capture = { rawContent, attachmentCount: 1 };
      expect(isUploadPlaceholderCapture(capture)).toBe(true);
      expect(ownerCaptureText(capture)).toBe("");
    }
    // The placeholder only exists to stand in for an upload. Without one it is the owner's word.
    expect(ownerCaptureText({ rawContent: "Photo", attachmentCount: 0 })).toBe("Photo");
    expect(ownerCaptureText({ rawContent: "Photo of the tiles", attachmentCount: 1 })).toBe(
      "Photo of the tiles"
    );
  });

  it("classifies by the model's reading only when the owner wrote nothing", () => {
    expect(
      captureKindText({ rawContent: "Photo", attachmentCount: 1, visualDescriptor: DESCRIPTOR })
    ).toBe(DESCRIPTOR);
    expect(
      captureKindText({
        rawContent: "for the pantry",
        attachmentCount: 1,
        visualDescriptor: DESCRIPTOR
      })
    ).toBe("for the pantry");
    expect(captureKindText({ rawContent: "Photo", attachmentCount: 1 })).toBe("");
  });

  it("matches candidates against the owner's words and the photo's reading together", () => {
    // The placeholder alone matches no note in any library, which is why a photo could not
    // reach an existing note before the descriptor became a retrieval input.
    expect(
      captureRetrievalText({
        rawContent: "Photo",
        attachmentCount: 1,
        visualDescriptor: DESCRIPTOR
      })
    ).toBe(DESCRIPTOR);
    expect(
      captureRetrievalText({
        rawContent: "for the pantry",
        attachmentCount: 1,
        visualDescriptor: DESCRIPTOR
      })
    ).toBe(`for the pantry\n${DESCRIPTOR}`);
    expect(captureRetrievalText({ rawContent: "just words", attachmentCount: 0 })).toBe(
      "just words"
    );
  });
});
