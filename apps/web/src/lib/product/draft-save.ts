export type DraftSaveAttempt = Readonly<{
  fingerprint: string;
  idempotencyKey: string;
}>;

export function draftSaveAttempt(
  previous: DraftSaveAttempt | null,
  fingerprint: string,
  createKey: () => string
): DraftSaveAttempt {
  if (previous?.fingerprint === fingerprint) return previous;
  return { fingerprint, idempotencyKey: createKey() };
}
