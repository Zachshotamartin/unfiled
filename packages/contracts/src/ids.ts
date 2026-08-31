import { ulid } from "ulid";
import { z } from "zod";

export const entityPrefixes = {
  blk: "blk",
  cap: "cap",
  chk: "chk",
  dec: "dec",
  ent: "ent",
  evt: "evt",
  fbk: "fbk",
  itm: "itm",
  job: "job",
  key: "key",
  lnk: "lnk",
  mut: "mut",
  note: "note",
  rev: "rev",
  rule: "rule",
  rvw: "rvw",
  spc: "spc",
  tag: "tag"
} as const;

export const EntityKindSchema = z.enum(
  Object.keys(entityPrefixes) as [keyof typeof entityPrefixes, ...(keyof typeof entityPrefixes)[]]
);

export type EntityKind = z.infer<typeof EntityKindSchema>;
export type EntityId<K extends EntityKind = EntityKind> = `${K}_${string}`;

const ulidPattern = /^[0-9A-HJKMNP-TV-Z]{26}$/u;

export function createEntityId<K extends EntityKind>(kind: K): EntityId<K> {
  return `${entityPrefixes[kind]}_${ulid()}` as EntityId<K>;
}

export function parseEntityId<K extends EntityKind>(
  value: string,
  expectedKind: K
): { kind: K; ulid: string } {
  const prefix = `${entityPrefixes[expectedKind]}_`;
  const suffix = value.slice(prefix.length);

  if (!value.startsWith(prefix) || !ulidPattern.test(suffix)) {
    throw new TypeError(`invalid_${expectedKind}_id`);
  }

  return { kind: expectedKind, ulid: suffix };
}

export function entityIdSchema<K extends EntityKind>(kind: K) {
  const pattern = new RegExp(`^${entityPrefixes[kind]}_[0-9A-HJKMNP-TV-Z]{26}$`, "u");
  return z.string().regex(pattern, `Expected a ${kind} identifier`) as z.ZodType<
    EntityId<K>,
    string
  >;
}
