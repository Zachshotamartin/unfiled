import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  SUPABASE_SERVICE_ROLE_KEY_VARIABLE,
  SUPABASE_URL_VARIABLE,
  createSupabaseAdmin,
  missingConfigurationMessage,
  readSignUpAnswer,
  readSupabaseAdminConfiguration,
  signUpAnswerMatchesDeployment
} from "./account-verification.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API_GATE = path.join(HERE, "api-gate.mjs");
const run = promisify(execFile);

/** A stubbed project: replies are matched by method and path, and every request is recorded. */
function stubProject(replies) {
  const requests = [];
  const fetchImplementation = async (url, options) => {
    const method = options?.method ?? "GET";
    requests.push({ method, url, headers: options?.headers ?? {}, body: options?.body ?? null });
    const reply = replies.find(
      (candidate) => candidate.method === method && url.endsWith(candidate.path)
    );
    if (reply === undefined) throw new Error(`no stubbed reply for ${method} ${url}`);
    if (reply.unreachable === true) throw new Error("the project is unreachable");
    return { status: reply.status, text: async () => JSON.stringify(reply.body ?? null) };
  };
  return { fetchImplementation, requests };
}

function admin(replies, overrides = {}) {
  const project = stubProject(replies);
  return {
    ...project,
    caller: createSupabaseAdmin({
      url: "https://project.supabase.co",
      serviceRoleKey: "service-role-key",
      fetchImplementation: project.fetchImplementation,
      ...overrides
    })
  };
}

const account = (id, email) => ({ id, email });

describe("readSupabaseAdminConfiguration", () => {
  it("names every missing variable so one run reports the whole gap", () => {
    expect(readSupabaseAdminConfiguration({})).toEqual({
      ok: false,
      missing: [SUPABASE_URL_VARIABLE, SUPABASE_SERVICE_ROLE_KEY_VARIABLE]
    });
  });

  it("names only the service role key when the project URL is present", () => {
    const configuration = readSupabaseAdminConfiguration({
      [SUPABASE_URL_VARIABLE]: "https://project.supabase.co",
      [SUPABASE_SERVICE_ROLE_KEY_VARIABLE]: "   "
    });
    expect(configuration).toEqual({ ok: false, missing: [SUPABASE_SERVICE_ROLE_KEY_VARIABLE] });
    expect(missingConfigurationMessage(configuration.missing)).toContain(
      SUPABASE_SERVICE_ROLE_KEY_VARIABLE
    );
  });

  it("rejects a project URL that is not an absolute http address", () => {
    expect(
      readSupabaseAdminConfiguration({
        [SUPABASE_URL_VARIABLE]: "project.supabase.co",
        [SUPABASE_SERVICE_ROLE_KEY_VARIABLE]: "service-role-key"
      })
    ).toEqual({ ok: false, missing: [SUPABASE_URL_VARIABLE] });
  });

  it("trims the values and the trailing slash the console copies", () => {
    expect(
      readSupabaseAdminConfiguration({
        [SUPABASE_URL_VARIABLE]: " https://project.supabase.co/ ",
        [SUPABASE_SERVICE_ROLE_KEY_VARIABLE]: " service-role-key \n"
      })
    ).toEqual({ ok: true, url: "https://project.supabase.co", serviceRoleKey: "service-role-key" });
  });
});

describe("deploymentConfirmsAddresses", () => {
  it("reports that addresses are confirmed when the provider does not autoconfirm", async () => {
    const { caller, requests } = admin([
      { method: "GET", path: "/auth/v1/settings", status: 200, body: { mailer_autoconfirm: false } }
    ]);
    expect(await caller.deploymentConfirmsAddresses()).toEqual({
      ok: true,
      status: 200,
      confirmsAddresses: true
    });
    expect(requests[0].headers.apikey).toBe("service-role-key");
    expect(requests[0].headers.authorization).toBe("Bearer service-role-key");
  });

  it("reports that addresses are not confirmed when the provider autoconfirms", async () => {
    const { caller } = admin([
      { method: "GET", path: "/auth/v1/settings", status: 200, body: { mailer_autoconfirm: true } }
    ]);
    expect(await caller.deploymentConfirmsAddresses()).toEqual({
      ok: true,
      status: 200,
      confirmsAddresses: false
    });
  });

  it("fails rather than guessing when the setting cannot be read", async () => {
    const { caller } = admin([
      { method: "GET", path: "/auth/v1/settings", status: 401, body: { message: "unauthorized" } }
    ]);
    expect(await caller.deploymentConfirmsAddresses()).toEqual({
      ok: false,
      status: 401,
      confirmsAddresses: null
    });
  });

  it("fails without throwing when the project is unreachable", async () => {
    const { caller } = admin([
      { method: "GET", path: "/auth/v1/settings", status: 200, unreachable: true }
    ]);
    expect(await caller.deploymentConfirmsAddresses()).toEqual({
      ok: false,
      status: 0,
      confirmsAddresses: null
    });
  });
});

