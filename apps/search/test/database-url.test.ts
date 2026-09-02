import { describe, expect, it } from "vitest";

import { parseSearchDatabaseUrl } from "../src/database-url.js";

const PROJECT_REF = "abcdefghijklmnopqrst";
const SHARED_HOST = "aws-0-us-west-2.pooler.supabase.com";
const DIRECT_HOST = `db.${PROJECT_REF}.supabase.co`;
const SHARED_USER = `unfiled_search_worker.${PROJECT_REF}`;
const PASSWORD = "dedicated-search-worker-password";

function parse(url: string, overrides: Partial<{ expectedHost: string; projectRef: string }> = {}) {
  return parseSearchDatabaseUrl({
    expectedHost: SHARED_HOST,
    projectRef: PROJECT_REF,
    url,
    ...overrides
  });
}

describe("dedicated search-worker PostgreSQL URL", () => {
  it("accepts only the project-bound shared-pooler identity over verify-full TLS", () => {
    expect(
      parse(
        `postgresql://${SHARED_USER}:${PASSWORD}@${SHARED_HOST}:6543/postgres?sslmode=verify-full`
      )
    ).toEqual({
      database: "postgres",
      host: SHARED_HOST,
      password: PASSWORD,
      port: 6_543,
      user: SHARED_USER
    });
    expect(
      parse(
        `postgresql://${SHARED_USER}:${PASSWORD}@${SHARED_HOST}:5432/postgres?sslmode=verify-full`
      ).port
    ).toBe(5_432);
  });

  it("accepts the unsuffixed role only on the exact project direct endpoint", () => {
    expect(
      parse(
        `postgresql://unfiled_search_worker:${PASSWORD}@${DIRECT_HOST}:5432/postgres?sslmode=verify-full`,
        { expectedHost: DIRECT_HOST }
      )
    ).toEqual({
      database: "postgres",
      host: DIRECT_HOST,
      password: PASSWORD,
      port: 5_432,
      user: "unfiled_search_worker"
    });
  });

  it.each([
    `postgresql://unfiled_search_worker:${PASSWORD}@${SHARED_HOST}:6543/postgres?sslmode=verify-full`,
    `postgresql://unfiled_search_worker.zyxwvutsrqponmlkjihg:${PASSWORD}@${SHARED_HOST}:6543/postgres?sslmode=verify-full`,
    `postgresql://unfiled_organizer_worker.${PROJECT_REF}:${PASSWORD}@${SHARED_HOST}:6543/postgres?sslmode=verify-full`,
    `postgresql://unfiled_index_worker.${PROJECT_REF}:${PASSWORD}@${SHARED_HOST}:6543/postgres?sslmode=verify-full`,
    `postgresql://unfiled_rag_verifier.${PROJECT_REF}:${PASSWORD}@${SHARED_HOST}:6543/postgres?sslmode=verify-full`,
    `postgresql://service_role.${PROJECT_REF}:${PASSWORD}@${SHARED_HOST}:6543/postgres?sslmode=verify-full`,
    `postgresql://postgres.${PROJECT_REF}:${PASSWORD}@${SHARED_HOST}:6543/postgres?sslmode=verify-full`,
    `postgresql://${SHARED_USER}:short@${SHARED_HOST}:6543/postgres?sslmode=verify-full`,
    `postgresql://${SHARED_USER}:@${SHARED_HOST}:6543/postgres?sslmode=verify-full`
  ])("rejects an over-capable, tenant-drifted, or weak identity: %s", (url) => {
    expect(() => parse(url)).toThrow("not configured");
  });

  it.each([
    "not-a-url",
    `postgres://${SHARED_USER}:${PASSWORD}@${SHARED_HOST}:6543/postgres?sslmode=verify-full`,
    `postgresql://${SHARED_USER}:${PASSWORD}@${SHARED_HOST}:6543/postgres`,
    `postgresql://${SHARED_USER}:${PASSWORD}@${SHARED_HOST}:6543/postgres?sslmode=require`,
    `postgresql://${SHARED_USER}:${PASSWORD}@${SHARED_HOST}:6543/postgres?sslmode=disable`,
    `postgresql://${SHARED_USER}:${PASSWORD}@${SHARED_HOST}:6543/postgres?sslmode=verify-full&application_name=unsafe`,
    `postgresql://${SHARED_USER}:${PASSWORD}@${SHARED_HOST}:6543/postgres?sslmode=verify-full&sslmode=verify-full`,
    `postgresql://${SHARED_USER}:${PASSWORD}@${SHARED_HOST}:6543/postgres?sslmode=verify-full#fragment`,
    `postgresql://${SHARED_USER}:${PASSWORD}@${SHARED_HOST}:7777/postgres?sslmode=verify-full`,
    `postgresql://${SHARED_USER}:${PASSWORD}@${SHARED_HOST}:6543/other?sslmode=verify-full`
  ])("rejects ambiguous transport or TLS configuration: %s", (url) => {
    expect(() => parse(url)).toThrow("not configured");
  });

  it("rejects untrusted hosts, IPs, direct-endpoint tenant drift, and expected-host drift", () => {
    for (const url of [
      `postgresql://${SHARED_USER}:${PASSWORD}@evil.example.com:6543/postgres?sslmode=verify-full`,
      `postgresql://${SHARED_USER}:${PASSWORD}@127.0.0.1:6543/postgres?sslmode=verify-full`,
      `postgresql://${SHARED_USER}:${PASSWORD}@db.zyxwvutsrqponmlkjihg.supabase.co:5432/postgres?sslmode=verify-full`
    ]) {
      expect(() => parse(url)).toThrow("not configured");
    }
    expect(() =>
      parse(
        `postgresql://${SHARED_USER}:${PASSWORD}@${SHARED_HOST}:6543/postgres?sslmode=verify-full`,
        { expectedHost: "other.pooler.supabase.com" }
      )
    ).toThrow("not configured");
    expect(() =>
      parse(
        `postgresql://${SHARED_USER}:${PASSWORD}@${SHARED_HOST}:6543/postgres?sslmode=verify-full`,
        { projectRef: "not-a-project-ref" }
      )
    ).toThrow("not configured");
  });

  it("rejects malformed or control-bearing credentials without reflecting them", () => {
    const canary = "private-database-password-canary";
    for (const url of [
      `postgresql://${SHARED_USER}:%ZZ@${SHARED_HOST}:6543/postgres?sslmode=verify-full`,
      `postgresql://${SHARED_USER}:valid-password%0Ahidden@${SHARED_HOST}:6543/postgres?sslmode=verify-full`,
      `postgresql://postgres.${PROJECT_REF}:${canary}@${SHARED_HOST}:6543/postgres?sslmode=verify-full`
    ]) {
      let caught: unknown;
      try {
        parse(url);
      } catch (error: unknown) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect(String(caught)).not.toContain(canary);
      expect(String(caught)).not.toContain("hidden");
    }
  });
});
