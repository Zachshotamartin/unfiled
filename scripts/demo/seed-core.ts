import {
  ApiClientError,
  ApiClientMalformedResponseError,
  createApiClient
} from "../../packages/api-client/src/index.js";
import { NormalizedEmailSchema } from "../../packages/contracts/src/auth.js";
import type { EntityId } from "../../packages/contracts/src/ids.js";

import {
  PORTFOLIO_NOTES,
  PORTFOLIO_PLANNED_WRITES,
  PORTFOLIO_SETTINGS,
  PORTFOLIO_SPACES,
  PORTFOLIO_TAGS,
  type DemoNoteKey,
  type DemoNoteSpec,
  type DemoProfile,
  type DemoSpaceKey,
  type DemoTagKey
} from "./manifest.js";

const MAX_PAGES = 100;
const MAX_ACCESS_TOKEN_LENGTH = 8_192;
const MAX_RESPONSE_BYTES = 2 * 1_024 * 1_024;
const REQUEST_TIMEOUT_MS = 20_000;
const DEDICATED_ACCOUNT_CONFIRMATION_PREFIX = "I_CONFIRM_THIS_IS_A_DEDICATED_SYNTHETIC_";
const PRODUCTION_CONFIRMATION_PREFIX = "SEED_UNFILED_SYNTHETIC_DATA";

export type DemoEnvironment = "preview" | "production";
export type DemoMode = "dry-run" | "execute";

export type DemoApiClient = Pick<
  ReturnType<typeof createApiClient>,
  | "createNote"
  | "createSpace"
  | "createTag"
  | "getAuthSession"
  | "getNote"
  | "getProviderKeyMetadata"
  | "getUserSettings"
  | "listAllRoutingRules"
  | "listCaptures"
  | "listNotes"
  | "listReviewItems"
  | "listSpaces"
  | "listTags"
  | "updateNote"
  | "updateUserSettings"
>;

export type CliOptions = Readonly<{
  environment: DemoEnvironment;
  environmentWasExplicit: boolean;
  help: boolean;
  mode: DemoMode;
  productionConfirmation: string | null;
  profile: DemoProfile;
}>;

export type ExecutionConfig = Readonly<{
  accessToken: string;
  allowedEmails: ReadonlySet<string>;
  environment: DemoEnvironment;
  origin: string;
  profile: DemoProfile;
}>;

export type SeedSummary = Readonly<{
  attemptedWrites: number;
  profile: DemoProfile;
  replayedWrites: number;
  skippedWrites: number;
}>;

export type SeedCliDependencies = Readonly<{
  createClient?: (config: ExecutionConfig) => DemoApiClient;
  environment?: Readonly<Record<string, string | undefined>>;
  writeError?: (line: string) => void;
  writeOutput?: (line: string) => void;
}>;

type Page<T> = Readonly<{
  items: readonly T[];
  pageInfo: Readonly<{ hasMore: boolean; nextCursor: string | null }>;
}>;

type SpaceItem = Awaited<ReturnType<DemoApiClient["listSpaces"]>>["items"][number];
type TagItem = Awaited<ReturnType<DemoApiClient["listTags"]>>["items"][number];
type NoteSummaryItem = Awaited<ReturnType<DemoApiClient["listNotes"]>>["items"][number];
type NoteItem = Awaited<ReturnType<DemoApiClient["getNote"]>>["note"];
type CaptureItem = Awaited<ReturnType<DemoApiClient["listCaptures"]>>["items"][number];
type ReviewItem = Awaited<ReturnType<DemoApiClient["listReviewItems"]>>["items"][number];
type UserSettingsItem = Awaited<ReturnType<DemoApiClient["getUserSettings"]>>["settings"];

type Inventory = Readonly<{
  captures: readonly CaptureItem[];
  deletedNotes: readonly NoteSummaryItem[];
  notes: readonly NoteSummaryItem[];
  providerKeyConfigured: boolean;
  reviewItems: readonly ReviewItem[];
  routingRuleCount: number;
  settings: UserSettingsItem;
  spaces: readonly SpaceItem[];
  tags: readonly TagItem[];
}>;

export class DemoSeedError extends Error {
  public constructor(public readonly code: string) {
    super(code);
    this.name = "DemoSeedError";
  }
}

function fail(code: string): never {
  throw new DemoSeedError(code);
}

function requiredValue(argv: readonly string[], index: number): string {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) return fail("invalid_arguments");
  return value;
}

