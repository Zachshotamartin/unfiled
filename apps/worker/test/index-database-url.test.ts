import { describe, expect, it } from "vitest";

import { parseIndexWorkerDatabaseUrl } from "../src/index-database-url";

const PROJECT_REF = "abcdefghijklmnopqrst";
const EXPECTED_HOST = "aws-0-us-west-2.pooler.supabase.com";
const DIRECT_HOST = `db.${PROJECT_REF}.supabase.co`;
const POOLER_USER = `unfiled_index_worker.${PROJECT_REF}`;
const PASSWORD = "dedicated-capability-secret";

function parse(url: string, expectedHost = EXPECTED_HOST) {
  return parseIndexWorkerDatabaseUrl({ expectedHost, projectRef: PROJECT_REF, url });
}

describe("dedicated index-worker PostgreSQL URL", () => {
  it("accepts the project-bound shared-pooler transport login over verify-full TLS", () => {
    expect(
      parse(
        `postgresql://${POOLER_USER}:${PASSWORD}@${EXPECTED_HOST}:6543/postgres?sslmode=verify-full`
      )
    ).toEqual({
      database: "postgres",
      host: EXPECTED_HOST,
      password: PASSWORD,
      port: 6_543,
      user: POOLER_USER
    });
    expect(
      parse(
        `postgresql://${POOLER_USER}:${PASSWORD}@${EXPECTED_HOST}:5432/postgres?sslmode=verify-full`
      ).port
    ).toBe(5_432);
  });

  it("accepts the exact database role on the project-bound direct endpoint", () => {
    expect(
      parse(
        `postgresql://unfiled_index_worker:${PASSWORD}@${DIRECT_HOST}:5432/postgres?sslmode=verify-full`,
        DIRECT_HOST
      ).user
    ).toBe("unfiled_index_worker");
  });

  it("rejects tenant drift, unsuffixed shared-pooler users, alternate roles, and weak credentials", () => {
    for (const authority of [
      `unfiled_index_worker:${PASSWORD}`,
      `unfiled_index_worker.zyxwvutsrqponmlkjihg:${PASSWORD}`,
      `unfiled_organization_worker.${PROJECT_REF}:${PASSWORD}`,
      `unfiled_rag_verifier.${PROJECT_REF}:${PASSWORD}`,
      `postgres.${PROJECT_REF}:${PASSWORD}`,
      `${POOLER_USER}:`,
      `${POOLER_USER}:short`
    ]) {
      expect(() =>
        parse(`postgresql://${authority}@${EXPECTED_HOST}:6543/postgres?sslmode=verify-full`)
      ).toThrow("UNFILED_WORKER_DATABASE_URL");
    }
    expect(() =>
      parse(
        `postgresql://${POOLER_USER}:${PASSWORD}@${DIRECT_HOST}:5432/postgres?sslmode=verify-full`,
        DIRECT_HOST
      )
    ).toThrow("UNFILED_WORKER_DATABASE_PROJECT_REF");
    expect(() =>
      parseIndexWorkerDatabaseUrl({
        expectedHost: EXPECTED_HOST,
        projectRef: "not-a-project-ref",
        url: `postgresql://${POOLER_USER}:${PASSWORD}@${EXPECTED_HOST}:6543/postgres?sslmode=verify-full`
      })
    ).toThrow("UNFILED_WORKER_DATABASE_PROJECT_REF");
  });

  it("rejects TLS downgrade, host drift, IPs, database drift, unsafe ports, and extra options", () => {
    const urls = [
      `postgresql://${POOLER_USER}:${PASSWORD}@${EXPECTED_HOST}:6543/postgres`,
      `postgresql://${POOLER_USER}:${PASSWORD}@${EXPECTED_HOST}:6543/postgres?sslmode=require`,
      `postgresql://${POOLER_USER}:${PASSWORD}@evil.example.com:6543/postgres?sslmode=verify-full`,
      `postgresql://${POOLER_USER}:${PASSWORD}@127.0.0.1:6543/postgres?sslmode=verify-full`,
      `postgresql://${POOLER_USER}:${PASSWORD}@${EXPECTED_HOST}:6543/other?sslmode=verify-full`,
      `postgresql://${POOLER_USER}:${PASSWORD}@${EXPECTED_HOST}:6432/postgres?sslmode=verify-full`,
      `postgresql://${POOLER_USER}:${PASSWORD}@${EXPECTED_HOST}:6543/postgres?sslmode=verify-full&application_name=no`,
      `postgres://${POOLER_USER}:${PASSWORD}@${EXPECTED_HOST}:6543/postgres?sslmode=verify-full`
    ];
    for (const url of urls) expect(() => parse(url)).toThrow();
  });

  it("never reflects credentials in parse failures", () => {
    const canary = "private-database-password-canary";
    try {
      parse(
        `postgresql://postgres.${PROJECT_REF}:${canary}@${EXPECTED_HOST}:6543/postgres?sslmode=verify-full`
      );
    } catch (error: unknown) {
      expect(String(error)).not.toContain(canary);
    }
  });
});
