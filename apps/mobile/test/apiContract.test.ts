import {
  CaptureCreateRequestSchema,
  CaptureCreateResponseSchema,
  captureV1Fixture,
  captureV1ResponseFixture
} from "@unfiled/contracts";
import { describe, expect, it } from "vitest";

describe("mobile shared API fixture", () => {
  it("accepts the same version-one widget capture contract as the API", () => {
    expect(captureV1Fixture.source).toBe("ios_lock_screen_widget");
    expect(CaptureCreateRequestSchema.parse(captureV1Fixture)).toEqual(captureV1Fixture);
    expect(CaptureCreateResponseSchema.parse(captureV1ResponseFixture)).toEqual(
      captureV1ResponseFixture
    );
  });
});
