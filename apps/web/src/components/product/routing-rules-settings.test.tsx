import type { NoteSummary, RoutingRuleDto, Space } from "@unfiled/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  RoutingRuleEditor,
  RoutingRuleItem,
  RoutingRulePreview,
  RoutingRulePreviewResult
} from "./routing-rules-settings";

const note: NoteSummary = {
  id: "note_01J6M9Q7G4BMKB33GSG3NJ6D1X",
  spaceId: null,
  type: "generic",
  title: "Training log",
  currentRevision: 2,
  isOpen: true,
  pinnedAt: null,
  privacy: "ai_assisted",
  archivedAt: null,
  deletedAt: null,
  updatedAt: "2026-09-01T12:00:00.000Z"
};

const space: Space = {
  id: "spc_01J6M9Q7G4BMKB33GSG3NJ6D1X",
  parentId: null,
  name: "Health",
  slug: "health",
  sortKey: "a",
  currentRevision: 1,
  archivedAt: null,
  createdAt: "2026-09-01T12:00:00.000Z",
  updatedAt: "2026-09-01T12:00:00.000Z"
};

const rule: RoutingRuleDto = {
  id: "rule_01J6M9Q7G4BMKB33GSG3NJ6D1X",
  revision: 3,
  enabled: true,
  ruleType: "prefix",
  condition: "gym:",
  normalizedCondition: "gym",
  aliases: [],
  destination: { type: "note", noteId: note.id },
  destinationStatus: "active",
  priority: 200,
  source: "explicit",
  proposalState: null,
  lastFiredAt: null,
  createdAt: "2026-09-01T12:00:00.000Z",
  updatedAt: "2026-09-01T12:00:00.000Z"
};

const editorProps = {
  destinationError: null,
  notes: [note],
  notesHasMore: false,
  notesLoading: false,
  notesLoadingMore: false,
  onCancel: vi.fn(),
  onLoadMoreNotes: vi.fn(),
  onLoadMoreSpaces: vi.fn(),
  onSave: vi.fn(() => Promise.resolve()),
  pending: false,
  spaces: [space],
  spacesHasMore: false,
  spacesLoading: false,
  spacesLoadingMore: false
} as const;

const rowProps = {
  confirmingRemoval: false,
  destination: "Training log",
  onAccept: vi.fn(),
  onCancelRemoval: vi.fn(),
  onEdit: vi.fn(),
  onRemove: vi.fn(),
  onRequestRemoval: vi.fn(),
  onToggle: vi.fn(),
  pending: false
} as const;

describe("RoutingRuleEditor", () => {
  it("does not offer private, closed, archived, or deleted notes", () => {
    const ineligible = [
      {
        ...note,
        id: `${note.id.slice(0, -1)}A` as typeof note.id,
        title: "Private",
        privacy: "private_manual" as const
      },
      { ...note, id: `${note.id.slice(0, -1)}B` as typeof note.id, title: "Closed", isOpen: false },
      {
        ...note,
        id: `${note.id.slice(0, -1)}C` as typeof note.id,
        title: "Archived",
        archivedAt: "2026-09-01T12:00:00.000Z"
      },
      {
        ...note,
        id: `${note.id.slice(0, -1)}D` as typeof note.id,
        title: "Deleted",
        deletedAt: "2026-09-01T12:00:00.000Z"
      }
    ];
    const html = renderToStaticMarkup(
      <RoutingRuleEditor {...editorProps} rule={null} notes={[note, ...ineligible]} />
    );

    expect(html).toContain("Training log");
    expect(html).not.toContain(">Private<");
    expect(html).not.toContain(">Closed<");
    expect(html).not.toContain(">Archived<");
    expect(html).not.toContain(">Deleted<");
  });

  it("keeps visible labels and guidance with actions in a separate footer", () => {
    const html = renderToStaticMarkup(<RoutingRuleEditor {...editorProps} rule={null} />);

    expect(html).toContain("Matching text");
    expect(html).toContain("Match type");
    expect(html).toContain("Active destination");
    expect(html).toContain("Higher numbers run first. The default is 100.");
    expect(html).toContain('class="routing-rule-form-actions"');
    expect(html).toContain("Create rule");

    const condition = html.indexOf('id="new-routing-rule-condition"');
    const actions = html.indexOf('class="routing-rule-form-actions"');
    expect(condition).toBeGreaterThan(-1);
    expect(actions).toBeGreaterThan(condition);
    expect(html.slice(condition, actions)).not.toContain('type="submit"');
  });

  it("requires a valid replacement when editing a blocked rule", () => {
    const blocked = { ...rule, destinationStatus: "archived" as const };
    const html = renderToStaticMarkup(<RoutingRuleEditor {...editorProps} rule={blocked} />);

    expect(html).toContain("This destination is archived.");
    expect(html).toContain('value="" selected=""');
    expect(html).toMatch(/<button[^>]+type="submit"[^>]+disabled=""[^>]*>/u);
  });
});

