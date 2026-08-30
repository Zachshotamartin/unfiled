import { createEntityId, type EntityId, type EntityKind } from "@unfiled/contracts";

export type EntityIdFactory = <K extends EntityKind>(kind: K) => EntityId<K>;

export const systemEntityIdFactory: EntityIdFactory = createEntityId;
