import { ManagedNoteContextRepository } from "./managed-note-context-repository";
import type { NoteContextRepository } from "./repository";

export function createProductionNoteContextRepository(options?: {
  signalForOperation?: () => AbortSignal;
}): NoteContextRepository {
  return new ManagedNoteContextRepository({
    ...(options?.signalForOperation === undefined
      ? {}
      : { signalForOperation: options.signalForOperation })
  });
}
