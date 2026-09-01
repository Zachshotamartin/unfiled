import type { RoutingRuleDto } from "@unfiled/contracts";
import { describe, expect, it, vi } from "vitest";

import type { AuthenticatedRequest } from "@/server/auth/session";
import type {
  RoutingRuleRepository,
  RoutingRuleRepositoryContext
} from "@/server/routing-rules/repository";

import { createRoutingRuleHandlers } from "./routing-rule-handlers";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const RULE = "rule_01J6M9Q7G4BMKB33GSG3NJ6D1X" as const;
const NOTE = "note_01J6M9Q7G4BMKB33GSG3NJ6D1X" as const;
const NOW = "2026-09-01T18:30:00.000Z";

const rule: RoutingRuleDto = {
  id: RULE,
  revision: 1,
  enabled: true,
  ruleType: "prefix",
  condition: "shop",
  normalizedCondition: "shop",
  aliases: [],
  destination: { type: "note", noteId: NOTE },
  destinationStatus: "active",
  priority: 900,
  source: "explicit",
  proposalState: null,
  lastFiredAt: null,
  createdAt: NOW,
  updatedAt: NOW
};

function authenticated(): Promise<AuthenticatedRequest> {
  return Promise.resolve({
    accessToken: "test-access-token",
    cookies: ["refreshed=true; HttpOnly"],
    user: { id: USER_ID, email: "person@example.com" }
  });
}

function repository() {
  const spies = {
    list: vi.fn(() =>
      Promise.resolve({ items: [rule], pageInfo: { hasMore: false, nextCursor: null } })
    ),
    create: vi.fn(() => Promise.resolve({ rule, replayed: false })),
    update: vi.fn(() => Promise.resolve({ rule: { ...rule, revision: 2 }, replayed: false })),
    delete: vi.fn(() => Promise.resolve({ ruleId: RULE, deleted: true as const, replayed: false }))
  };
  return Object.freeze({
    value: spies satisfies RoutingRuleRepository,
    spies
  });
}

function request(method: string, body?: Readonly<Record<string, unknown>>): Request {
  return new Request("https://unfiled.test/api/v1/routing-rules", {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(typeof body?.idempotencyKey === "string"
        ? { "idempotency-key": body.idempotencyKey }
        : {})
    }
  });
}

function expectPrivate(response: Response): void {
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("pragma")).toBe("no-cache");
}

describe("routing-rule route handlers", () => {
  it("lists and creates rules through an authenticated owner-only repository", async () => {
    const rules = repository();
    const handlers = createRoutingRuleHandlers({
      authenticate: authenticated,
      repository: rules.value
    });
    const listed = await handlers.list(request("GET"));
    const createInput = {
      idempotencyKey: "create-rule-1",
      enabled: true,
      ruleType: "prefix",
      condition: "shop",
      destination: { type: "note", noteId: NOTE },
      priority: 900
    };
    const created = await handlers.create(request("POST", createInput));

    expect(listed.status).toBe(200);
    expect(created.status).toBe(201);
    expect(rules.spies.list).toHaveBeenCalledWith(
      {
        accessToken: "test-access-token",
        userId: USER_ID
      } satisfies RoutingRuleRepositoryContext,
      {}
    );
    expect(rules.spies.create).toHaveBeenCalledWith(
      { accessToken: "test-access-token", userId: USER_ID },
      createInput
    );
    expect(created.headers.get("set-cookie")).toContain("refreshed=true");
    expectPrivate(listed);
    expectPrivate(created);
  });

  it("accepts one rule cursor and fails closed on malformed or repeated cursor input", async () => {
    const rules = repository();
    const handlers = createRoutingRuleHandlers({
      authenticate: authenticated,
      repository: rules.value
    });
    const valid = await handlers.list(
      new Request(`https://unfiled.test/api/v1/routing-rules?cursor=${RULE}`)
    );
    const malformed = await handlers.list(
      new Request("https://unfiled.test/api/v1/routing-rules?cursor=bad")
    );
    const repeated = await handlers.list(
      new Request(`https://unfiled.test/api/v1/routing-rules?cursor=${RULE}&cursor=${RULE}`)
    );

    expect(valid.status).toBe(200);
    expect(rules.spies.list).toHaveBeenCalledWith(expect.anything(), { cursor: RULE });
    expect(malformed.status).toBe(400);
    expect(repeated.status).toBe(400);
    expectPrivate(malformed);
    expectPrivate(repeated);
  });

  it("updates and deletes with revision and idempotency validation", async () => {
    const rules = repository();
    const handlers = createRoutingRuleHandlers({
      authenticate: authenticated,
      repository: rules.value
    });
    const updateInput = {
      expectedRevision: 1,
      idempotencyKey: "update-rule-1",
      enabled: false
    };
    const deleteInput = { expectedRevision: 2, idempotencyKey: "delete-rule-1" };
    const updated = await handlers.update(request("PATCH", updateInput), { ruleId: RULE });
    const deleted = await handlers.delete(request("DELETE", deleteInput), { ruleId: RULE });

    expect(updated.status).toBe(200);
    expect(deleted.status).toBe(200);
    expect(rules.spies.update).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID }),
      RULE,
      updateInput
    );
    expect(rules.spies.delete).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID }),
      RULE,
      deleteInput
    );
    expectPrivate(updated);
    expectPrivate(deleted);
  });

  it("fails malformed or mismatched idempotency input without invoking storage", async () => {
    const rules = repository();
    const handlers = createRoutingRuleHandlers({
      authenticate: authenticated,
      repository: rules.value
    });
    const malformed = await handlers.create(
      new Request("https://unfiled.test/api/v1/routing-rules", {
        method: "POST",
        body: JSON.stringify({
          idempotencyKey: "body-key",
          enabled: true,
          ruleType: "prefix",
          condition: "shop",
          destination: { type: "note", noteId: NOTE },
          priority: 900
        }),
        headers: { "content-type": "application/json", "idempotency-key": "other-key" }
      })
    );

    expect(malformed.status).toBe(409);
    expect(rules.spies.create).not.toHaveBeenCalled();
    expectPrivate(malformed);
  });
});
