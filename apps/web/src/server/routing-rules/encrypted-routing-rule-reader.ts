import {
  MAX_ROUTING_RULE_PAGE_BYTES,
  MAX_RETAINED_ROUTING_RULES,
  ROUTING_RULE_PAGE_SIZE,
  RoutingRuleListResponseSchema,
  RoutingRuleDtoSchema,
  type EntityId,
  type RoutingRuleDto,
  type RoutingRuleDestination,
  type RoutingRuleListResponse,
  type RoutingRuleMatchSnapshot
} from "@unfiled/contracts";
import {
  MAX_ACTIVE_ROUTING_RULE_DECRYPTED_BYTES,
  MAX_ACTIVE_ROUTING_RULES,
  matchRoutingRule,
  normalizeRoutingRuleText,
  RoutingRuleCapacityError,
  type RoutingRuleMatchCandidate
} from "@unfiled/ai-routing/routing-rules";
import type {
  AuthorizedOwnerAccess,
  EncryptedAggregateService,
  RoutingRulePayload
} from "@unfiled/encrypted-aggregate";
import { isDeepStrictEqual } from "node:util";

import type {
  EncryptedLibraryObject,
  EncryptedLibraryPage,
  EncryptedLibraryRpcStore
} from "@/server/encryption/encrypted-library-rpc-store";
import { ServiceRpcError, ServiceRpcErrorCode } from "@/server/encryption/service-rpc-client";

type RoutingRuleRow = EncryptedLibraryObject<"routing_rule">;

export type EncryptedRoutingRuleReaderDependencies = Readonly<{
  ownerId: string;
  access: AuthorizedOwnerAccess;
  aggregate: EncryptedAggregateService;
  store: EncryptedLibraryRpcStore;
  signal?: AbortSignal;
}>;

export type OpenedEncryptedRoutingRule = Readonly<{
  row: RoutingRuleRow;
  payload: RoutingRulePayload;
  dto: RoutingRuleDto;
}>;

export type EncryptedRoutingRuleProposalCandidate = Readonly<{
  row: RoutingRuleRow;
  payload: RoutingRulePayload;
}>;

function unavailable(): never {
  throw new ServiceRpcError(ServiceRpcErrorCode.PROVIDER_UNAVAILABLE);
}

function destination(row: RoutingRuleRow): RoutingRuleDto["destination"] {
  const operational = row.operational;
  if (operational.destinationNoteId !== null && operational.destinationSpaceId === null) {
    return Object.freeze({
      type: "note" as const,
      noteId: operational.destinationNoteId as EntityId<"note">
    });
  }
  if (operational.destinationSpaceId !== null && operational.destinationNoteId === null) {
    return Object.freeze({
      type: "space" as const,
      spaceId: operational.destinationSpaceId as EntityId<"spc">
    });
  }
  return unavailable();
}

function isOwnerVisible(row: RoutingRuleRow): boolean {
  const { proposalState, source } = row.operational;
  return source === "explicit" || proposalState === "offered" || proposalState === "accepted";
}

function isActiveMatchCandidate(row: RoutingRuleRow): boolean {
  const operational = row.operational;
  return (
    operational.enabled &&
    operational.destinationStatus === "active" &&
    (operational.source === "explicit" || operational.proposalState === "accepted")
  );
}

function publicProposalState(row: RoutingRuleRow): RoutingRuleDto["proposalState"] {
  if (row.operational.source === "explicit") return null;
  if (row.operational.proposalState === "offered" || row.operational.proposalState === "accepted") {
    return row.operational.proposalState;
  }
  return unavailable();
}