export function parseCliOptions(argv: readonly string[]): CliOptions {
  const cliArguments = argv[0] === "--" ? argv.slice(1) : argv;
  let environment: DemoEnvironment = "preview";
  let environmentWasExplicit = false;
  let help = false;
  let mode: DemoMode = "dry-run";
  let productionConfirmation: string | null = null;
  let profile: DemoProfile = "portfolio";
  const seen = new Set<string>();

  const mark = (name: string): void => {
    if (seen.has(name)) fail("duplicate_argument");
    seen.add(name);
  };

  for (let index = 0; index < cliArguments.length; index += 1) {
    const argument = cliArguments[index];
    switch (argument) {
      case "--dry-run":
        mark("mode");
        mode = "dry-run";
        break;
      case "--execute":
        mark("mode");
        mode = "execute";
        break;
      case "--environment": {
        mark("environment");
        const value = requiredValue(cliArguments, index + 1);
        if (value !== "preview" && value !== "production") fail("invalid_environment");
        environment = value;
        environmentWasExplicit = true;
        index += 1;
        break;
      }
      case "--profile": {
        mark("profile");
        const value = requiredValue(cliArguments, index + 1);
        if (value !== "fresh" && value !== "portfolio") fail("invalid_profile");
        profile = value;
        index += 1;
        break;
      }
      case "--confirm-production":
        mark("production-confirmation");
        productionConfirmation = requiredValue(cliArguments, index + 1);
        index += 1;
        break;
      case "--help":
      case "-h":
        mark("help");
        help = true;
        break;
      default:
        fail("unknown_argument");
    }
  }

  if (help && cliArguments.length !== 1) fail("invalid_arguments");
  if (environment === "production" && !environmentWasExplicit) {
    fail("production_environment_must_be_explicit");
  }
  if (environment === "preview" && productionConfirmation !== null) {
    fail("unexpected_production_confirmation");
  }

  return Object.freeze({
    environment,
    environmentWasExplicit,
    help,
    mode,
    productionConfirmation,
    profile
  });
}

function localHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function canonicalOrigin(value: string): string {
  if (value !== value.trim() || value.length === 0) return fail("invalid_base_url");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail("invalid_base_url");
  }
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    (url.pathname !== "" && url.pathname !== "/")
  ) {
    return fail("invalid_base_url");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && localHostname(url.hostname))) {
    return fail("insecure_base_url");
  }
  return url.origin;
}

function exactList(value: string | undefined, missingCode: string): readonly string[] {
  if (value === undefined || value.length === 0) return fail(missingCode);
  const entries = value.split(",");
  if (entries.some((entry) => entry.length === 0 || entry !== entry.trim())) {
    return fail("invalid_allowlist");
  }
  if (new Set(entries).size !== entries.length) return fail("invalid_allowlist");
  return Object.freeze(entries);
}

function allowedOrigins(environment: Readonly<Record<string, string | undefined>>): Set<string> {
  const configured = exactList(
    environment.UNFILED_DEMO_ALLOWED_ORIGINS,
    "missing_origin_allowlist"
  );
  const result = new Set(configured.map(canonicalOrigin));
  if (result.size !== configured.length) return fail("invalid_allowlist");
  return result;
}

function allowedEmails(environment: Readonly<Record<string, string | undefined>>): Set<string> {
  const configured = exactList(
    environment.UNFILED_DEMO_ALLOWED_ACCOUNT_EMAILS,
    "missing_account_allowlist"
  );
  const result = new Set<string>();
  for (const candidate of configured) {
    const parsed = NormalizedEmailSchema.safeParse(candidate);
    if (!parsed.success || parsed.data !== candidate) fail("invalid_account_allowlist");
    result.add(parsed.data);
  }
  return result;
}

export function dedicatedAccountConfirmation(profile: DemoProfile): string {
  return `${DEDICATED_ACCOUNT_CONFIRMATION_PREFIX}${profile.toUpperCase()}_ACCOUNT`;
}

export function productionConfirmation(profile: DemoProfile, origin: string): string {
  return `${PRODUCTION_CONFIRMATION_PREFIX}:${profile.toUpperCase()}@${origin}`;
}

function targetOrigin(
  environment: Readonly<Record<string, string | undefined>>,
  options: CliOptions
): string {
  const declaredEnvironment = environment.UNFILED_DEMO_TARGET_ENVIRONMENT;
  if (declaredEnvironment !== "preview" && declaredEnvironment !== "production") {
    return fail("missing_or_invalid_target_environment");
  }
  if (declaredEnvironment !== options.environment) fail("target_environment_mismatch");
  const rawOrigin = environment.UNFILED_DEMO_BASE_URL;
  if (rawOrigin === undefined) return fail("missing_base_url");
  const origin = canonicalOrigin(rawOrigin);
  if (!allowedOrigins(environment).has(origin)) fail("origin_not_allowed");
  if (options.environment === "production") {
    if (!options.environmentWasExplicit) fail("production_environment_must_be_explicit");
    if (options.productionConfirmation !== productionConfirmation(options.profile, origin)) {
      fail("production_confirmation_required");
    }
    if (!origin.startsWith("https://")) fail("production_requires_https");
  }
  return origin;
}

function requestUrl(input: RequestInfo | URL): URL {
  if (typeof input === "string") return new URL(input);
  if (input instanceof URL) return input;
  return new URL(input.url);
}

function requestMethod(init: RequestInit | undefined): string {
  return (init?.method ?? "GET").toUpperCase();
}

function expectedStatus(method: string, pathname: string): number {
  if (
    method === "GET" &&
    (/^\/api\/v1\/(?:auth\/session|spaces|tags|notes|captures|review-items|routing-rules|me\/(?:provider-key|settings))$/u.test(
      pathname
    ) ||
      /^\/api\/v1\/notes\/note_[0-9A-HJKMNP-TV-Z]{26}$/u.test(pathname))
  ) {
    return 200;
  }
  if (method === "POST" && /^\/api\/v1\/(?:spaces|tags|notes)$/u.test(pathname)) return 201;
  if (method === "PATCH" && /^\/api\/v1\/notes\/note_[0-9A-HJKMNP-TV-Z]{26}$/u.test(pathname)) {
    return 200;
  }
  if (method === "PATCH" && pathname === "/api/v1/me/settings") return 200;
  return fail("unexpected_api_route");
}

