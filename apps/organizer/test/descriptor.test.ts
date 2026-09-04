import { describe, expect, it, vi } from "vitest";

import { createAnthropicOrganizerPlanner } from "../src/anthropic-planner.js";
import {
  MAX_CAPTURE_DESCRIPTOR_CHARACTERS,
  ORGANIZER_DESCRIPTOR_CONTRACT,
  ORGANIZER_DESCRIPTOR_PROMPT,
  ORGANIZER_DESCRIPTOR_SCHEMA_NAME,
  parseCaptureDescriptor
} from "../src/descriptor.js";
import { OrganizerPlannerReviewError } from "../src/errors.js";
import { createOpenAIOrganizerPlanner } from "../src/openai-planner.js";
import type { CaptureDescriptorInput, DecryptedCapture } from "../src/planner.js";

const API_KEY = "a".repeat(32);
const DESCRIPTOR = "A handwritten shopping list on a yellow notepad";
const controls = Object.freeze({
  expansionDisabled: false,
  explicitDestinationNoteId: null,
  ruleMatch: null
});
const photo = Object.freeze({
  attachmentId: "att_01ARZ3NDEKTSV4RRFFQ69G5FAZ" as const,
  kind: "image" as const,
  mediaType: "image/jpeg" as const,
  dataBase64: "/9j/AAAA",
  byteLength: 6,
  width: 4,
  height: 3,
  durationMs: null
});

function capture(overrides: Partial<DecryptedCapture> = {}): DecryptedCapture {
  return Object.freeze({ attachments: [photo], controls, rawContent: "Photo", ...overrides });
}

function descriptorInput(overrides: Partial<CaptureDescriptorInput> = {}): CaptureDescriptorInput {
  return {
    capture: capture(),
    captureId: "cap_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    promptVersion: "routing-v1",
    schemaVersion: 1,
    signal: new AbortController().signal,
    ...overrides
  };
}

function openAIResponse(value: unknown): Response {
  return Response.json({
    error: null,
    id: "resp_test",
    incomplete_details: null,
    output: [
      {
        content: [{ text: JSON.stringify(value), type: "output_text" }],
        role: "assistant",
        status: "completed",
        type: "message"
      }
    ],
    status: "completed"
  });
}

function anthropicResponse(value: unknown): Response {
  return Response.json({
    content: [
      { id: "toolu_test", input: value, name: ORGANIZER_DESCRIPTOR_SCHEMA_NAME, type: "tool_use" }
    ],
    role: "assistant",
    stop_reason: "tool_use",
    type: "message"
  });
}

function requestBody(call: readonly unknown[] | undefined): Readonly<Record<string, unknown>> {
  const init = call?.[1] as RequestInit | undefined;
  if (typeof init?.body !== "string") throw new Error("Expected a JSON request body.");
  return JSON.parse(init.body) as Readonly<Record<string, unknown>>;
}

describe("capture descriptor pass", () => {
  it("bounds the description and refuses anything that is not one", () => {
    expect(parseCaptureDescriptor({ descriptor: "  A  tidy   sentence\n" })).toBe(
      "A tidy sentence"
    );
    for (const value of [
      null,
      {},
      { descriptor: 12 },
      { descriptor: "   " },
      { descriptor: "x".repeat(MAX_CAPTURE_DESCRIPTOR_CHARACTERS + 1) }
    ]) {
      expect(() => parseCaptureDescriptor(value)).toThrow(OrganizerPlannerReviewError);
    }
  });

  it("sends OpenAI the photos, the descriptor prompt, and no candidates", async () => {
    const fetchImplementation = vi
      .fn()
      .mockResolvedValue(openAIResponse({ descriptor: DESCRIPTOR }));
    const planner = createOpenAIOrganizerPlanner({ apiKey: API_KEY, fetchImplementation });

    await expect(planner.describe(descriptorInput())).resolves.toBe(DESCRIPTOR);

    const body = requestBody(vi.mocked(fetchImplementation).mock.calls[0]);
    expect(body.instructions).toBe(ORGANIZER_DESCRIPTOR_PROMPT);
    const content = (body.input as readonly Readonly<{ content: readonly unknown[] }>[])[0]
      ?.content;
    const serialized = (content?.[0] as Readonly<{ text: string }>).text;
    // The descriptor pass sees the photos and the owner's own text, and nothing of the library:
    // a description shaped by the notes it will be matched against is not a description.
    expect(JSON.parse(serialized)).toEqual({
      capture: { attachments: { images: [{ height: 3, width: 4 }], recordings: 0 }, text: "Photo" },
      contract: ORGANIZER_DESCRIPTOR_CONTRACT
    });
    expect(content?.[1]).toMatchObject({ type: "input_image" });
    expect(serialized).not.toContain(photo.attachmentId);
  });

  it("sends Claude the descriptor tool rather than the organization tool", async () => {
    const fetchImplementation = vi
      .fn()
      .mockResolvedValue(anthropicResponse({ descriptor: DESCRIPTOR }));
    const planner = createAnthropicOrganizerPlanner({ apiKey: API_KEY, fetchImplementation });

    await expect(planner.describe(descriptorInput())).resolves.toBe(DESCRIPTOR);

    const body = requestBody(vi.mocked(fetchImplementation).mock.calls[0]);
    expect(body.system).toBe(ORGANIZER_DESCRIPTOR_PROMPT);
    expect(body.tool_choice).toMatchObject({ name: ORGANIZER_DESCRIPTOR_SCHEMA_NAME });
    expect((body.tools as readonly Readonly<{ name: string }>[])[0]?.name).toBe(
      ORGANIZER_DESCRIPTOR_SCHEMA_NAME
    );
  });

  it("refuses to describe a capture that carries no photos", async () => {
    const fetchImplementation = vi.fn().mockRejectedValue(new Error("must not reach a provider"));
    const planner = createOpenAIOrganizerPlanner({ apiKey: API_KEY, fetchImplementation });

    await expect(
      planner.describe(descriptorInput({ capture: capture({ attachments: [] }) }))
    ).rejects.toBeInstanceOf(OrganizerPlannerReviewError);
    expect(fetchImplementation).not.toHaveBeenCalled();
  });
});