describe("confirmAddress", () => {
  const found = {
    method: "GET",
    path: "/auth/v1/admin/users?page=1&per_page=200&filter=gate%40example.com",
    status: 200,
    body: {
      users: [account("other-id", "someone@example.com"), account("gate-id", "gate@example.com")]
    }
  };

  it("confirms the address the provider reports as confirmed", async () => {
    const { caller, requests } = admin([
      found,
      {
        method: "PUT",
        path: "/auth/v1/admin/users/gate-id",
        status: 200,
        body: { id: "gate-id", email_confirmed_at: "2026-09-03T00:00:00Z" }
      }
    ]);
    expect(await caller.confirmAddress("Gate@Example.com")).toEqual({
      ok: true,
      found: true,
      status: 200
    });
    expect(JSON.parse(requests[1].body)).toEqual({ email_confirm: true });
  });

  it("reports the account as absent without writing when the address is not there", async () => {
    const { caller, requests } = admin([
      { ...found, body: { users: [account("other-id", "someone@example.com")] } }
    ]);
    expect(await caller.confirmAddress("gate@example.com")).toEqual({
      ok: false,
      found: false,
      status: 200
    });
    expect(requests).toHaveLength(1);
  });

  it("stops after the bounded number of pages rather than walking a whole project", async () => {
    const page = (number) => ({
      method: "GET",
      path: `page=${number}&per_page=2&filter=gate%40example.com`,
      status: 200,
      body: {
        users: [
          account(`a${number}`, `a${number}@example.com`),
          account(`b${number}`, `b${number}@example.com`)
        ]
      }
    });
    const { caller, requests } = admin([page(1), page(2)], { pageSize: 2, pages: 2 });
    expect(await caller.confirmAddress("gate@example.com")).toEqual({
      ok: false,
      found: false,
      status: 200
    });
    expect(requests).toHaveLength(2);
  });

  it("fails when the provider does not confirm the address it was asked to confirm", async () => {
    const { caller } = admin([
      found,
      {
        method: "PUT",
        path: "/auth/v1/admin/users/gate-id",
        status: 200,
        body: { id: "gate-id", email_confirmed_at: null }
      }
    ]);
    expect(await caller.confirmAddress("gate@example.com")).toEqual({
      ok: false,
      found: true,
      status: 200
    });
  });

  it("keeps the outcome content free", async () => {
    const { caller } = admin([
      found,
      {
        method: "PUT",
        path: "/auth/v1/admin/users/gate-id",
        status: 200,
        body: {
          id: "gate-id",
          email: "gate@example.com",
          email_confirmed_at: "2026-09-03T00:00:00Z"
        }
      }
    ]);
    expect(Object.keys(await caller.confirmAddress("gate@example.com")).sort()).toEqual([
      "found",
      "ok",
      "status"
    ]);
  });
});

describe("the sign-up answer", () => {
  const asksForCode = {
    status: 200,
    json: { verificationRequired: true, email: "gate@example.com" }
  };
  const issuesSession = {
    status: 200,
    json: { accessToken: "access", refreshToken: "refresh", expiresAt: "2026-09-03T00:00:00Z" }
  };

  it("reads a code request without reading what it carries", () => {
    expect(readSignUpAnswer(asksForCode)).toEqual({
      ok: true,
      verificationRequired: true,
      hasSession: false
    });
  });

  it("reads a session", () => {
    expect(readSignUpAnswer(issuesSession)).toEqual({
      ok: true,
      verificationRequired: false,
      hasSession: true
    });
  });

  it("holds a deployment that confirms addresses to asking for a code", () => {
    expect(signUpAnswerMatchesDeployment(readSignUpAnswer(asksForCode), true)).toBe(true);
    expect(signUpAnswerMatchesDeployment(readSignUpAnswer(issuesSession), true)).toBe(false);
  });

  it("holds a deployment that confirms nothing to signing the owner straight in", () => {
    expect(signUpAnswerMatchesDeployment(readSignUpAnswer(issuesSession), false)).toBe(true);
    expect(signUpAnswerMatchesDeployment(readSignUpAnswer(asksForCode), false)).toBe(false);
  });

  it("refuses an answer that both asks for a code and hands back a session", () => {
    const both = { status: 200, json: { ...issuesSession.json, verificationRequired: true } };
    expect(signUpAnswerMatchesDeployment(readSignUpAnswer(both), true)).toBe(false);
    expect(signUpAnswerMatchesDeployment(readSignUpAnswer(both), false)).toBe(false);
  });

  it("refuses an answer that is not a success", () => {
    expect(signUpAnswerMatchesDeployment(readSignUpAnswer({ status: 500, json: null }), true)).toBe(
      false
    );
  });
});

describe("the api gate without a service role key", () => {
  let directory = null;

  afterEach(async () => {
    if (directory !== null) await rm(directory, { recursive: true, force: true });
    directory = null;
  });

  it("stops before it touches the deployment and names what is missing", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "unfiled-live-gate-"));
    const output = path.join(directory, "live-gate-api.json");
    const failure = await run(process.execPath, [API_GATE], {
      env: {
        PATH: process.env.PATH ?? "",
        UNFILED_GATE_OUTPUT: output,
        // An origin nothing listens on: a run that reached the deployment would fail here instead.
        UNFILED_GATE_WEB_ORIGIN: "http://127.0.0.1:1"
      }
    }).then(
      () => null,
      (error) => error
    );

    expect(failure).not.toBeNull();
    expect(failure.code).toBe(2);
    expect(failure.stderr).toContain(SUPABASE_URL_VARIABLE);
    expect(failure.stderr).toContain(SUPABASE_SERVICE_ROLE_KEY_VARIABLE);

    const summary = JSON.parse(await readFile(output, "utf8"));
    expect(summary.gate).toBe("api");
    expect(summary.schemaVersion).toBe(1);
    expect(summary.totals).toEqual({ steps: 1, failed: 1 });
    expect(summary.results).toEqual([
      {
        step: "gate.configuration",
        ok: false,
        missing: [SUPABASE_URL_VARIABLE, SUPABASE_SERVICE_ROLE_KEY_VARIABLE]
      }
    ]);
  }, 20_000);
});
