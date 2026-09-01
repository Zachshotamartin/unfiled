import { describe, expect, it } from "vitest";

import {
  AllowedReasonCodeSchema,
  MAX_ACTIVE_ROUTING_RULE_DECRYPTED_BYTES,
  MAX_ACTIVE_ROUTING_RULES,
  MAX_RETAINED_ROUTING_RULES,
  MAX_ROUTING_RULE_PAGE_BYTES,
  ROUTING_RULE_PAGE_SIZE,
  RoutingRuleCreateRequestSchema,
  RoutingRuleDestinationStatusSchema,
  RoutingRuleDtoSchema,
  RoutingRuleListResponseSchema,
  RoutingRuleMatchSnapshotSchema,
  RoutingRuleProposalStateSchema,
  RoutingRuleUpdateRequestSchema,
  normalizeRoutingRuleCondition,
  openApiDocument
} from "../src/index.js";

const RULE_ID = "rule_01J6M9Q7G4BMKB33GSG3NJ6D1X";
const NOTE_ID = "note_01J6M9Q7G4BMKB33GSG3NJ6D1X";
const SPACE_ID = "spc_01J6M9Q7G4BMKB33GSG3NJ6D1X";
const NOW = "2026-09-01T18:30:00.000Z";

const explicitRule = {
  id: RULE_ID,
  revision: 1,
  enabled: true,
  ruleType: "phrase",
  condition: "groceries",
  destination: { type: "note", noteId: NOTE_ID },
  priority: 100,
  normalizedCondition: "groceries",
  aliases: [],
  source: "explicit",
  proposalState: null,
  destinationStatus: "active",
  lastFiredAt: null,
  createdAt: NOW,
  updatedAt: NOW
} as const;

