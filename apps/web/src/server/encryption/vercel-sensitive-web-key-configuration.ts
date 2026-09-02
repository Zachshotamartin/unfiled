import {
  parseVercelSensitiveEnvironmentRetiredRootKeySet,
  parseVercelSensitiveEnvironmentRootKeySet,
  type VercelSensitiveEnvironmentRetiredRootKeySet,
  type VercelSensitiveEnvironmentRootKeySet
} from "@unfiled/key-management";

import { ConfigurationError } from "@/server/api/errors";

export const VERCEL_SENSITIVE_WEB_CUSTODIAN_MODE = "vercel-sensitive-env-v1";
export const VERCEL_SENSITIVE_WEB_ROOT_REGISTRY_VARIABLE = "UNFILED_WEB_ROOT_KEY_REGISTRY_V2_JSON";
export const VERCEL_SENSITIVE_ROOT_KEY_RING_VARIABLE =
  "UNFILED_VERCEL_SENSITIVE_ENV_ROOT_KEY_RING_V1";

const CUSTODY_PROVIDER = "vercel_sensitive_environment_v1";
const MAX_ROOT_REGISTRY_BYTES = 65_536;
const MAX_ROOT_GENERATIONS = 88;
const MAX_RETIRED_ROOTS_PER_PAIR = 20;
const MAX_GENERATION = 2_147_483_647;
const VERCEL_PROJECT_ID_PATTERN = /^prj_[A-Za-z0-9]{6,100}$/u;
const PRODUCTION_ROOT_KEY_ID_PATTERN =
  /^urn:unfiled:key-root:vercel-sensitive-env-v1:production:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const KEY_CLASSES = ["ai_assisted", "private_manual"] as const;
const KEY_PURPOSES = ["object_wrap", "content_mac"] as const;
const ROOT_STATUSES = ["active", "retired", "staged"] as const;

type WebKeyClass = (typeof KEY_CLASSES)[number];
type WebKeyPurpose = (typeof KEY_PURPOSES)[number];
type WebRootStatus = (typeof ROOT_STATUSES)[number];
type PairId = `${WebKeyClass}/${WebKeyPurpose}`;

const PAIRS = Object.freeze(
  KEY_CLASSES.flatMap((keyClass) => KEY_PURPOSES.map((purpose): PairId => `${keyClass}/${purpose}`))
);

export type VercelSensitiveWebRootKeySet = VercelSensitiveEnvironmentRootKeySet;
export type VercelSensitiveWebRetiredRootKeySet = VercelSensitiveEnvironmentRetiredRootKeySet;

export type VercelSensitiveWebKeyConfiguration = Readonly<{
  activeRoots: VercelSensitiveWebRootKeySet;
  expectedRootKeyIds: readonly string[];
  retiredRoots: VercelSensitiveWebRetiredRootKeySet;
}>;

type RegistryEntry = Readonly<{
  generation: number;
  keyClass: WebKeyClass;
  purpose: WebKeyPurpose;
  rootKeyId: string;
  status: WebRootStatus;
}>;

function configurationFailure(): never {
  throw new ConfigurationError();
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[]
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function includes<const Values extends readonly string[]>(
  values: Values,
  value: unknown
): value is Values[number] {
  return typeof value === "string" && values.includes(value);
}

function parseEntry(registryId: string, value: unknown): RegistryEntry {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["generation", "keyClass", "purpose", "rootKeyId", "status"]) ||
    !Number.isSafeInteger(value.generation) ||
    Number(value.generation) < 1 ||
    Number(value.generation) > MAX_GENERATION ||
    !includes(KEY_CLASSES, value.keyClass) ||
    !includes(KEY_PURPOSES, value.purpose) ||
    typeof value.rootKeyId !== "string" ||
    !PRODUCTION_ROOT_KEY_ID_PATTERN.test(value.rootKeyId) ||
    !includes(ROOT_STATUSES, value.status)
  ) {
    configurationFailure();
  }
  const generation = Number(value.generation);
  if (registryId !== `${value.keyClass}_${value.purpose}_v${generation}`) {
    configurationFailure();
  }
  return Object.freeze({
    generation,
    keyClass: value.keyClass,
    purpose: value.purpose,
    rootKeyId: value.rootKeyId,
    status: value.status
  });
}

