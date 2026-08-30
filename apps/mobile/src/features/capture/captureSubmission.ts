export interface CaptureSubmissionDependencies<T> {
  persist(): Promise<T>;
  sideEffects: readonly ((value: T) => Promise<void>)[];
}

export type CaptureSubmissionResult<T> =
  | {
      error: unknown;
      status: "commit_failed";
    }
  | {
      effects: Promise<PromiseSettledResult<void>[]>;
      status: "saved";
      value: T;
    };

export async function submitCapture<T>(
  dependencies: CaptureSubmissionDependencies<T>
): Promise<CaptureSubmissionResult<T>> {
  let value: T;
  try {
    value = await dependencies.persist();
  } catch (error) {
    return { error, status: "commit_failed" };
  }

  const effects = Promise.allSettled(
    dependencies.sideEffects.map((effect) => Promise.resolve().then(() => effect(value)))
  );
  return { effects, status: "saved", value };
}