function dto(row: RoutingRuleRow, payload: RoutingRulePayload): RoutingRuleDto {
  return RoutingRuleDtoSchema.parse({
    id: row.resourceId,
    revision: row.operational.currentRevision,
    enabled: row.operational.enabled,
    ruleType: row.operational.ruleType,
    condition: payload.condition,
    normalizedCondition: payload.normalizedCondition,
    aliases: payload.aliases,
    destination: destination(row),
    destinationStatus: row.operational.destinationStatus,
    priority: row.operational.priority,
    source: row.operational.source,
    proposalState: publicProposalState(row),
    lastFiredAt: row.operational.lastFiredAt,
    createdAt: row.operational.createdAt,
    updatedAt: row.operational.updatedAt
  });
}

function candidate(opened: OpenedEncryptedRoutingRule): RoutingRuleMatchCandidate {
  const { row, payload } = opened;
  return Object.freeze({
    id: row.resourceId as EntityId<"rule">,
    revision: row.operational.currentRevision,
    enabled: row.operational.enabled,
    ruleType: row.operational.ruleType,
    normalizedCondition: payload.normalizedCondition,
    aliases: payload.aliases,
    destination: destination(row),
    destinationStatus: row.operational.destinationStatus,
    priority: row.operational.priority,
    source: row.operational.source,
    proposalState: publicProposalState(row)
  });
}

function payloadBytes(payload: RoutingRulePayload): number {
  return Buffer.byteLength(JSON.stringify(payload), "utf8");
}

export class EncryptedRoutingRuleReader {
  private readonly ownerId: string;

  public constructor(private readonly dependencies: EncryptedRoutingRuleReaderDependencies) {
    this.ownerId = dependencies.ownerId.toLowerCase();
  }

  private active(): void {
    if (this.dependencies.signal?.aborted === true) unavailable();
  }

  private async rows(): Promise<readonly RoutingRuleRow[]> {
    const rows: RoutingRuleRow[] = [];
    let cursor: string | null = null;
    const seenCursors = new Set<string>();
    do {
      this.active();
      const page: EncryptedLibraryPage<"routing_rule"> =
        await this.dependencies.store.listEncryptedLibraryObjects({
          ownerId: this.ownerId,
          surface: "routing_rule",
          afterResourceId: cursor,
          limit: ROUTING_RULE_PAGE_SIZE
        });
      this.active();
      rows.push(...page.items);
      if (rows.length > MAX_RETAINED_ROUTING_RULES) {
        throw new RoutingRuleCapacityError(
          "retained_rule_limit_exceeded",
          MAX_RETAINED_ROUTING_RULES,
          rows.length
        );
      }
      if (page.nextCursor !== null && seenCursors.has(page.nextCursor)) return unavailable();
      if (page.nextCursor !== null) seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    } while (cursor !== null);
    return Object.freeze(rows);
  }

  private async openPayload(row: RoutingRuleRow): Promise<RoutingRulePayload> {
    this.active();
    const payload = await this.dependencies.aggregate.openRoutingRule(
      this.dependencies.access,
      row.encrypted,
      {
        ruleId: row.resourceId as EntityId<"rule">,
        recordVersion: row.recordVersion
      }
    );
    this.active();
    if (normalizeRoutingRuleText(payload.condition) !== payload.normalizedCondition) {
      return unavailable();
    }
    return payload;
  }

  private async open(row: RoutingRuleRow): Promise<OpenedEncryptedRoutingRule> {
    const payload = await this.openPayload(row);
    return Object.freeze({ row, payload, dto: dto(row, payload) });
  }

