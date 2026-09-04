import { describe, expect, it } from "vitest";

import { pendingMigrationsFromDryRun, unappliedMigrationsFromList } from "./migration-state.mjs";

// These are the CLI's answers verbatim, captured against the linked project on 2026-09-04.
const CURRENT = {
  stdout:
    '{"upToDate":true,"dryRun":true,"migrations":[],"seeds":[],"roles":[],"message":"Remote database is up to date."}\n',
  stderr:
    "Initialising login role...\nDRY RUN: migrations will *not* be pushed to the database.\nConnecting to remote database...\n"
};
const PENDING = {
  stdout:
    '{"upToDate":false,"dryRun":true,"migrations":["20260904000000_capture_prompt_version_from_caller.sql"],"seeds":[],"roles":[],"message":"Finished supabase db push."}\n',
  stderr:
    "Connecting to remote database...\nWould push these migrations:\n • 20260904000000_capture_prompt_version_from_caller.sql\n"
};

describe("pendingMigrationsFromDryRun", () => {
  it("reads an up-to-date schema as nothing pending", () => {
    expect(pendingMigrationsFromDryRun(CURRENT)).toEqual([]);
  });

  it("reads the pending migrations the CLI names", () => {
    expect(pendingMigrationsFromDryRun(PENDING)).toEqual([
      "20260904000000_capture_prompt_version_from_caller.sql"
    ]);
  });

  // The failure this exists for: an answer the release could not read used to deploy anyway.
  it("refuses an answer it cannot read instead of calling the schema current", () => {
    expect(() => pendingMigrationsFromDryRun({ stdout: "", stderr: "" })).toThrow(
      /Could not read/u
    );
    expect(() =>
      pendingMigrationsFromDryRun({ stdout: "Connecting to remote database...\n", stderr: "" })
    ).toThrow(/Could not read/u);
    expect(() => pendingMigrationsFromDryRun({ stdout: '{"message":"ok"}\n', stderr: "" })).toThrow(
      /Could not read/u
    );
    expect(() =>
      pendingMigrationsFromDryRun({ stdout: '{"upToDate":false,"dryRun":true}\n', stderr: "" })
    ).toThrow(/no migration list/u);
  });

  it("refuses a summary that contradicts itself or its own stderr", () => {
    expect(() =>
      pendingMigrationsFromDryRun({
        stdout: '{"upToDate":true,"dryRun":true,"migrations":["x.sql"]}\n',
        stderr: ""
      })
    ).toThrow(/at once/u);
    expect(() =>
      pendingMigrationsFromDryRun({ stdout: CURRENT.stdout, stderr: PENDING.stderr })
    ).toThrow(/at once/u);
    expect(() =>
      pendingMigrationsFromDryRun({
        stdout: '{"upToDate":false,"dryRun":true,"migrations":[]}\n',
        stderr: ""
      })
    ).toThrow(/without naming/u);
  });
});

describe("unappliedMigrationsFromList", () => {
  const list =
    '{"migrations":[{"local":"20260903000004","remote":"20260903000004","time":"2026-09-03 00:00:04"},{"local":"20260904000000","remote":"","time":"2026-09-04 00:00:00"}],"message":"Migrations listed"}\n';

  it("names every local migration the database has not recorded", () => {
    expect(unappliedMigrationsFromList(list)).toEqual(["20260904000000"]);
  });

  it("is empty only when every local migration has a remote entry", () => {
    expect(
      unappliedMigrationsFromList(
        '{"migrations":[{"local":"20260904000000","remote":"20260904000000","time":"t"}]}\n'
      )
    ).toEqual([]);
  });

  it("refuses a list it cannot read", () => {
    expect(() => unappliedMigrationsFromList("")).toThrow(/Could not read/u);
    expect(() => unappliedMigrationsFromList('{"message":"ok"}\n')).toThrow(/Could not read/u);
  });
});
