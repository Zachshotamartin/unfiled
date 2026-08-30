import {
  CaptureCreateRequestSchema,
  CaptureCreateResponseSchema,
  captureV1Fixture,
  captureV1ResponseFixture
} from "@unfiled/contracts";
import { describe, expect, it } from "vitest";

describe("web shared API fixture", () => {
  it("accepts the same version-one capture contract as the API", () => {
    expect(CaptureCreateRequestSchema.parse(captureV1Fixture)).toEqual(captureV1Fixture);
    expect(CaptureCreateResponseSchema.parse(captureV1ResponseFixture)).toEqual(
      captureV1ResponseFixture
    );
  });
});