describe("RoutingRuleItem", () => {
  it("shows source and last-fired metadata for every explicit rule", () => {
    const html = renderToStaticMarkup(
      <RoutingRuleItem {...rowProps} rule={rule} destination="Training log" />
    );

    expect(html).toContain("Explicit");
    expect(html).toContain("Never fired");
  });

  it("keeps pause and delete available while blocking re-enable for an invalid destination", () => {
    const blocked = { ...rule, enabled: false, destinationStatus: "deleted" as const };
    const html = renderToStaticMarkup(
      <RoutingRuleItem {...rowProps} rule={blocked} destination="Deleted note" />
    );

    expect(html).toContain("Blocked");
    expect(html).toContain("Edit");
    expect(html).toContain("Delete");
    expect(html).toMatch(/<button[^>]+class="routing-rule-toggle"[^>]+disabled=""[^>]*>/u);
  });

  it("shows explicit accept and decline controls for a learned offer", () => {
    const offered: RoutingRuleDto = {
      ...rule,
      enabled: false,
      source: "correction_suggested",
      proposalState: "offered",
      lastFiredAt: "2026-09-01T12:00:00.000Z"
    };
    const html = renderToStaticMarkup(<RoutingRuleItem {...rowProps} rule={offered} />);

    expect(html).toContain("Suggested after repeated corrections.");
    expect(html).toContain("Accept and turn on");
    expect(html).toContain("Decline");
    expect(html).toContain("Learned");
    expect(html).toContain("Last fired");
    expect(html).not.toContain(">Edit<");
  });

  it("uses a second confirmation step before delete", () => {
    const html = renderToStaticMarkup(
      <RoutingRuleItem {...rowProps} rule={rule} confirmingRemoval />
    );

    expect(html).toContain('aria-label="Confirm rule removal"');
    expect(html).toContain("Delete this rule?");
    expect(html).toContain("Delete rule");
    expect(html).toContain("Cancel");
  });
});

describe("RoutingRulePreview", () => {
  it("keeps the bounded local sample field separate from preview actions", () => {
    const html = renderToStaticMarkup(
      <RoutingRulePreview rules={[rule]} notes={[note]} spaces={[space]} />
    );

    expect(html).toContain("Local condition check");
    expect(html).toContain("Preview which rule matches");
    expect(html).toContain("On this device only");
    expect(html).toContain("Sample capture");
    expect(html).toContain("never sent, saved, or logged");
    expect(html).toContain("0/500");
    expect(html).toContain("Check rule match");
    expect(html).toContain("Ready for a sample");
    expect(html).not.toContain("Preview where a jot would go");
    expect(html).not.toContain("Preview route");

    const sample = html.indexOf('id="routing-rule-preview-sample"');
    const actions = html.indexOf('class="routing-rule-preview-actions"');
    expect(sample).toBeGreaterThan(-1);
    expect(actions).toBeGreaterThan(sample);
    expect(html.slice(sample, actions)).not.toContain("<button");
  });

  it("reports a local condition match without promising routing or destination eligibility", () => {
    const html = renderToStaticMarkup(
      <RoutingRulePreviewResult hasPreviewed matchedRule={rule} notes={[note]} spaces={[space]} />
    );

    expect(html).toContain("Rule condition matched locally");
    expect(html).toContain("gym:");
    expect(html).toContain("Configured destination: note");
    expect(html).toContain("Training log");
    expect(html).toContain("does not confirm actual routing or destination eligibility");
    expect(html).not.toContain("Winning rule");
    expect(html).not.toContain("Would route to");
  });

  it("does not predict general organization when no local condition matches", () => {
    const html = renderToStaticMarkup(
      <RoutingRulePreviewResult hasPreviewed matchedRule={null} notes={[note]} spaces={[space]} />
    );

    expect(html).toContain("No rule condition matched");
    expect(html).toContain("does not predict how the jot will be organized");
    expect(html).not.toContain("would use general organization");
  });
});
