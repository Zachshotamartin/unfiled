import {
  createEntityId,
  MAX_RETAINED_ROUTING_RULES,
  ROUTING_RULE_PAGE_SIZE,
  type EntityId
} from "@unfiled/contracts";
import { MAX_ACTIVE_ROUTING_RULES, RoutingRuleCapacityError } from "@unfiled/ai-routing";
import {
  authorizeAggregateOwner,
  type EncryptedAggregateRecord,
  type EncryptedAggregateService,
  type RoutingRulePayload
} from "@unfiled/encrypted-aggregate";
import { describe, expect, it, vi } from "vitest";

import type {
  EncryptedLibraryObject,
  EncryptedLibraryRpcStore
} from "@/server/encryption/encrypted-library-rpc-store";

import { EncryptedRoutingRuleReader } from "./encrypted-routing-rule-reader";

const OWNER = "11111111-1111-4111-8111-111111111111";
const NOTE = "note_01J6M9Q7G4BMKB33GSG3NJ6D1X" as const;
const SPACE = "spc_01J6M9Q7G4BMKB33GSG3NJ6D1X" as const;
const NOW = "2026-09-01T18:00:00.000Z";
const access = authorizeAggregateOwner({ authenticatedOwnerId: OWNER, resourceOwnerId: OWNER });

type Row = EncryptedLibraryObject<"routing_rule">;

function ruleRow(id: EntityId<"rule">, overrides: Partial<Row["operational"]> = {}): Row {
  const operational: Row["operational"] = {
    currentRevision: 1,
    enabled: true,
    ruleType: "prefix",
    destinationNoteId: NOTE,
    destinationSpaceId: null,
    priority: 100,
    source: "explicit",
    proposalState: null,
    destinationStatus: "active",
    lastFiredAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  };
  return {
    surface: "routing_rule",
    ownerId: OWNER,
    resourceId: id,
    recordVersion: 1,
    operational,
    encrypted: { resourceId: id } as unknown as EncryptedAggregateRecord<"routing_rule">,
    contentMac: null
  };
}

function setup(rows: readonly Row[], payloads: ReadonlyMap<string, RoutingRulePayload>) {
  const listEncryptedLibraryObjects = vi.fn(() =>
    Promise.resolve({ surface: "routing_rule" as const, items: rows, nextCursor: null })
  );
  const openRoutingRule = vi.fn(
    (_access: unknown, _record: unknown, expected: { ruleId: EntityId<"rule"> }) => {
      const value = payloads.get(expected.ruleId);
      if (value === undefined) return Promise.reject(new Error("missing_fixture"));
      return Promise.resolve(value);
    }
  );
  const reader = new EncryptedRoutingRuleReader({
    ownerId: OWNER,
    access,
    aggregate: { openRoutingRule } as unknown as EncryptedAggregateService,
    store: { listEncryptedLibraryObjects } as unknown as EncryptedLibraryRpcStore
  });
  return { reader, listEncryptedLibraryObjects, openRoutingRule };
}

function payload(condition: string): RoutingRulePayload {
  return { schemaVersion: 1, condition, normalizedCondition: condition, aliases: [] };
}

