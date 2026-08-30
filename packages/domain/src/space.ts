import {
  ApiErrorCode,
  SpaceSchema,
  UtcInstantSchema,
  entityIdSchema,
  type EntityId,
  type Space
} from "@unfiled/contracts";

import { deepFreeze } from "./canonical.js";
import { DomainError } from "./errors.js";

export type DomainSpace = Readonly<Space & { userId: string }>;

function normalizedName(value: string): string {
  const name = value.trim().replace(/\s+/gu, " ");
  if (name.length === 0 || name.length > 60) {
    throw new DomainError(ApiErrorCode.VALIDATION_FAILED, "Space name must be 1-60 characters");
  }
  return name;
}

function slugFor(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 80);
  if (slug.length === 0) {
    throw new DomainError(ApiErrorCode.VALIDATION_FAILED, "Space name needs a URL-safe character");
  }
  return slug;
}

function validateParent(
  userId: string,
  parentId: EntityId<"spc"> | null,
  parent: DomainSpace | null | undefined
): void {
  if (parentId === null) return;
  if (parent?.id !== parentId) {
    throw new DomainError(ApiErrorCode.VALIDATION_FAILED, "Parent space must be supplied");
  }
  if (parent.userId !== userId) {
    throw new DomainError(ApiErrorCode.FORBIDDEN, "Parent space belongs to another user");
  }
  if (parent.parentId !== null) {
    throw new DomainError(ApiErrorCode.VALIDATION_FAILED, "Spaces support one nesting level");
  }
}

export function createSpace(
  input: Readonly<{
    id: EntityId<"spc">;
    userId: string;
    name: string;
    now: string;
    parentId?: EntityId<"spc"> | null;
    parent?: DomainSpace | null;
    sortKey?: string;
  }>
): DomainSpace {
  const parentId = input.parentId ?? null;
  validateParent(input.userId, parentId, input.parent);
  const name = normalizedName(input.name);
  const now = UtcInstantSchema.parse(input.now);
  const dto = SpaceSchema.parse({
    id: input.id,
    parentId,
    name,
    slug: slugFor(name),
    sortKey: input.sortKey ?? "a0",
    currentRevision: 1,
    archivedAt: null,
    createdAt: now,
    updatedAt: now
  });
  return deepFreeze({ ...dto, userId: input.userId });
}

export function updateSpace(
  space: DomainSpace,
  input: Readonly<{
    expectedRevision: number;
    now: string;
    name?: string;
    parentId?: EntityId<"spc"> | null;
    parent?: DomainSpace | null;
    sortKey?: string;
  }>
): DomainSpace {
  if (input.expectedRevision !== space.currentRevision) {
    throw new DomainError(
      ApiErrorCode.STALE_REVISION,
      `Expected revision ${input.expectedRevision}, found ${space.currentRevision}`
    );
  }
  const name = input.name === undefined ? space.name : normalizedName(input.name);
  const parentId = input.parentId === undefined ? space.parentId : input.parentId;
  if (input.parentId !== undefined) validateParent(space.userId, parentId, input.parent);
  else if (parentId !== null) entityIdSchema("spc").parse(parentId);
  const { userId, ...current } = space;
  const dto = SpaceSchema.parse({
    ...current,
    parentId,
    name,
    slug: slugFor(name),
    sortKey: input.sortKey ?? space.sortKey,
    currentRevision: space.currentRevision + 1,
    updatedAt: UtcInstantSchema.parse(input.now)
  });
  return deepFreeze({ ...dto, userId });
}

export function archiveSpace(
  space: DomainSpace,
  input: Readonly<{ archived: boolean; expectedRevision: number; now: string }>
): DomainSpace {
  if (input.expectedRevision !== space.currentRevision) {
    throw new DomainError(
      ApiErrorCode.STALE_REVISION,
      `Expected revision ${input.expectedRevision}, found ${space.currentRevision}`
    );
  }
  const now = UtcInstantSchema.parse(input.now);
  const { userId, ...current } = space;
  const dto = SpaceSchema.parse({
    ...current,
    archivedAt: input.archived ? now : null,
    currentRevision: space.currentRevision + 1,
    updatedAt: now
  });
  return deepFreeze({ ...dto, userId });
}
