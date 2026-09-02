import type { GeneratedBlockDto } from "@unfiled/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  GeneratedBlockCard,
  generatedResolutionAttempt,
  visibleGeneratedBlocks
} from "./generated-blocks-surface";

const proposed: GeneratedBlockDto = Object.freeze({
  id: "blk_01J6M9Q7G4BMKB33GSG3NJ6D1X",
  noteId: "note_01J6M9Q7G4BMKB33GSG3NJ6D1X",
  decisionId: "dec_01J6M9Q7G4BMKB33GSG3NJ6D1X",
  kind: "suggestion",
  content: "Try grouping these entries by week.",
  state: "proposed",
  stateRevision: 1,
  modelId: "gpt-5.6-terra",
  promptVersion: "routing-v1",
  createdAt: "2026-09-01T18:00:00.000Z",
  resolvedAt: null
});

describe("generated block presentation", () => {
  it("labels proposed prose as AI-generated and keeps decisions in a separate action group", () => {
    const html = renderToStaticMarkup(
      <GeneratedBlockCard block={proposed} pending={null} onResolve={vi.fn()} />
    );

    expect(html).toContain('aria-label="AI-generated suggestion"');
    expect(html).toContain("AI-generated");
    expect(html).toContain("Proposed");
    expect(html).toContain("Try grouping these entries by week.");
    expect(html).toContain('aria-label="Generated content decision"');
    expect(html).toContain(">Accept<");
    expect(html).toContain(">Reject<");
    expect(html).not.toContain("textarea");
  });

  it("keeps accepted prose visible and read-only while rejected prose is hidden", () => {
    const accepted: GeneratedBlockDto = {
      ...proposed,
      state: "accepted",
      stateRevision: 2,
      resolvedAt: "2026-09-01T18:01:00.000Z"
    };
    const rejected: GeneratedBlockDto = {
      ...proposed,
      id: "blk_01J6M9Q7G4BMKB33GSG3NJ6D1Y",
      state: "rejected",
      stateRevision: 2,
      resolvedAt: "2026-09-01T18:02:00.000Z"
    };
    const html = renderToStaticMarkup(
      <GeneratedBlockCard block={accepted} pending={null} onResolve={vi.fn()} />
    );

    expect(html).toContain("Accepted as a separate, read-only block");
    expect(html).not.toContain(">Reject<");
    expect(visibleGeneratedBlocks([proposed, accepted, rejected])).toEqual([proposed, accepted]);
  });

  it("announces an in-flight decision without leaving the competing action enabled", () => {
    const html = renderToStaticMarkup(
      <GeneratedBlockCard block={proposed} pending="accept" onResolve={vi.fn()} />
    );

    expect(html).toContain("Accepting…");
    expect(html.match(/disabled=""/gu)).toHaveLength(2);
  });

  it("reuses the exact request after ambiguity and rotates it only when intent changes", () => {
    const first = generatedResolutionAttempt(null, proposed, "accept", () => "web_first");
    const replay = generatedResolutionAttempt(first, proposed, "accept", () => "web_unused");
    const changed = generatedResolutionAttempt(first, proposed, "reject", () => "web_second");

    expect(replay).toBe(first);
    expect(changed).toEqual({
      expectedStateRevision: 1,
      idempotencyKey: "web_second",
      resolution: "reject"
    });
  });
});