function containsAuthorityField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsAuthorityField);
  if (!plainRecord(value)) return false;
  return Object.entries(value).some(
    ([key, nested]) =>
      ["accessToken", "email", "ownerId", "refreshToken", "serviceRoleKey", "userId"].includes(
        key
      ) || containsAuthorityField(nested)
  );
}

async function boundedJsonResponse(response: Response): Promise<Response> {
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (mediaType !== "application/json") fail("invalid_response_media_type");
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const bytes = Number(declared);
    if (!/^\d+$/u.test(declared) || !Number.isSafeInteger(bytes) || bytes > MAX_RESPONSE_BYTES) {
      fail("response_too_large");
    }
  }
  if (response.body === null) fail("malformed_api_response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        fail("response_too_large");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Response(body, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText
  });
}

export function createStrictDemoFetch(
  origin: string,
  accessToken: string,
  fetcher: typeof globalThis.fetch = globalThis.fetch
): typeof globalThis.fetch {
  return async (input, init) => {
    const url = requestUrl(input);
    const method = requestMethod(init);
    const status = expectedStatus(method, url.pathname);
    if (url.origin !== origin || url.username !== "" || url.password !== "") {
      return fail("api_origin_mismatch");
    }
    const headers = new Headers(init?.headers);
    if (headers.get("authorization") !== `Bearer ${accessToken}`) {
      return fail("owner_authentication_missing");
    }
    if (init?.body !== undefined) {
      if (typeof init.body !== "string") return fail("invalid_request_body");
      let body: unknown;
      try {
        body = JSON.parse(init.body) as unknown;
      } catch {
        return fail("invalid_request_body");
      }
      if (containsAuthorityField(body)) return fail("request_contains_authority_field");
    }
    const response = await fetcher(input, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    if (response.redirected || response.status !== status) fail("unexpected_api_status");
    return boundedJsonResponse(response);
  };
}

export function executionConfig(
  options: CliOptions,
  environment: Readonly<Record<string, string | undefined>>
): ExecutionConfig {
  const origin = targetOrigin(environment, options);
  const accessToken = environment.UNFILED_DEMO_ACCESS_TOKEN;
  if (
    accessToken === undefined ||
    accessToken.length === 0 ||
    accessToken.length > MAX_ACCESS_TOKEN_LENGTH ||
    /\s/u.test(accessToken)
  ) {
    return fail("invalid_access_token");
  }
  if (
    environment.UNFILED_DEMO_DEDICATED_ACCOUNT_CONFIRMATION !==
    dedicatedAccountConfirmation(options.profile)
  ) {
    return fail("dedicated_account_not_confirmed");
  }
  return Object.freeze({
    accessToken,
    allowedEmails: allowedEmails(environment),
    environment: options.environment,
    origin,
    profile: options.profile
  });
}

async function collectPages<T>(
  load: (cursor: string | undefined) => Promise<Page<T>>,
  identity: (item: T) => string
): Promise<readonly T[]> {
  const items: T[] = [];
  const seenItems = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
    const page = await load(cursor);
    for (const item of page.items) {
      const id = identity(item);
      if (seenItems.has(id)) fail("duplicate_inventory_item");
      seenItems.add(id);
      items.push(item);
    }
    if (!page.pageInfo.hasMore) {
      if (page.pageInfo.nextCursor !== null) fail("invalid_pagination");
      return Object.freeze(items);
    }
    const nextCursor = page.pageInfo.nextCursor;
    if (nextCursor === null || seenCursors.has(nextCursor)) fail("invalid_pagination");
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  return fail("pagination_limit_exceeded");
}

async function inventory(client: DemoApiClient): Promise<Inventory> {
  const [
    spaces,
    tags,
    notes,
    deletedNotes,
    captures,
    open,
    resolved,
    dismissed,
    routingRules,
    openAiProviderKey,
    anthropicProviderKey,
    userSettings
  ] = await Promise.all([
    collectPages(
      (cursor) =>
        client.listSpaces({ includeArchived: true, limit: 100, ...(cursor ? { cursor } : {}) }),
      ({ id }) => id
    ),
    collectPages(
      (cursor) => client.listTags({ limit: 100, ...(cursor ? { cursor } : {}) }),
      ({ id }) => id
    ),
    collectPages(
      (cursor) =>
        client.listNotes({
          archive: "include",
          deleted: "exclude",
          limit: 100,
          ...(cursor ? { cursor } : {})
        }),
      ({ id }) => id
    ),
    collectPages(
      (cursor) =>
        client.listNotes({
          archive: "include",
          deleted: "only",
          limit: 100,
          ...(cursor ? { cursor } : {})
        }),
      ({ id }) => id
    ),
    collectPages(
      (cursor) => client.listCaptures({ limit: 100, ...(cursor ? { cursor } : {}) }),
      ({ id }) => id
    ),
    collectPages(
      (cursor) =>
        client.listReviewItems({ limit: 100, state: "open", ...(cursor ? { cursor } : {}) }),
      ({ id }) => id
    ),
    collectPages(
      (cursor) =>
        client.listReviewItems({ limit: 100, state: "resolved", ...(cursor ? { cursor } : {}) }),
      ({ id }) => id
    ),
    collectPages(
      (cursor) =>
        client.listReviewItems({ limit: 100, state: "dismissed", ...(cursor ? { cursor } : {}) }),
      ({ id }) => id
    ),
    client.listAllRoutingRules(),
    client.getProviderKeyMetadata("openai"),
    client.getProviderKeyMetadata("anthropic"),
    client.getUserSettings()
  ]);
  return Object.freeze({
    captures,
    deletedNotes,
    notes,
    providerKeyConfigured:
      openAiProviderKey.providerKey !== null || anthropicProviderKey.providerKey !== null,
    reviewItems: Object.freeze([...open, ...resolved, ...dismissed]),
    routingRuleCount: routingRules.items.length,
    settings: userSettings.settings,
    spaces,
    tags
  });
}

function uniqueByName<T>(
  items: readonly T[],
  name: (item: T) => string,
  allowed: ReadonlySet<string>
): Map<string, T> {
  const result = new Map<string, T>();
  for (const item of items) {
    const value = name(item);
    if (!allowed.has(value)) fail("unexpected_account_data");
    if (result.has(value)) fail("duplicate_inventory_item");
    result.set(value, item);
  }
  return result;
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return (
    sortedLeft.length === sortedRight.length &&
    sortedLeft.every((value, index) => value === sortedRight[index])
  );
}

function plainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function expectedChecklist(
  bodyMarkdown: string
): readonly Readonly<{ checked: boolean; lineIndex: number; text: string }>[] {
  return Object.freeze(
    bodyMarkdown.split("\n").flatMap((line, lineIndex) => {
      const match = /^\s*[-*+]\s+\[([ xX])\]\s+(.+?)\s*$/u.exec(line);
      return match?.[2]
        ? [{ checked: match[1]?.toLowerCase() === "x", lineIndex, text: match[2] }]
        : [];
    })
  );
}

function sameRecord(
  actual: Readonly<Record<string, unknown>>,
  expected: Readonly<Record<string, string | number | null>>
): boolean {
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  return (
    sameValues(actualKeys, expectedKeys) &&
    expectedKeys.every((key) => actual[key] === expected[key])
  );
}

function verifyStructuredData(note: NoteItem, spec: DemoNoteSpec): void {
  const structuredValue: unknown = note.structuredData;
  if (!plainRecord(structuredValue) || structuredValue.schemaVersion !== 1) {
    fail("fixture_schema_mismatch");
  }
  const structured = structuredValue;
  if (spec.type === "list") {
    const expected = expectedChecklist(spec.bodyMarkdown);
    const items = structured.items;
    if (!Array.isArray(items) || items.length !== expected.length) fail("fixture_schema_mismatch");
    items.forEach((item, index) => {
      const wanted = expected[index];
      if (
        !plainRecord(item) ||
        wanted === undefined ||
        item.text !== wanted.text ||
        item.checked !== wanted.checked ||
        item.ordinal !== index ||
        item.section !== null
      ) {
        fail("fixture_schema_mismatch");
      }
    });
    return;
  }
  if (spec.type === "project") {
    const expected = expectedChecklist(spec.bodyMarkdown);
    const items = structured.checklistItems;
    if (!Array.isArray(items) || items.length !== expected.length) fail("fixture_schema_mismatch");
    items.forEach((item, index) => {
      const wanted = expected[index];
      if (
        !plainRecord(item) ||
        wanted === undefined ||
        item.text !== wanted.text ||
        item.checked !== wanted.checked ||
        item.ordinal !== index ||
        item.lineIndex !== wanted.lineIndex
      ) {
        fail("fixture_schema_mismatch");
      }
    });
    return;
  }
  if (spec.type === "log") {
    const entries = structured.entries;
    if (!Array.isArray(entries) || entries.length !== 2) fail("fixture_schema_mismatch");
    const expectedEntries = [
      {
        fields: { exercise: "bench press", set_1_reps: 8, set_1_weight_lb: 125 },
        occurredAt: "2026-08-24T17:00:00.000-07:00"
      },
      {
        fields: {
          exercise: "bench press",
          incline_dumbbell_reps: 10,
          incline_dumbbell_sets: 3,
          incline_dumbbell_weight_lb: 45,
          set_1_reps: 8,
          set_1_weight_lb: 135,
          set_2_reps: 6,
          set_2_weight_lb: 145,
          set_3_reps: 4,
          set_3_weight_lb: 155
        },
        occurredAt: "2026-08-31T17:00:00.000-07:00"
      }
    ] as const;
    for (const [index, expected] of expectedEntries.entries()) {
      const entry: unknown = entries[index];
      if (!plainRecord(entry) || entry.occurredAt !== expected.occurredAt) {
        fail("fixture_schema_mismatch");
      }
      const fields: unknown = entry.fields;
      if (!plainRecord(fields) || !sameRecord(fields, expected.fields)) {
        fail("fixture_schema_mismatch");
      }
    }
    return;
  }
  if (Object.keys(structured).some((key) => key !== "schemaVersion")) {
    fail("fixture_schema_mismatch");
  }
}

type FixtureContext = Readonly<{
  notes: ReadonlyMap<DemoNoteKey, NoteItem>;
  spaces: ReadonlyMap<DemoSpaceKey, SpaceItem>;
  tags: ReadonlyMap<DemoTagKey, TagItem>;
}>;

function desiredIds(
  spec: DemoNoteSpec,
  context: FixtureContext
): {
  links: readonly Readonly<{ linkType: "related"; toNoteId: EntityId<"note"> }>[];
  spaceId: EntityId<"spc"> | null;
  tagIds: readonly EntityId<"tag">[];
} {
  const spaceId = spec.space === null ? null : context.spaces.get(spec.space)?.id;
  if (spaceId === undefined) return fail("fixture_dependency_missing");
  const tagIds = spec.tags.map((key) => {
    const id = context.tags.get(key)?.id;
    if (id === undefined) return fail("fixture_dependency_missing");
    return id;
  });
  const links =
    spec.linkTo === undefined
      ? []
      : (() => {
          const target = context.notes.get(spec.linkTo)?.id;
          if (target === undefined) return fail("fixture_dependency_missing");
          return [{ linkType: "related" as const, toNoteId: target }];
        })();
  return { links, spaceId, tagIds };
}

function verifyNote(
  note: NoteItem,
  spec: DemoNoteSpec,
  context: FixtureContext,
  allowIncompleteWorkout = false
): "complete" | "incomplete_workout" {
  const desired = desiredIds(spec, context);
  const finalBody = spec.updateBodyMarkdown ?? spec.bodyMarkdown;
  const expectedRevision = spec.updateBodyMarkdown === undefined ? 1 : 2;
  const incompleteWorkout =
    allowIncompleteWorkout &&
    spec.updateBodyMarkdown !== undefined &&
    note.bodyMarkdown === spec.bodyMarkdown &&
    note.currentRevision === 1;
  if (
    note.title !== spec.title ||
    note.type !== spec.type ||
    note.privacy !== spec.privacy ||
    note.spaceId !== desired.spaceId ||
    note.archivedAt !== null ||
    note.deletedAt !== null ||
    !sameValues(note.tagIds, desired.tagIds) ||
    note.links.length !== desired.links.length ||
    note.links.some(
      (link, index) =>
        link.linkType !== desired.links[index]?.linkType ||
        link.toNoteId !== desired.links[index]?.toNoteId
    ) ||
    (!incompleteWorkout &&
      (note.bodyMarkdown !== finalBody || note.currentRevision !== expectedRevision))
  ) {
    return fail("fixture_mismatch");
  }
  if (incompleteWorkout) {
    const structuredData: unknown = note.structuredData;
    if (!plainRecord(structuredData) || !Array.isArray(structuredData.entries)) {
      return fail("fixture_schema_mismatch");
    }
    if (structuredData.entries.length !== 0) return fail("fixture_schema_mismatch");
    return "incomplete_workout";
  }
  verifyStructuredData(note, spec);
  return "complete";
}

function expectedMaps(inventoryValue: Inventory): {
  notes: Map<string, NoteSummaryItem>;
  spaces: Map<string, SpaceItem>;
  tags: Map<string, TagItem>;
} {
  if (
    inventoryValue.captures.length > 0 ||
    inventoryValue.deletedNotes.length > 0 ||
    inventoryValue.reviewItems.length > 0 ||
    inventoryValue.routingRuleCount > 0 ||
    inventoryValue.providerKeyConfigured
  ) {
    fail("account_not_pristine");
  }
  const spaces = uniqueByName(
    inventoryValue.spaces,
    ({ name }) => name,
    new Set(PORTFOLIO_SPACES.map(({ name }) => name))
  );
  const tags = uniqueByName(
    inventoryValue.tags,
    ({ name }) => name,
    new Set(PORTFOLIO_TAGS.map(({ name }) => name))
  );
  const notes = uniqueByName(
    inventoryValue.notes,
    ({ title }) => title,
    new Set(PORTFOLIO_NOTES.map(({ title }) => title))
  );
  const hasExistingFixture = spaces.size > 0 || tags.size > 0 || notes.size > 0;
  const markerTitle = PORTFOLIO_NOTES.find(({ key }) => key === "account-label")?.title;
  if (markerTitle === undefined) fail("fixture_manifest_invalid");
  if (hasExistingFixture && !notes.has(markerTitle)) fail("fixture_marker_missing");
  for (const spec of PORTFOLIO_SPACES) {
    const existing = spaces.get(spec.name);
    if (
      existing !== undefined &&
      (existing.parentId !== null ||
        existing.archivedAt !== null ||
        existing.sortKey !== spec.sortKey)
    ) {
      fail("fixture_mismatch");
    }
  }
  return { notes, spaces, tags };
}

function mapSpacesByKey(existing: ReadonlyMap<string, SpaceItem>): Map<DemoSpaceKey, SpaceItem> {
  return new Map(
    PORTFOLIO_SPACES.flatMap((spec) => {
      const item = existing.get(spec.name);
      return item === undefined ? [] : [[spec.key, item] as const];
    })
  );
}

function mapTagsByKey(existing: ReadonlyMap<string, TagItem>): Map<DemoTagKey, TagItem> {
  return new Map(
    PORTFOLIO_TAGS.flatMap((spec) => {
      const item = existing.get(spec.name);
      return item === undefined ? [] : [[spec.key, item] as const];
    })
  );
}

async function verifyExistingNotes(
  client: DemoApiClient,
  existing: ReadonlyMap<string, NoteSummaryItem>,
  spaces: ReadonlyMap<DemoSpaceKey, SpaceItem>,
  tags: ReadonlyMap<DemoTagKey, TagItem>,
  allowIncompleteWorkout = true
): Promise<Map<DemoNoteKey, NoteItem>> {
  const notes = new Map<DemoNoteKey, NoteItem>();
  const byKey = new Map(PORTFOLIO_NOTES.map((spec) => [spec.key, spec] as const));
  for (const spec of PORTFOLIO_NOTES) {
    const summary = existing.get(spec.title);
    if (summary !== undefined) {
      const note = (await client.getNote(summary.id)).note;
      if (note.id !== summary.id) fail("response_identity_mismatch");
      notes.set(spec.key, note);
    }
  }
  const context: FixtureContext = { notes, spaces, tags };
  for (const [key, note] of notes) {
    const spec = byKey.get(key);
    if (spec === undefined) fail("fixture_mismatch");
    verifyNote(note, spec, context, allowIncompleteWorkout);
  }
  return notes;
}

async function createOrReuseSpaces(
  client: DemoApiClient,
  existing: ReadonlyMap<string, SpaceItem>,
  summary: { attempted: number; replayed: number; skipped: number }
): Promise<Map<DemoSpaceKey, SpaceItem>> {
  const result = mapSpacesByKey(existing);
  for (const spec of PORTFOLIO_SPACES) {
    if (result.has(spec.key)) {
      summary.skipped += 1;
      continue;
    }
    const response = await client.createSpace({
      idempotencyKey: spec.idempotencyKey,
      name: spec.name,
      parentId: null,
      sortKey: spec.sortKey
    });
    summary.attempted += 1;
    if (response.replayed) summary.replayed += 1;
    if (
      response.space.name !== spec.name ||
      response.space.parentId !== null ||
      response.space.sortKey !== spec.sortKey ||
      response.space.archivedAt !== null
    ) {
      fail("fixture_mismatch");
    }
    result.set(spec.key, response.space);
  }
  return result;
}

async function createOrReuseTags(
  client: DemoApiClient,
  existing: ReadonlyMap<string, TagItem>,
  summary: { attempted: number; replayed: number; skipped: number }
): Promise<Map<DemoTagKey, TagItem>> {
  const result = mapTagsByKey(existing);
  for (const spec of PORTFOLIO_TAGS) {
    if (result.has(spec.key)) {
      summary.skipped += 1;
      continue;
    }
    const response = await client.createTag({
      idempotencyKey: spec.idempotencyKey,
      name: spec.name
    });
    summary.attempted += 1;
    if (response.replayed) summary.replayed += 1;
    if (response.tag.name !== spec.name) fail("fixture_mismatch");
    result.set(spec.key, response.tag);
  }
  return result;
}

async function createOrReuseNotes(
  client: DemoApiClient,
  initialNotes: Map<DemoNoteKey, NoteItem>,
  spaces: ReadonlyMap<DemoSpaceKey, SpaceItem>,
  tags: ReadonlyMap<DemoTagKey, TagItem>,
  summary: { attempted: number; replayed: number; skipped: number }
): Promise<void> {
  const notes = new Map(initialNotes);
  for (const spec of PORTFOLIO_NOTES.filter(({ key }) => key !== "account-label")) {
    const context: FixtureContext = { notes, spaces, tags };
    let note = notes.get(spec.key);
    if (note === undefined) {
      const desired = desiredIds(spec, context);
      const response = await client.createNote({
        bodyMarkdown: spec.bodyMarkdown,
        idempotencyKey: spec.idempotencyKey,
        links: [...desired.links],
        privacy: spec.privacy,
        spaceId: desired.spaceId,
        tagIds: [...desired.tagIds],
        title: spec.title,
        type: spec.type
      });
      verifyMutationBinding(response, undefined, 1);
      summary.attempted += 1;
      if (response.replayed) summary.replayed += 1;
      note = response.note;
      notes.set(spec.key, note);
    } else {
      summary.skipped += 1;
    }

    const state = verifyNote(note, spec, { notes, spaces, tags }, true);
    if (state === "incomplete_workout") {
      if (spec.updateBodyMarkdown === undefined || spec.updateIdempotencyKey === undefined) {
        fail("fixture_mismatch");
      }
      const response = await client.updateNote(note.id, {
        bodyMarkdown: spec.updateBodyMarkdown,
        expectedRevision: 1,
        idempotencyKey: spec.updateIdempotencyKey
      });
      verifyMutationBinding(response, note.id, 2);
      summary.attempted += 1;
      if (response.replayed) summary.replayed += 1;
      note = response.note;
      notes.set(spec.key, note);
      verifyNote(note, spec, { notes, spaces, tags });
    } else if (spec.updateBodyMarkdown !== undefined) {
      summary.skipped += 1;
    }
  }
}

async function createOrReuseMarker(
  client: DemoApiClient,
  initialNotes: Map<DemoNoteKey, NoteItem>,
  spaces: ReadonlyMap<DemoSpaceKey, SpaceItem>,
  tags: ReadonlyMap<DemoTagKey, TagItem>,
  summary: { attempted: number; replayed: number; skipped: number }
): Promise<void> {
  const spec = PORTFOLIO_NOTES.find(({ key }) => key === "account-label");
  if (spec === undefined) fail("fixture_manifest_invalid");
  const context: FixtureContext = { notes: initialNotes, spaces, tags };
  const existing = initialNotes.get(spec.key);
  if (existing !== undefined) {
    verifyNote(existing, spec, context);
    summary.skipped += 1;
    return;
  }
  const desired = desiredIds(spec, context);
  const response = await client.createNote({
    bodyMarkdown: spec.bodyMarkdown,
    idempotencyKey: spec.idempotencyKey,
    links: [...desired.links],
    privacy: spec.privacy,
    spaceId: desired.spaceId,
    tagIds: [...desired.tagIds],
    title: spec.title,
    type: spec.type
  });
  verifyMutationBinding(response, undefined, 1);
  summary.attempted += 1;
  if (response.replayed) summary.replayed += 1;
  initialNotes.set(spec.key, response.note);
  verifyNote(response.note, spec, { notes: initialNotes, spaces, tags });
}

async function createOrReuseSettings(
  client: DemoApiClient,
  current: UserSettingsItem,
  summary: { attempted: number; replayed: number; skipped: number }
): Promise<void> {
  if (
    current.locale === PORTFOLIO_SETTINGS.locale &&
    current.timezone === PORTFOLIO_SETTINGS.timezone
  ) {
    summary.skipped += 1;
    return;
  }
  const response = await client.updateUserSettings({
    expectedSettingsRevision: current.settingsRevision,
    idempotencyKey: PORTFOLIO_SETTINGS.idempotencyKey,
    locale: PORTFOLIO_SETTINGS.locale,
    timezone: PORTFOLIO_SETTINGS.timezone
  });
  summary.attempted += 1;
  if (response.replayed) summary.replayed += 1;
  if (
    response.settings.settingsRevision !== current.settingsRevision + 1 ||
    response.settings.locale !== PORTFOLIO_SETTINGS.locale ||
    response.settings.timezone !== PORTFOLIO_SETTINGS.timezone
  ) {
    fail("fixture_settings_mismatch");
  }
}

type NoteMutationResponse = Awaited<ReturnType<DemoApiClient["createNote"]>>;

function verifyMutationBinding(
  response: NoteMutationResponse,
  expectedNoteId: EntityId<"note"> | undefined,
  expectedRevision: number
): void {
  if (
    (expectedNoteId !== undefined && response.note.id !== expectedNoteId) ||
    response.note.id !== response.revision.noteId ||
    response.note.currentRevision !== expectedRevision ||
    response.revision.revision !== expectedRevision ||
    response.revision.createdAt !== response.note.updatedAt
  ) {
    fail("response_identity_mismatch");
  }
  const noteSnapshot = {
    archivedAt: response.note.archivedAt,
    bodyMarkdown: response.note.bodyMarkdown,
    deletedAt: response.note.deletedAt,
    isOpen: response.note.isOpen,
    links: response.note.links,
    pinnedAt: response.note.pinnedAt,
    privacy: response.note.privacy,
    spaceId: response.note.spaceId,
    structuredData: response.note.structuredData,
    tagIds: response.note.tagIds,
    title: response.note.title,
    type: response.note.type
  };
  const revisionSnapshot = {
    archivedAt: response.revision.archivedAt,
    bodyMarkdown: response.revision.bodyMarkdown,
    deletedAt: response.revision.deletedAt,
    isOpen: response.revision.isOpen,
    links: response.revision.links,
    pinnedAt: response.revision.pinnedAt,
    privacy: response.revision.privacy,
    spaceId: response.revision.spaceId,
    structuredData: response.revision.structuredData,
    tagIds: response.revision.tagIds,
    title: response.revision.title,
    type: response.revision.type
  };
  if (JSON.stringify(noteSnapshot) !== JSON.stringify(revisionSnapshot)) {
    fail("response_revision_mismatch");
  }
}

async function seedPortfolio(
  client: DemoApiClient,
  inventoryValue: Inventory
): Promise<SeedSummary> {
  const existing = expectedMaps(inventoryValue);
  const existingSpaces = mapSpacesByKey(existing.spaces);
  const existingTags = mapTagsByKey(existing.tags);
  const existingNotes = await verifyExistingNotes(
    client,
    existing.notes,
    existingSpaces,
    existingTags
  );
  const mutable = { attempted: 0, replayed: 0, skipped: 0 };
  await createOrReuseMarker(client, existingNotes, existingSpaces, existingTags, mutable);
  await createOrReuseSettings(client, inventoryValue.settings, mutable);
  const spaces = await createOrReuseSpaces(client, existing.spaces, mutable);
  const tags = await createOrReuseTags(client, existing.tags, mutable);
  await createOrReuseNotes(client, existingNotes, spaces, tags, mutable);
  return Object.freeze({
    attemptedWrites: mutable.attempted,
    profile: "portfolio",
    replayedWrites: mutable.replayed,
    skippedWrites: mutable.skipped
  });
}

async function verifyCompletePortfolio(client: DemoApiClient): Promise<void> {
  const verifiedInventory = await inventory(client);
  const expected = expectedMaps(verifiedInventory);
  if (
    expected.spaces.size !== PORTFOLIO_SPACES.length ||
    expected.tags.size !== PORTFOLIO_TAGS.length ||
    expected.notes.size !== PORTFOLIO_NOTES.length
  ) {
    fail("postflight_fixture_incomplete");
  }
  if (
    verifiedInventory.settings.locale !== PORTFOLIO_SETTINGS.locale ||
    verifiedInventory.settings.timezone !== PORTFOLIO_SETTINGS.timezone
  ) {
    fail("fixture_settings_mismatch");
  }
  const spaces = mapSpacesByKey(expected.spaces);
  const tags = mapTagsByKey(expected.tags);
  await verifyExistingNotes(client, expected.notes, spaces, tags, false);
}

function assertFresh(inventoryValue: Inventory): void {
  if (
    inventoryValue.spaces.length > 0 ||
    inventoryValue.tags.length > 0 ||
    inventoryValue.notes.length > 0 ||
    inventoryValue.deletedNotes.length > 0 ||
    inventoryValue.captures.length > 0 ||
    inventoryValue.reviewItems.length > 0 ||
    inventoryValue.routingRuleCount > 0 ||
    inventoryValue.providerKeyConfigured
  ) {
    fail("fresh_account_not_empty");
  }
}

export async function executeSeed(
  client: DemoApiClient,
  config: ExecutionConfig
): Promise<SeedSummary> {
  const session = await client.getAuthSession();
  if (!config.allowedEmails.has(session.user.email)) fail("account_not_allowlisted");
  const inventoryValue = await inventory(client);
  if (config.profile === "fresh") {
    assertFresh(inventoryValue);
    return Object.freeze({
      attemptedWrites: 0,
      profile: "fresh",
      replayedWrites: 0,
      skippedWrites: 0
    });
  }
  const result = await seedPortfolio(client, inventoryValue);
  await verifyCompletePortfolio(client);
  return result;
}

const tokenClearers = new WeakMap<object, () => void>();

function defaultClient(config: ExecutionConfig): DemoApiClient {
  let token: string | null = config.accessToken;
  const client = createApiClient({
    baseUrl: config.origin,
    fetch: createStrictDemoFetch(config.origin, config.accessToken),
    getAccessToken: () => Promise.resolve(token)
  });
  tokenClearers.set(client, () => {
    token = null;
  });
  return client;
}

function clearClientToken(client: DemoApiClient): void {
  tokenClearers.get(client)?.();
  tokenClearers.delete(client);
}

function helpText(): string {
  return [
    "Usage: pnpm demo:seed -- [--profile portfolio|fresh] [--dry-run|--execute]",
    "       [--environment preview|production] [--confirm-production VALUE]",
    "",
    "Default mode is a zero-network Preview dry run. Live credentials and exact allowlists",
    "must be supplied through UNFILED_DEMO_* environment variables, never command arguments.",
    "Live execution requires UNFILED_DEMO_TARGET_ENVIRONMENT to match the selected environment.",
    "The fresh profile verifies an empty dedicated owner and performs no writes."
  ].join("\n");
}

function safeFailure(error: unknown): string {
  if (error instanceof DemoSeedError) return `demo_seed failed code=${error.code}`;
  if (error instanceof ApiClientMalformedResponseError) {
    return `demo_seed failed code=malformed_api_response status=${error.status}`;
  }
  if (error instanceof ApiClientError) {
    return `demo_seed failed code=remote_api_error status=${error.status}`;
  }
  return "demo_seed failed code=unexpected_failure";
}

export async function runSeedCli(
  argv: readonly string[],
  dependencies: SeedCliDependencies = {}
): Promise<number> {
  const environment = dependencies.environment ?? process.env;
  const writeOutput =
    dependencies.writeOutput ?? ((line: string) => process.stdout.write(`${line}\n`));
  const writeError =
    dependencies.writeError ?? ((line: string) => process.stderr.write(`${line}\n`));
  try {
    const options = parseCliOptions(argv);
    if (options.help) {
      writeOutput(helpText());
      return 0;
    }
    if (options.mode === "dry-run") {
      if (options.environment === "production") targetOrigin(environment, options);
      const plannedWrites = options.profile === "portfolio" ? PORTFOLIO_PLANNED_WRITES : 0;
      writeOutput(
        `demo_seed mode=dry-run environment=${options.environment} profile=${options.profile} planned_writes=${plannedWrites} network_requests=0`
      );
      return 0;
    }

    const config = executionConfig(options, environment);
    const client = (dependencies.createClient ?? defaultClient)(config);
    try {
      const result = await executeSeed(client, config);
      writeOutput(
        `demo_seed mode=execute environment=${config.environment} profile=${result.profile} attempted_writes=${result.attemptedWrites} replayed_writes=${result.replayedWrites} skipped_writes=${result.skippedWrites}`
      );
      return 0;
    } finally {
      clearClientToken(client);
    }
  } catch (error) {
    writeError(safeFailure(error));
    return 1;
  }
}
