const MICROS_PER_SECOND = 1_000_000n;

type Failure = () => never;

export function canonicalUtcTimestampFromMicros(micros: bigint, failure: Failure): string {
  const wholeSeconds =
    micros >= 0n
      ? micros / MICROS_PER_SECOND
      : (micros - (MICROS_PER_SECOND - 1n)) / MICROS_PER_SECOND;
  const fractionalMicros = micros - wholeSeconds * MICROS_PER_SECOND;
  const milliseconds = wholeSeconds * 1_000n;
  if (
    milliseconds > BigInt(Number.MAX_SAFE_INTEGER) ||
    milliseconds < BigInt(Number.MIN_SAFE_INTEGER)
  )
    return failure();

  const instant = new Date(Number(milliseconds));
  if (!Number.isFinite(instant.valueOf())) return failure();
  const iso = instant.toISOString();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(iso)) return failure();
  const microsDigits = fractionalMicros.toString().padStart(6, "0");
  const fraction = `${microsDigits.slice(0, 3)}${microsDigits.slice(3).replace(/0+$/u, "")}`;
  return `${iso.slice(0, 19)}.${fraction}Z`;
}