describe("E2 routing-rule contracts", () => {
  it("freezes proposal, destination, and capacity vocabularies", () => {
    expect(RoutingRuleProposalStateSchema.unwrap().options).toEqual(["offered", "accepted"]);
    expect(RoutingRuleProposalStateSchema.parse(null)).toBeNull();
    expect(RoutingRuleDestinationStatusSchema.options).toEqual([
      "active",
      "archived",
      "deleted",
      "missing"
    ]);
    expect(MAX_ACTIVE_ROUTING_RULES).toBe(256);
    expect(MAX_RETAINED_ROUTING_RULES).toBe(1_000);
    expect(MAX_ACTIVE_ROUTING_RULE_DECRYPTED_BYTES).toBe(8 * 1024 * 1024);
    expect(ROUTING_RULE_PAGE_SIZE).toBe(50);
    expect(MAX_ROUTING_RULE_PAGE_BYTES).toBe(8 * 1024 * 1024);
  });

  it("keeps explicit rules outside the learned-proposal lifecycle", () => {
    expect(RoutingRuleDtoSchema.parse(explicitRule)).toEqual(explicitRule);
    expect(
      RoutingRuleDtoSchema.safeParse({ ...explicitRule, proposalState: "offered" }).success
    ).toBe(false);
    expect(
      RoutingRuleDtoSchema.safeParse({ ...explicitRule, proposalState: "accepted" }).success
    ).toBe(false);
  });

  it("exposes offered learned rules as disabled and accepted rules as independently enabled", () => {
    const learnedRule = {
      ...explicitRule,
      source: "correction_suggested",
      enabled: false,
      proposalState: "offered"
    } as const;
    expect(RoutingRuleDtoSchema.safeParse(learnedRule).success).toBe(true);
    expect(RoutingRuleDtoSchema.safeParse({ ...learnedRule, enabled: true }).success).toBe(false);
    expect(
      RoutingRuleDtoSchema.safeParse({ ...learnedRule, proposalState: "accepted", enabled: true })
        .success
    ).toBe(true);
    expect(
      RoutingRuleDtoSchema.safeParse({ ...learnedRule, proposalState: "accepted", enabled: false })
        .success
    ).toBe(true);
    expect(RoutingRuleDtoSchema.safeParse({ ...learnedRule, proposalState: null }).success).toBe(
      false
    );
    expect(
      RoutingRuleDtoSchema.safeParse({ ...learnedRule, proposalState: "observing" }).success
    ).toBe(false);
    expect(
      RoutingRuleDtoSchema.safeParse({ ...learnedRule, proposalState: "declined" }).success
    ).toBe(false);
  });

  it("keeps direct creation explicit and treats enabled PATCH as the confirmation action", () => {
    const create = {
      idempotencyKey: "rule-create-01",
      enabled: true,
      ruleType: "prefix",
      condition: "workout",
      destination: { type: "space", spaceId: SPACE_ID },
      priority: 10_000
    } as const;
    expect(RoutingRuleCreateRequestSchema.parse(create)).toEqual(create);
    expect(
      RoutingRuleCreateRequestSchema.safeParse({ ...create, source: "correction_suggested" })
        .success
    ).toBe(false);
    expect(
      RoutingRuleCreateRequestSchema.safeParse({ ...create, proposalState: "offered" }).success
    ).toBe(false);
    expect(
      RoutingRuleUpdateRequestSchema.parse({
        expectedRevision: 1,
        idempotencyKey: "rule-confirm-01",
        enabled: true
      })
    ).toHaveProperty("enabled", true);
    expect(
      RoutingRuleUpdateRequestSchema.safeParse({
        expectedRevision: 1,
        idempotencyKey: "rule-confirm-02",
        enabled: true,
        proposalState: "accepted"
      }).success
    ).toBe(false);
  });

  it("rejects unknown keys and every frozen field bound", () => {
    expect(RoutingRuleDtoSchema.safeParse({ ...explicitRule, secret: "leak" }).success).toBe(false);
    expect(
      RoutingRuleCreateRequestSchema.safeParse({
        idempotencyKey: "rule-bounds-01",
        enabled: true,
        ruleType: "phrase",
        condition: "x".repeat(501),
        destination: { type: "note", noteId: NOTE_ID },
        priority: 100
      }).success
    ).toBe(false);
    expect(
      RoutingRuleDtoSchema.safeParse({
        ...explicitRule,
        aliases: Array.from({ length: 101 }, () => "alias")
      }).success
    ).toBe(false);
    expect(RoutingRuleDtoSchema.safeParse({ ...explicitRule, priority: 10_001 }).success).toBe(
      false
    );
    expect(RoutingRuleDtoSchema.safeParse({ ...explicitRule, revision: 0 }).success).toBe(false);
  });

  it("uses canonical Unicode normalization for request condition bounds", () => {
    const input = {
      idempotencyKey: "rule-canonical-01",
      enabled: true,
      ruleType: "phrase",
      destination: { type: "note", noteId: NOTE_ID },
      priority: 100
    } as const;
    expect(normalizeRoutingRuleCondition("\u0085 ＧＹＭ\u0085plan!!! \u0085")).toBe("gym plan");
    expect(normalizeRoutingRuleCondition("\uFEFFＧＹＭ\uFEFF")).toBe("\uFEFFgym\uFEFF");
    expect(
      RoutingRuleCreateRequestSchema.parse({ ...input, condition: "\u0085gym\u0085" }).condition
    ).toBe("gym");
    expect(RoutingRuleCreateRequestSchema.safeParse({ ...input, condition: "!!!" }).success).toBe(
      false
    );
    expect(
      RoutingRuleCreateRequestSchema.safeParse({ ...input, condition: "! \u0085 ?" }).success
    ).toBe(false);
    expect(
      RoutingRuleCreateRequestSchema.safeParse({ ...input, condition: "\u0085" }).success
    ).toBe(false);
    expect(
      RoutingRuleCreateRequestSchema.safeParse({ ...input, condition: "x".repeat(501) }).success
    ).toBe(false);
    expect(
      RoutingRuleCreateRequestSchema.safeParse({ ...input, condition: "㍿".repeat(126) }).success
    ).toBe(false);
  });

  it("returns fixed cursor-bound pages whose maximum shape stays below eight MiB", () => {
    const items = Array.from({ length: ROUTING_RULE_PAGE_SIZE }, () => ({
      ...explicitRule,
      condition: "\u0800".repeat(500),
      normalizedCondition: "\u0800".repeat(500),
      aliases: Array.from({ length: 100 }, () => "\u0800".repeat(200))
    }));
    const response = {
      items,
      pageInfo: { hasMore: true, nextCursor: RULE_ID }
    };
    expect(RoutingRuleListResponseSchema.safeParse(response).success).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(response)).byteLength).toBeLessThan(
      MAX_ROUTING_RULE_PAGE_BYTES
    );
    expect(
      RoutingRuleListResponseSchema.safeParse({
        items: Array.from({ length: ROUTING_RULE_PAGE_SIZE + 1 }, () => explicitRule),
        pageInfo: { hasMore: false, nextCursor: null }
      }).success
    ).toBe(false);
    expect(
      RoutingRuleListResponseSchema.safeParse({
        items: [explicitRule],
        pageInfo: { hasMore: true, nextCursor: RULE_ID }
      }).success
    ).toBe(false);
  });

  it("binds exact note and space destination IDs into immutable match snapshots", () => {
    const noteSnapshot = {
      ruleId: RULE_ID,
      ruleRevision: 4,
      destinationKind: "note",
      destinationId: NOTE_ID,
      priority: 500,
      matched: true
    } as const;
    expect(RoutingRuleMatchSnapshotSchema.parse(noteSnapshot)).toEqual(noteSnapshot);
    expect(
      RoutingRuleMatchSnapshotSchema.safeParse({
        ...noteSnapshot,
        destinationKind: "space",
        destinationId: SPACE_ID
      }).success
    ).toBe(true);
    expect(
      RoutingRuleMatchSnapshotSchema.safeParse({
        ...noteSnapshot,
        destinationKind: "space"
      }).success
    ).toBe(false);
    expect(
      RoutingRuleMatchSnapshotSchema.safeParse({ ...noteSnapshot, matched: false }).success
    ).toBe(false);
    expect(
      RoutingRuleMatchSnapshotSchema.safeParse({ ...noteSnapshot, condition: "private" }).success
    ).toBe(false);
  });

  it("publishes only the fixed content-free routing reason code", () => {
    expect(AllowedReasonCodeSchema.parse("routing_rule_match")).toBe("routing_rule_match");
    expect(AllowedReasonCodeSchema.safeParse(`routing_rule_match:${RULE_ID}`).success).toBe(false);
  });

  it("documents reachable private errors and explicit routing invariants", () => {
    const operations = [
      openApiDocument.paths["/routing-rules"].get,
      openApiDocument.paths["/routing-rules"].post,
      openApiDocument.paths["/routing-rules/{routingRuleId}"].patch,
      openApiDocument.paths["/routing-rules/{routingRuleId}"].delete
    ];
    for (const operation of operations) {
      for (const status of ["429", "500", "503"] as const) {
        expect(operation.responses[status].headers["Cache-Control"].schema).toEqual({
          type: "string",
          const: "private, no-store"
        });
        expect(operation.responses[status].headers.Pragma.schema).toEqual({
          type: "string",
          const: "no-cache"
        });
      }
    }
    for (const operation of operations.slice(1)) {
      for (const status of ["403", "413"] as const) {
        expect(operation.responses).toHaveProperty(status);
      }
    }
    expect(openApiDocument.paths["/routing-rules"].get.responses).not.toHaveProperty("413");
    expect(openApiDocument.paths["/routing-rules"].get.parameters).toEqual([
      expect.objectContaining({ name: "cursor" })
    ]);
    expect(openApiDocument.components.schemas.RoutingRuleDto).toHaveProperty("allOf");
    expect(openApiDocument.components.schemas.RoutingRuleUpdateRequest).toHaveProperty("anyOf");
    expect(openApiDocument.components.schemas).toHaveProperty("RoutingRuleMatchSnapshot");
  });
});