function parseRegistry(raw: string | undefined, projectId: string): readonly RegistryEntry[] {
  if (raw?.trim() !== raw) configurationFailure();
  if (raw === undefined || new TextEncoder().encode(raw).byteLength > MAX_ROOT_REGISTRY_BYTES) {
    configurationFailure();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    configurationFailure();
  }
  if (JSON.stringify(parsed) !== raw || !isRecord(parsed)) configurationFailure();
  if (
    !hasExactKeys(parsed, [
      "version",
      "custodyProvider",
      "projectId",
      "deploymentEnvironment",
      "roots"
    ]) ||
    parsed.version !== 2 ||
    parsed.custodyProvider !== CUSTODY_PROVIDER ||
    parsed.projectId !== projectId ||
    parsed.deploymentEnvironment !== "production" ||
    !isRecord(parsed.roots)
  ) {
    configurationFailure();
  }
  const records = Object.entries(parsed.roots);
  if (records.length < PAIRS.length || records.length > MAX_ROOT_GENERATIONS) {
    configurationFailure();
  }
  const entries = records.map(([registryId, value]) => parseEntry(registryId, value));
  const rootIds = new Set<string>();
  const generations = new Set<string>();
  for (const entry of entries) {
    const generation = `${entry.keyClass}/${entry.purpose}/${entry.generation}`;
    if (rootIds.has(entry.rootKeyId) || generations.has(generation)) configurationFailure();
    rootIds.add(entry.rootKeyId);
    generations.add(generation);
  }
  return Object.freeze(entries);
}

function buildRootSets(entries: readonly RegistryEntry[]): VercelSensitiveWebKeyConfiguration {
  const byPair = new Map<PairId, RegistryEntry[]>(PAIRS.map((pair) => [pair, []]));
  for (const entry of entries) {
    byPair.get(`${entry.keyClass}/${entry.purpose}`)?.push(entry);
  }

  const activeRoots: Record<WebKeyClass, Record<WebKeyPurpose, string>> = {
    ai_assisted: { content_mac: "", object_wrap: "" },
    private_manual: { content_mac: "", object_wrap: "" }
  };
  const retiredRoots: Record<WebKeyClass, Record<WebKeyPurpose, string[]>> = {
    ai_assisted: { content_mac: [], object_wrap: [] },
    private_manual: { content_mac: [], object_wrap: [] }
  };

  for (const pair of PAIRS) {
    const [keyClass, purpose] = pair.split("/") as [WebKeyClass, WebKeyPurpose];
    const pairEntries = byPair.get(pair) ?? [];
    const active = pairEntries.filter((entry) => entry.status === "active");
    const retired = pairEntries.filter((entry) => entry.status === "retired");
    const staged = pairEntries.filter((entry) => entry.status === "staged");
    if (active.length !== 1 || retired.length > MAX_RETIRED_ROOTS_PER_PAIR || staged.length > 1) {
      configurationFailure();
    }
    const activeEntry = active[0];
    if (activeEntry === undefined) configurationFailure();
    if (
      retired.some((entry) => entry.generation >= activeEntry.generation) ||
      staged.some((entry) => entry.generation <= activeEntry.generation)
    ) {
      configurationFailure();
    }
    activeRoots[keyClass][purpose] = activeEntry.rootKeyId;
    retiredRoots[keyClass][purpose].push(...retired.map((entry) => entry.rootKeyId));
  }

  const active = Object.freeze({
    ai_assisted: Object.freeze({ ...activeRoots.ai_assisted }),
    private_manual: Object.freeze({ ...activeRoots.private_manual })
  });
  const retired = Object.freeze({
    ai_assisted: Object.freeze({
      content_mac: Object.freeze([...retiredRoots.ai_assisted.content_mac]),
      object_wrap: Object.freeze([...retiredRoots.ai_assisted.object_wrap])
    }),
    private_manual: Object.freeze({
      content_mac: Object.freeze([...retiredRoots.private_manual.content_mac]),
      object_wrap: Object.freeze([...retiredRoots.private_manual.object_wrap])
    })
  });
  try {
    const parsedActive = parseVercelSensitiveEnvironmentRootKeySet(active, "production");
    const parsedRetired = parseVercelSensitiveEnvironmentRetiredRootKeySet(
      retired,
      parsedActive,
      "production"
    );
    return Object.freeze({
      activeRoots: parsedActive,
      expectedRootKeyIds: Object.freeze(entries.map((entry) => entry.rootKeyId)),
      retiredRoots: parsedRetired
    });
  } catch {
    configurationFailure();
  }
}

export function parseVercelSensitiveWebKeyConfiguration(
  environment: Readonly<Record<string, string | undefined>>
): VercelSensitiveWebKeyConfiguration {
  const projectId = environment.VERCEL_PROJECT_ID;
  if (
    environment.NODE_ENV !== "production" ||
    environment.VERCEL !== "1" ||
    environment.VERCEL_ENV !== "production" ||
    environment.UNFILED_KEY_CUSTODIAN !== VERCEL_SENSITIVE_WEB_CUSTODIAN_MODE ||
    projectId === undefined ||
    !VERCEL_PROJECT_ID_PATTERN.test(projectId)
  ) {
    configurationFailure();
  }
  return buildRootSets(
    parseRegistry(environment[VERCEL_SENSITIVE_WEB_ROOT_REGISTRY_VARIABLE], projectId)
  );
}
