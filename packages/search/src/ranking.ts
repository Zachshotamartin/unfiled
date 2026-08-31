export type SearchSignals = Readonly<{
  fullText: number;
  trigram: number;
  vector: number | null;
  recency: number;
  titleExact: number;
  pinned: boolean;
  privateManual: boolean;
}>;

function finiteClamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export function rankSearchResult(signals: SearchSignals): number {
  const vector = signals.privateManual ? 0 : (signals.vector ?? 0);
  const base =
    0.35 * finiteClamp01(signals.fullText) +
    0.15 * finiteClamp01(signals.trigram) +
    0.3 * finiteClamp01(vector) +
    0.1 * finiteClamp01(signals.recency) +
    0.1 * finiteClamp01(signals.titleExact);
  return finiteClamp01(base * (signals.pinned ? 1.2 : 1));
}

export function embeddingAllowed(privateManual: boolean): boolean {
  return !privateManual;
}
