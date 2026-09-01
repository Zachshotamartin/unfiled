const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;

/**
 * Returns the capture's authoritative Gregorian local date. Invalid instants,
 * unsupported time zones, and non-canonical formatter output fail closed.
 */
export function organizerLocalDate(occurredAt: string, timezone: string): string | null {
  const instant = new Date(occurredAt);
  if (!Number.isFinite(instant.valueOf())) return null;

  try {
    const parts = new Intl.DateTimeFormat("en-CA-u-ca-gregory-nu-latn", {
      calendar: "gregory",
      day: "2-digit",
      month: "2-digit",
      numberingSystem: "latn",
      timeZone: timezone,
      year: "numeric"
    }).formatToParts(instant);
    const values = new Map(parts.map(({ type, value }) => [type, value]));
    const value = `${values.get("year") ?? ""}-${values.get("month") ?? ""}-${values.get("day") ?? ""}`;
    const match = ISO_DATE.exec(value);
    if (match === null) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const check = new Date(Date.UTC(year, month - 1, day));
    return check.getUTCFullYear() === year &&
      check.getUTCMonth() === month - 1 &&
      check.getUTCDate() === day
      ? value
      : null;
  } catch {
    return null;
  }
}