describe("encrypted routing-rule reader", () => {
  it("preserves non-White_Space FEFF code points through the encrypted list boundary", async () => {
    const explicit = createEntityId("rule");
    const condition = "\uFEFFfocus\uFEFF";
    const aliases = ["\uFEFFdeep work\uFEFF"];
    const { reader } = setup(
      [ruleRow(explicit)],
      new Map([
        [explicit, { schemaVersion: 1, condition, normalizedCondition: condition, aliases }]
      ])
    );

    await expect(reader.list()).resolves.toMatchObject({
      items: [{ id: explicit, condition, normalizedCondition: condition, aliases }]
    });
  });

  it("hides observing and declined proposals while opening owner-visible encrypted rules", async () => {
    const explicit = createEntityId("rule");
    const offered = createEntityId("rule");
    const observing = createEntityId("rule");
    const declined = createEntityId("rule");
    const rows = [
      ruleRow(explicit),
      ruleRow(offered, {
        enabled: false,
        source: "correction_suggested",
        proposalState: "offered",
        destinationNoteId: null,
        destinationSpaceId: SPACE
      }),
      ruleRow(observing, {
        enabled: false,
        source: "correction_suggested",
        proposalState: "observing"
      }),
      ruleRow(declined, {
        enabled: false,
        source: "correction_suggested",
        proposalState: "declined"
      })
    ];
    const { reader, openRoutingRule } = setup(
      rows,
      new Map([
        [explicit, payload("shop")],
        [offered, payload("gym")],
        [observing, payload("hidden")],
        [declined, payload("suppressed")]
      ])
    );

    await expect(reader.list()).resolves.toMatchObject({
      items: [
        { id: explicit, source: "explicit", proposalState: null },
        { id: offered, source: "correction_suggested", proposalState: "offered" }
      ],
      pageInfo: { hasMore: false, nextCursor: null }
    });
    expect(openRoutingRule).toHaveBeenCalledTimes(2);
  });

  it("bounds the retained rows scanned even when every rule is owner-hidden", async () => {
    const rows = Array.from({ length: MAX_RETAINED_ROUTING_RULES + 1 }, () =>
      ruleRow(createEntityId("rule"), {
        enabled: false,
        source: "correction_suggested",
        proposalState: "observing"
      })
    );
    const pages = Array.from(
      { length: Math.ceil(rows.length / ROUTING_RULE_PAGE_SIZE) },
      (_, index) => rows.slice(index * ROUTING_RULE_PAGE_SIZE, (index + 1) * ROUTING_RULE_PAGE_SIZE)
    );
    let pageIndex = 0;
    const listEncryptedLibraryObjects = vi.fn(() => {
      const items = pages[pageIndex] ?? [];
      pageIndex += 1;
      return Promise.resolve({
        surface: "routing_rule" as const,
        items,
        nextCursor: pageIndex < pages.length ? (items.at(-1)?.resourceId ?? null) : null
      });
    });
    const openRoutingRule = vi.fn();
    const reader = new EncryptedRoutingRuleReader({
      ownerId: OWNER,
      access,
      aggregate: { openRoutingRule } as unknown as EncryptedAggregateService,
      store: { listEncryptedLibraryObjects } as unknown as EncryptedLibraryRpcStore
    });

    await expect(reader.list()).rejects.toMatchObject({
      name: "RoutingRuleCapacityError",
      code: "retained_rule_limit_exceeded",
      limit: MAX_RETAINED_ROUTING_RULES,
      actual: MAX_RETAINED_ROUTING_RULES + 1
    });
    expect(listEncryptedLibraryObjects).toHaveBeenCalledTimes(pages.length);
    expect(openRoutingRule).not.toHaveBeenCalled();
  });

  it("decrypts only eligible active rules and returns deterministic highest-priority match", async () => {
    const lower = createEntityId("rule");
    const higher = createEntityId("rule");
    const disabled = createEntityId("rule");
    const rows = [
      ruleRow(lower, { priority: 100 }),
      ruleRow(higher, { priority: 900 }),
      ruleRow(disabled, { enabled: false, priority: 1000 })
    ];
    const { reader, openRoutingRule } = setup(
      rows,
      new Map([
        [lower, payload("shop")],
        [higher, payload("shop")],
        [disabled, payload("shop")]
      ])
    );

    await expect(reader.match("SHOP: eggs")).resolves.toEqual({
      ruleId: higher,
      ruleRevision: 1,
      destinationKind: "note",
      destinationId: NOTE,
      priority: 900,
      matched: true
    });
    expect(openRoutingRule).toHaveBeenCalledTimes(2);
  });

  it("fails before decrypting when the active-rule cap is exceeded", async () => {
    const rows = Array.from({ length: MAX_ACTIVE_ROUTING_RULES + 1 }, () =>
      ruleRow(createEntityId("rule"))
    );
    const payloads = new Map(rows.map(({ resourceId }) => [resourceId, payload("shop")]));
    const { reader, openRoutingRule } = setup(rows, payloads);

    await expect(reader.match("shop: eggs")).rejects.toBeInstanceOf(RoutingRuleCapacityError);
    expect(openRoutingRule).not.toHaveBeenCalled();
  });

  it("finds a hidden learned proposal only after its encrypted condition matches exactly", async () => {
    const unrelated = createEntityId("rule");
    const observing = createEntityId("rule");
    const rows = [
      ruleRow(unrelated, {
        enabled: false,
        ruleType: "phrase",
        source: "correction_suggested",
        proposalState: "observing",
        destinationNoteId: null,
        destinationSpaceId: SPACE
      }),
      ruleRow(observing, {
        enabled: false,
        ruleType: "phrase",
        source: "correction_suggested",
        proposalState: "observing"
      })
    ];
    const { reader, openRoutingRule } = setup(
      rows,
      new Map([
        [unrelated, payload("morning workout")],
        [observing, payload("morning workout")]
      ])
    );

    await expect(
      reader.findLearnedProposal({
        ruleType: "phrase",
        normalizedCondition: "morning workout",
        destination: { type: "note", noteId: NOTE }
      })
    ).resolves.toMatchObject({ row: { resourceId: observing } });
    expect(openRoutingRule).toHaveBeenCalledTimes(1);
  });
});
