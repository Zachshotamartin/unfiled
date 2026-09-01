import type { ManualNotesRepository, RepositoryContext } from "./repository";

export const encryptionRolloutStates = Object.freeze([
  "expanded",
  "dual_write",
  "encrypted_read",
  "encrypted_only",
  "contracted"
] as const);

export type EncryptionRolloutState = (typeof encryptionRolloutStates)[number];

export type EncryptionRolloutStateSource = Readonly<{
  stateForOwner(context: RepositoryContext): Promise<EncryptionRolloutState>;
}>;

export type RepositoryMethod = keyof ManualNotesRepository;

export const encryptedRepositoryWriteMethods = Object.freeze([
  "applyOperations",
  "archiveNote",
  "archiveSpace",
  "createLink",
  "createNote",
  "createSpace",
  "createTag",
  "deleteLink",
  "deleteNote",
  "deleteTag",
  "linkTag",
  "moveNote",
  "restoreDeletedNote",
  "restoreRevision",
  "unlinkTag",
  "undoMutation",
  "updateNote",
  "updateSpace",
  "updateTag"
] as const satisfies readonly RepositoryMethod[]);

export const encryptedRepositoryReadMethods = Object.freeze([
  "getNote",
  "listLinks",
  "listNotes",
  "listRevisions",
  "listReviewItems",
  "listSpaces",
  "listTags",
  "search"
] as const satisfies readonly RepositoryMethod[]);

type ClassifiedRepositoryMethod =
  | (typeof encryptedRepositoryReadMethods)[number]
  | (typeof encryptedRepositoryWriteMethods)[number];

export const repositoryMethodClassificationIsExhaustive: Exclude<
  RepositoryMethod,
  ClassifiedRepositoryMethod
> extends never
  ? true
  : never = true;

const WRITE_METHODS = new Set<RepositoryMethod>(encryptedRepositoryWriteMethods);

const POST_ENCRYPTED_READ_STATES = new Set<EncryptionRolloutState>([
  "encrypted_only",
  "contracted"
]);

export type EncryptedRepositoryCapabilityReadiness = Readonly<{
  /**
   * Methods that do not yet have a production encrypted implementation. An
   * owner must not enter a no-rollback state while this set is non-empty.
   */
  unavailableMethods: readonly RepositoryMethod[];
}>;

/**
 * A content-free failure used when database rollout state has advanced beyond
 * the complete capability surface deployed by the web application.
 */
export class EncryptedRepositoryCapabilityUnavailableError extends Error {
  public constructor() {
    super("The encrypted repository capability set is not ready for this rollout state");
    this.name = "EncryptedRepositoryCapabilityUnavailableError";
  }
}

/**
 * Keeps irreversible rollout states coupled to the application's complete
 * encrypted capability surface. The authoritative database lookup still runs
 * for every repository operation; lookup errors and readiness errors both
 * propagate without selecting the legacy repository.
 */
export class CapabilityGuardedEncryptionRolloutStateSource implements EncryptionRolloutStateSource {
  private readonly unavailableMethods: ReadonlySet<RepositoryMethod>;

  public constructor(
    private readonly source: EncryptionRolloutStateSource,
    readiness: EncryptedRepositoryCapabilityReadiness
  ) {
    this.unavailableMethods = new Set(readiness.unavailableMethods);
  }

  public async stateForOwner(context: RepositoryContext): Promise<EncryptionRolloutState> {
    const state = await this.source.stateForOwner(context);
    if (POST_ENCRYPTED_READ_STATES.has(state) && this.unavailableMethods.size > 0) {
      throw new EncryptedRepositoryCapabilityUnavailableError();
    }
    return state;
  }
}

export function rolloutRepositoryTarget(
  state: EncryptionRolloutState,
  method: RepositoryMethod
): "encrypted" | "legacy" {
  if (state === "expanded") return "legacy";
  if (state === "dual_write" && !WRITE_METHODS.has(method)) return "legacy";
  return "encrypted";
}

function repositoryFor(
  state: EncryptionRolloutState,
  method: RepositoryMethod,
  legacy: ManualNotesRepository,
  encrypted: ManualNotesRepository
): ManualNotesRepository {
  return rolloutRepositoryTarget(state, method) === "encrypted" ? encrypted : legacy;
}

/**
 * Routes one authenticated owner's complete repository surface through the
 * database-controlled encryption rollout. State lookup errors intentionally
 * propagate: an unavailable rollout store must never downgrade a request to a
 * plaintext adapter.
 */
export class RolloutAwareManualNotesRepository implements ManualNotesRepository {
  public constructor(
    private readonly rollout: EncryptionRolloutStateSource,
    private readonly legacy: ManualNotesRepository,
    private readonly encrypted: ManualNotesRepository
  ) {}

  private async selected(
    context: RepositoryContext,
    method: RepositoryMethod
  ): Promise<ManualNotesRepository> {
    const state = await this.rollout.stateForOwner(context);
    return repositoryFor(state, method, this.legacy, this.encrypted);
  }

  public async archiveNote(...parameters: Parameters<ManualNotesRepository["archiveNote"]>) {
    return (await this.selected(parameters[0], "archiveNote")).archiveNote(...parameters);
  }

