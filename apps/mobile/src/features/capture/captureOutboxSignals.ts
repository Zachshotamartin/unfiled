type DrainListener = () => void;

const listeners = new Set<DrainListener>();

export function requestCaptureOutboxDrain(): void {
  for (const listener of listeners) listener();
}

export function subscribeToCaptureOutboxDrain(listener: DrainListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
