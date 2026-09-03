import { describe, expect, it } from "vitest";

import { CapturePayloadSchema, OwnerGuidanceSchema } from "../src/payloads.js";

// The owner's directions ride inside the sealed capture payload, under the capture's own key and
// MAC, so they are as private as the text and never leave the owner's aggregate in the clear.
describe("capture payload owner guidance", () => {
  it("accepts a payload without guidance exactly as before", () => {
    const payload = { schemaVersion: 1 as const, rawContent: "milk" };
    expect(CapturePayloadSchema.parse(payload)).toEqual(payload);
  });

  it("keeps guidance alongside the capture text", () => {
    const payload = {
      schemaVersion: 1 as const,
      rawContent: "milk, eggs",
      guidance: "put this with the groceries list and keep it as a checklist"
    };
    expect(CapturePayloadSchema.parse(payload)).toEqual(payload);
  });

  it("rejects blank or oversized guidance", () => {
    expect(OwnerGuidanceSchema.safeParse("   ").success).toBe(false);
    expect(OwnerGuidanceSchema.safeParse("x".repeat(501)).success).toBe(false);
    expect(
      CapturePayloadSchema.safeParse({ schemaVersion: 1, rawContent: "milk", guidance: "" }).success
    ).toBe(false);
  });

  it("rejects unknown fields so guidance cannot masquerade as content", () => {
    expect(
      CapturePayloadSchema.safeParse({ schemaVersion: 1, rawContent: "milk", instructions: "x" })
        .success
    ).toBe(false);
  });
});