  public async archiveSpace(...parameters: Parameters<ManualNotesRepository["archiveSpace"]>) {
    return (await this.selected(parameters[0], "archiveSpace")).archiveSpace(...parameters);
  }

  public async createLink(...parameters: Parameters<ManualNotesRepository["createLink"]>) {
    return (await this.selected(parameters[0], "createLink")).createLink(...parameters);
  }

  public async createNote(...parameters: Parameters<ManualNotesRepository["createNote"]>) {
    return (await this.selected(parameters[0], "createNote")).createNote(...parameters);
  }

  public async createSpace(...parameters: Parameters<ManualNotesRepository["createSpace"]>) {
    return (await this.selected(parameters[0], "createSpace")).createSpace(...parameters);
  }

  public async createTag(...parameters: Parameters<ManualNotesRepository["createTag"]>) {
    return (await this.selected(parameters[0], "createTag")).createTag(...parameters);
  }

  public async deleteLink(...parameters: Parameters<ManualNotesRepository["deleteLink"]>) {
    return (await this.selected(parameters[0], "deleteLink")).deleteLink(...parameters);
  }

  public async deleteNote(...parameters: Parameters<ManualNotesRepository["deleteNote"]>) {
    return (await this.selected(parameters[0], "deleteNote")).deleteNote(...parameters);
  }

  public async deleteTag(...parameters: Parameters<ManualNotesRepository["deleteTag"]>) {
    return (await this.selected(parameters[0], "deleteTag")).deleteTag(...parameters);
  }

  public async getNote(...parameters: Parameters<ManualNotesRepository["getNote"]>) {
    return (await this.selected(parameters[0], "getNote")).getNote(...parameters);
  }

  public async linkTag(...parameters: Parameters<ManualNotesRepository["linkTag"]>) {
    return (await this.selected(parameters[0], "linkTag")).linkTag(...parameters);
  }

  public async listLinks(...parameters: Parameters<ManualNotesRepository["listLinks"]>) {
    return (await this.selected(parameters[0], "listLinks")).listLinks(...parameters);
  }

  public async listNotes(...parameters: Parameters<ManualNotesRepository["listNotes"]>) {
    return (await this.selected(parameters[0], "listNotes")).listNotes(...parameters);
  }

  public async listRevisions(...parameters: Parameters<ManualNotesRepository["listRevisions"]>) {
    return (await this.selected(parameters[0], "listRevisions")).listRevisions(...parameters);
  }

  public async listReviewItems(
    ...parameters: Parameters<ManualNotesRepository["listReviewItems"]>
  ) {
    return (await this.selected(parameters[0], "listReviewItems")).listReviewItems(...parameters);
  }

  public async listSpaces(...parameters: Parameters<ManualNotesRepository["listSpaces"]>) {
    return (await this.selected(parameters[0], "listSpaces")).listSpaces(...parameters);
  }

  public async listTags(...parameters: Parameters<ManualNotesRepository["listTags"]>) {
    return (await this.selected(parameters[0], "listTags")).listTags(...parameters);
  }

  public async moveNote(...parameters: Parameters<ManualNotesRepository["moveNote"]>) {
    return (await this.selected(parameters[0], "moveNote")).moveNote(...parameters);
  }

  public async restoreDeletedNote(
    ...parameters: Parameters<ManualNotesRepository["restoreDeletedNote"]>
  ) {
    return (await this.selected(parameters[0], "restoreDeletedNote")).restoreDeletedNote(
      ...parameters
    );
  }

  public async restoreRevision(
    ...parameters: Parameters<ManualNotesRepository["restoreRevision"]>
  ) {
    return (await this.selected(parameters[0], "restoreRevision")).restoreRevision(...parameters);
  }

  public async search(...parameters: Parameters<ManualNotesRepository["search"]>) {
    return (await this.selected(parameters[0], "search")).search(...parameters);
  }

  public async unlinkTag(...parameters: Parameters<ManualNotesRepository["unlinkTag"]>) {
    return (await this.selected(parameters[0], "unlinkTag")).unlinkTag(...parameters);
  }

  public async undoMutation(...parameters: Parameters<ManualNotesRepository["undoMutation"]>) {
    return (await this.selected(parameters[0], "undoMutation")).undoMutation(...parameters);
  }

  public async updateNote(...parameters: Parameters<ManualNotesRepository["updateNote"]>) {
    return (await this.selected(parameters[0], "updateNote")).updateNote(...parameters);
  }

  public async updateSpace(...parameters: Parameters<ManualNotesRepository["updateSpace"]>) {
    return (await this.selected(parameters[0], "updateSpace")).updateSpace(...parameters);
  }

  public async updateTag(...parameters: Parameters<ManualNotesRepository["updateTag"]>) {
    return (await this.selected(parameters[0], "updateTag")).updateTag(...parameters);
  }

  public async applyOperations(
    ...parameters: Parameters<ManualNotesRepository["applyOperations"]>
  ) {
    return (await this.selected(parameters[0], "applyOperations")).applyOperations(...parameters);
  }
}
