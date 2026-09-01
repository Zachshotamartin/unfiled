import { describe, expect, it } from "vitest";

import { parseOrganizerDatabaseUrl } from "../src/database-url.js";

const projectRef = "abcdefghijklmnopqrst";
const host = "aws-0-us-west-2.pooler.supabase.com";
const password = "a-secure-database-password";
function parse(url: string, overrides: Partial<{ expectedHost: string; projectRef: string }> = {}) {
  return parseOrganizerDatabaseUrl({ expectedHost: host, projectRef, url, ...overrides });
}

describe("exact organizer database URL", () => {
  it("accepts only the dedicated shared-pooler identity", () => {
    expect(
      parse(
        `postgresql://unfiled_organizer_worker.${projectRef}:${password}@${host}:6543/postgres?sslmode=verify-full`
      )
    ).toEqual({
      database: "postgres",
      host,
      password,
      port: 6543,
      user: `unfiled_organizer_worker.${projectRef}`
    });
  });
  it("accepts exact direct transport identity", () => {
    const direct = `db.${projectRef}.supabase.co`;
    expect(
      parseOrganizerDatabaseUrl({
        expectedHost: direct,
        projectRef,
        url: `postgresql://unfiled_organizer_worker:${password}@${direct}:5432/postgres?sslmode=verify-full`
      })
    ).toMatchObject({ host: direct, port: 5432, user: "unfiled_organizer_worker" });
  });
  it.each([
    "not-a-url",
    `postgresql://postgres:${password}@${host}:6543/postgres?sslmode=verify-full`,
    `postgresql://unfiled_index_worker.${projectRef}:${password}@${host}:6543/postgres?sslmode=verify-full`,
    `postgresql://unfiled_organizer_worker.${projectRef}:short@${host}:6543/postgres?sslmode=verify-full`,
    `postgresql://unfiled_organizer_worker.${projectRef}:${password}@127.0.0.1:6543/postgres?sslmode=verify-full`,
    `postgresql://unfiled_organizer_worker.${projectRef}:${password}@${host}:5433/postgres?sslmode=verify-full`,
    `postgresql://unfiled_organizer_worker.${projectRef}:${password}@${host}:6543/other?sslmode=verify-full`,
    `postgresql://unfiled_organizer_worker.${projectRef}:${password}@${host}:6543/postgres?sslmode=disable`,
    `postgresql://unfiled_organizer_worker.${projectRef}:${password}@${host}:6543/postgres?sslmode=verify-full&x=1`,
    `postgresql://unfiled_organizer_worker.${projectRef}:${password}@${host}:6543/postgres?sslmode=verify-full#fragment`
  ])("rejects unsafe URL %s", (url) => expect(() => parse(url)).toThrow("configuration"));
  it("rejects host/project-ref drift and malformed escaping", () => {
    expect(() =>
      parse(
        `postgresql://unfiled_organizer_worker.${projectRef}:${password}@${host}:6543/postgres?sslmode=verify-full`,
        { expectedHost: "other.pooler.supabase.com" }
      )
    ).toThrow();
    expect(() =>
      parse(
        `postgresql://unfiled_organizer_worker.${projectRef}:${password}@${host}:6543/postgres?sslmode=verify-full`,
        { projectRef: "bad" }
      )
    ).toThrow();
    expect(() =>
      parse(
        `postgresql://unfiled_organizer_worker.${projectRef}:%ZZ@${host}:6543/postgres?sslmode=verify-full`
      )
    ).toThrow();
  });
});