  public async list(
    afterResourceId: EntityId<"rule"> | null = null
  ): Promise<RoutingRuleListResponse> {
    const visible: RoutingRuleRow[] = [];
    let cursor: string | null = afterResourceId;
    const seenCursors = new Set<string>();
    if (cursor !== null) seenCursors.add(cursor);
    let hasMore = false;
    let scannedRows = 0;

    for (;;) {
      this.active();
      const page: EncryptedLibraryPage<"routing_rule"> =
        await this.dependencies.store.listEncryptedLibraryObjects({
          ownerId: this.ownerId,
          surface: "routing_rule",
          afterResourceId: cursor,
          limit: ROUTING_RULE_PAGE_SIZE
        });
      this.active();
      for (const row of page.items) {
        scannedRows += 1;
        if (scannedRows > MAX_RETAINED_ROUTING_RULES) {
          throw new RoutingRuleCapacityError(
            "retained_rule_limit_exceeded",
            MAX_RETAINED_ROUTING_RULES,
            scannedRows
          );
        }
        if (!isOwnerVisible(row)) continue;
        if (visible.length === ROUTING_RULE_PAGE_SIZE) {
          hasMore = true;
          break;
        }
        visible.push(row);
      }
      if (hasMore || page.nextCursor === null) break;
      if (seenCursors.has(page.nextCursor)) return unavailable();
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }

    const opened = await Promise.all(visible.map((row) => this.open(row)));
    const result = RoutingRuleListResponseSchema.parse({
      items: opened.map(({ dto: value }) => value),
      pageInfo: {
        hasMore,
        nextCursor: hasMore ? (visible.at(-1)?.resourceId ?? null) : null
      }
    });
    if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_ROUTING_RULE_PAGE_BYTES) {
      return unavailable();
    }
    return Object.freeze(result);
  }

  public async get(ruleId: EntityId<"rule">): Promise<OpenedEncryptedRoutingRule | null> {
    const row = (await this.rows()).find(({ resourceId }) => resourceId === ruleId) ?? null;
    if (row === null || !isOwnerVisible(row)) return null;
    return this.open(row);
  }

  public async findLearnedProposal(
    input: Readonly<{
      ruleType: RoutingRuleRow["operational"]["ruleType"];
      normalizedCondition: string;
      destination: RoutingRuleDestination;
    }>
  ): Promise<EncryptedRoutingRuleProposalCandidate | null> {
    const learned = (await this.rows()).filter(
      ({ operational }) => operational.source === "correction_suggested"
    );
    let decryptedBytes = 0;
    for (const row of learned) {
      const rowDestination = destination(row);
      if (
        row.operational.ruleType !== input.ruleType ||
        !isDeepStrictEqual(rowDestination, input.destination)
      ) {
        continue;
      }
      const rulePayload = await this.openPayload(row);
      decryptedBytes += payloadBytes(rulePayload);
      if (decryptedBytes > MAX_ACTIVE_ROUTING_RULE_DECRYPTED_BYTES) {
        throw new RoutingRuleCapacityError(
          "active_decrypted_bytes_limit_exceeded",
          MAX_ACTIVE_ROUTING_RULE_DECRYPTED_BYTES,
          decryptedBytes
        );
      }
      if (rulePayload.normalizedCondition === input.normalizedCondition) {
        return Object.freeze({ row, payload: rulePayload });
      }
    }
    return null;
  }

  public async match(captureText: string): Promise<RoutingRuleMatchSnapshot | null> {
    const retained = await this.rows();
    const active = retained.filter(isActiveMatchCandidate);
    if (active.length > MAX_ACTIVE_ROUTING_RULES) {
      throw new RoutingRuleCapacityError(
        "active_rule_limit_exceeded",
        MAX_ACTIVE_ROUTING_RULES,
        active.length
      );
    }
    const opened: OpenedEncryptedRoutingRule[] = [];
    let activeDecryptedBytes = 0;
    for (const row of active) {
      const rule = await this.open(row);
      activeDecryptedBytes += payloadBytes(rule.payload);
      if (activeDecryptedBytes > MAX_ACTIVE_ROUTING_RULE_DECRYPTED_BYTES) {
        throw new RoutingRuleCapacityError(
          "active_decrypted_bytes_limit_exceeded",
          MAX_ACTIVE_ROUTING_RULE_DECRYPTED_BYTES,
          activeDecryptedBytes
        );
      }
      opened.push(rule);
    }
    return (
      matchRoutingRule({
        captureText,
        rules: Object.freeze(opened.map(candidate)),
        activeDecryptedBytes
      })?.snapshot ?? null
    );
  }
}
