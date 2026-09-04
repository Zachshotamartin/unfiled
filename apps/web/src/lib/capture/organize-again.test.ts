import type { CaptureCreateRequest, CaptureDeleteRequest, EntityId } from "@unfiled/contracts";
import { describe, expect, it, vi } from "vitest";

import { normalizedGuidance, organizeCaptureAgain, type OrganizeAgainApi } from "./organize-again";

const SOURCE = {
  id: "cap_01J6M9Q7G4BMKB33GSG3NJ6D1A" as EntityId<"cap">,
  rawContent: "add bananas",
  expansionDisabled: false
};

function api(
  create: (input: CaptureCreateRequest) => Promise<unknown> = () => Promise.resolve({})
): OrganizeAgainApi & {
  createCapture: ReturnType<typeof vi.fn<(input: CaptureCreateRequest) => Promise<unknown>>>;
  deleteCapture: ReturnType<
    typeof vi.fn<(captureId: string, input: CaptureDeleteRequest) => Promise<unknown>>
  >;
} {
  return {
    createCapture: vi.fn<(input: CaptureCreateRequest) => Promise<unknown>>(create),
    deleteCapture: vi.fn<(captureId: string, input: CaptureDeleteRequest) => Promise<unknown>>(() =>
      Promise.resolve({})
    )
  };
}

describe("organizing a capture again", () => {
  it("makes a new capture with the same words and the directions, then removes the old one", async () => {
    const calls: string[] = [];
    const fake = api(() => {
      calls.push("create");
      return Promise.resolve({});
    });
    fake.deleteCapture.mockImplementation(() => {
      calls.push("delete");
      return Promise.resolve({});
    });

    const id = await organizeCaptureAgain(fake, SOURCE, "  put it in Groceries  ", 0, "UTC");

    expect(id).toMatch(/^cap_/u);
    expect(calls).toEqual(["create", "delete"]);
    const request = fake.createCapture.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      rawContent: "add bananas",
      guidance: "put it in Groceries",
      source: "web",
      clientTimezone: "UTC",
      privacy: "ai_assisted",
      expansionDisabled: false
    });
    const deletion = fake.deleteCapture.mock.calls[0];
    expect(deletion?.[0]).toBe(SOURCE.id);
    expect(deletion?.[1].idempotencyKey.length).toBeGreaterThan(0);
  });

  it("leaves the original in place when the new capture cannot be made", async () => {
    const fake = api(() => Promise.reject(new Error("offline")));
    await expect(organizeCaptureAgain(fake, SOURCE, null, 0, "UTC")).rejects.toThrow("offline");
    expect(fake.deleteCapture).not.toHaveBeenCalled();
  });

  it("sends no directions rather than empty ones", async () => {
    const fake = api();
    await organizeCaptureAgain(fake, SOURCE, "   ", 0, "UTC");
    expect(fake.createCapture.mock.calls[0]?.[0]).not.toHaveProperty("guidance");
    expect(normalizedGuidance(null)).toBeNull();
    expect(normalizedGuidance(" x ")).toBe("x");
  });
});
