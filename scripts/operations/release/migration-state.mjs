// What the Supabase CLI says about production's migrations, read strictly. The release used to
// take the last JSON line of `db push --dry-run`, read `.migrations`, and treat anything it could
// not read as "schema is already current". On 2026-09-04 that shipped five services built against
// a migration that had never been applied, and every capture in production answered 400. Nothing
// here treats an unreadable answer as a safe one.

/** The JSON summary the CLI prints as its last stdout line, or null when there is none. */
function summaryLine(stdout) {
  const line = String(stdout ?? "")
    .trim()
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith("{"))
    .pop();
  if (line === undefined) return null;
  try {
    const value = JSON.parse(line);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * The migrations a dry run would push. Throws when the answer cannot be read: an unreadable
 * state is a reason to stop, never a reason to deploy.
 *
 * The CLI answers `{"upToDate":true|false,"dryRun":true,"migrations":[...]}` on stdout and lists
 * the same files on stderr under "Would push these migrations:", so the two are cross-checked and
 * a disagreement is also a stop.
 */
export function pendingMigrationsFromDryRun({ stdout, stderr }) {
  const summary = summaryLine(stdout);
  if (summary === null || typeof summary.upToDate !== "boolean") {
    throw new Error("Could not read the production migration state from the dry run.");
  }
  const listed = Array.isArray(summary.migrations)
    ? summary.migrations.filter((entry) => typeof entry === "string")
    : null;
  if (listed === null) {
    throw new Error("The dry run named no migration list.");
  }
  const announced = /Would push these migrations:/u.test(String(stderr ?? ""));
  if (summary.upToDate && (listed.length > 0 || announced)) {
    throw new Error("The dry run calls the schema current and lists pending migrations at once.");
  }
  if (!summary.upToDate && listed.length === 0) {
    throw new Error("The dry run calls the schema stale without naming a migration.");
  }
  return Object.freeze(listed);
}

/**
 * Local migration files with no remote entry, from `migration list`. This is what decides
 * whether code may deploy: the answer comes from the database's own migration table, not from a
 * prediction, so a push that silently did nothing cannot pass as done.
 */
export function unappliedMigrationsFromList(stdout) {
  const summary = summaryLine(stdout);
  if (summary === null || !Array.isArray(summary.migrations)) {
    throw new Error("Could not read the production migration list.");
  }
  const unapplied = [];
  for (const entry of summary.migrations) {
    if (entry === null || typeof entry !== "object") {
      throw new Error("The migration list carried an entry that is not a record.");
    }
    const local = typeof entry.local === "string" ? entry.local : "";
    const remote = typeof entry.remote === "string" ? entry.remote : "";
    if (local !== "" && remote === "") unapplied.push(local);
  }
  return Object.freeze(unapplied);
}
