import { describe, expect, it } from "vitest";

import { parseVerifierDatabaseUrl } from "../src/database-url";

const PROJECT_REF = "abcdefghijklmnopqrst";
const SHARED_HOST = "aws-0-us-west-2.pooler.supabase.com";
const PASSWORD = "dedicated-verifier-password";

describe("verifier database URL", () => {
  it("accepts only the exact shared-pooler verifier transport user", () => {
    expect(
      parseVerifierDatabaseUrl({
        expectedHost: SHARED_HOST,
        projectRef: PROJECT_REF,
        url: `postgresql://unfiled_rag_verifier.${PROJECT_REF}:${PASSWORD}@${SHARED_HOST}:6543/postgres?sslmode=verify-full`
      })
    ).toEqual({
      database: "postgres",
      host: SHARED_HOST,
      password: PASSWORD,
      port: 6_543,
      user: `unfiled_rag_verifier.${PROJECT_REF}`
    });
  });

  it("accepts the unsuffixed role only on the exact project direct endpoint", () => {
    const host = `db.${PROJECT_REF}.supabase.co`;
    expect(
      parseVerifierDatabaseUrl({
        expectedHost: host,
        projectRef: PROJECT_REF,
        url: `postgresql://unfiled_rag_verifier:${PASSWORD}@${host}:5432/postgres?sslmode=verify-full`
      })
    ).toMatchObject({ host, port: 5_432, user: "unfiled_rag_verifier" });
  });

  it.each([
    "not-a-url",
    `postgresql://postgres:${PASSWORD}@${SHARED_HOST}:6543/postgres?sslmode=verify-full`,
    `postgresql://unfiled_rag_verifier.${PROJECT_REF}:short@${SHARED_HOST}:6543/postgres?sslmode=verify-full`,
    `postgresql://unfiled_rag_verifier.${PROJECT_REF}:${PASSWORD}@${SHARED_HOST}:6543/other?sslmode=verify-full`,
    `postgresql://unfiled_rag_verifier.${PROJECT_REF}:${PASSWORD}@${SHARED_HOST}:6543/postgres?sslmode=require`,
    `postgresql://unfiled_rag_verifier.${PROJECT_REF}:${PASSWORD}@${SHARED_HOST}:6543/postgres?sslmode=verify-full&x=1`,
    `postgresql://unfiled_rag_verifier.${PROJECT_REF}:${PASSWORD}@127.0.0.1:6543/postgres?sslmode=verify-full`,
    `postgresql://unfiled_rag_verifier.${PROJECT_REF}:${PASSWORD}@${SHARED_HOST}:7777/postgres?sslmode=verify-full`,
    `http://unfiled_rag_verifier.${PROJECT_REF}:${PASSWORD}@${SHARED_HOST}:6543/postgres?sslmode=verify-full`,
    `postgresql://unfiled_rag_verifier.${PROJECT_REF}:${PASSWORD}@${SHARED_HOST}:6543/postgres?sslmode=verify-full#fragment`
  ])("rejects an over-capable or ambiguous URL", (url) => {
    expect(() =>
      parseVerifierDatabaseUrl({ expectedHost: SHARED_HOST, projectRef: PROJECT_REF, url })
    ).toThrow();
  });

  it("rejects host, project, and encoded credential drift", () => {
    const valid = `postgresql://unfiled_rag_verifier.${PROJECT_REF}:${PASSWORD}@${SHARED_HOST}:6543/postgres?sslmode=verify-full`;
    expect(() =>
      parseVerifierDatabaseUrl({
        expectedHost: "other.pooler.supabase.com",
        projectRef: PROJECT_REF,
        url: valid
      })
    ).toThrow("UNFILED_VERIFIER_DATABASE_EXPECTED_HOST");
    expect(() =>
      parseVerifierDatabaseUrl({ expectedHost: SHARED_HOST, projectRef: "short", url: valid })
    ).toThrow("UNFILED_VERIFIER_DATABASE_PROJECT_REF");
    expect(() =>
      parseVerifierDatabaseUrl({
        expectedHost: SHARED_HOST,
        projectRef: PROJECT_REF,
        url: `postgresql://bad%ZZ:${PASSWORD}@${SHARED_HOST}:6543/postgres?sslmode=verify-full`
      })
    ).toThrow();
  });
});
