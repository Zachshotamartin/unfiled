#!/usr/bin/env node
// One production release, in the only order that is safe: the database schema first, then the
// five services, then the live gate against what is now serving production, and a promotion of
// the previous deployments if the gate is red.
//
// CI and the local command both run this file, so a release cannot behave one way on a laptop
// and another way in Actions. Every requirement is checked before anything is changed, so a
// missing secret costs seconds instead of a deploy.
//
// Environment:
//   VERCEL_TOKEN, VERCEL_ORG_ID          Vercel credentials
//   VERCEL_PROJECT_ID_<APP>              project id per app (WEB, ORGANIZER, WORKER, VERIFIER, SEARCH)
//   SUPABASE_DB_URL                      production database connection string (migrations)
//   UNFILED_GATE_OPENAI_API_KEY          the owner's provider key, saved on the gate's account
//   UNFILED_GATE_CRON_SECRET             lets the gate drain the queues instead of waiting
//   UNFILED_RELEASE_SKIP_MIGRATIONS=1    only when the schema is already known to be current
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const APPS = Object.freeze(["organizer", "worker", "verifier", "search", "web"]);
const WEB_ORIGIN = process.env.UNFILED_GATE_WEB_ORIGIN ?? "https://unfiled-web.vercel.app";
const API = "https://api.vercel.com";
const SKIP_MIGRATIONS = process.env.UNFILED_RELEASE_SKIP_MIGRATIONS === "1";

function fail(message) {
  console.error(message);
  process.exit(1);
}

function projectIdFor(app) {
  return process.env[`VERCEL_PROJECT_ID_${app.toUpperCase()}`];
}

/** Every requirement, named before anything is deployed. */
function requirements() {
  const missing = [];
  for (const name of ["VERCEL_TOKEN", "VERCEL_ORG_ID"]) {
    if (!process.env[name]) missing.push(name);
  }
  for (const app of APPS) {
    if (!projectIdFor(app)) missing.push(`VERCEL_PROJECT_ID_${app.toUpperCase()}`);
  }
  if (!SKIP_MIGRATIONS && !process.env.SUPABASE_DB_URL && !linkedProject()) {
    missing.push("SUPABASE_DB_URL");
  }
  for (const name of ["UNFILED_GATE_OPENAI_API_KEY", "UNFILED_GATE_CRON_SECRET"]) {
    if (!process.env[name]) missing.push(name);
  }
  if (missing.length > 0) {
    fail(
      `Release refused before touching production. Missing: ${missing.join(", ")}.\n` +
        "Add them as repository secrets (Settings, Secrets and variables, Actions) or export " +
        "them locally, then run the release again."
    );
  }
}

/** A laptop that has already linked the Supabase project can push through that link. */
function linkedProject() {
  return existsSync("supabase/.temp/project-ref");
}

/** How the migration commands reach production: an explicit URL in CI, the link locally. */
function migrationTarget() {
  return process.env.SUPABASE_DB_URL ? ["--db-url", process.env.SUPABASE_DB_URL] : ["--linked"];
}
function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
      env: { ...process.env, ...(options.env ?? {}) }
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
      if (options.echo !== false) process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      err += chunk;
      if (options.echo !== false) process.stderr.write(chunk);
    });
    child.on("close", (code) => resolve({ code: code ?? 1, out, err }));
  });
}

async function vercelApi(path, init = {}) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${process.env.VERCEL_TOKEN}`,
      "content-type": "application/json",
      ...(init.headers ?? {})
    }
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

/** The deployment currently serving production, so a red gate has something to go back to. */
async function currentProductionDeployment(app) {
  const projectId = projectIdFor(app);
  const query = new URLSearchParams({
    projectId,
    target: "production",
    state: "READY",
    limit: "1",
    teamId: process.env.VERCEL_ORG_ID
  });
  const { status, body } = await vercelApi(`/v6/deployments?${query.toString()}`);
  if (status !== 200 || !Array.isArray(body?.deployments)) return null;
  const deployment = body.deployments[0];
  return deployment ? { id: deployment.uid ?? deployment.id, url: deployment.url } : null;
}

async function promote(app, deployment) {
  const projectId = projectIdFor(app);
  const query = new URLSearchParams({ teamId: process.env.VERCEL_ORG_ID });
  const { status } = await vercelApi(
    `/v10/projects/${projectId}/promote/${deployment.id}?${query.toString()}`,
    { method: "POST" }
  );
  return status >= 200 && status < 300;
}

async function liveCommit() {
  try {
    const response = await fetch(`${WEB_ORIGIN}/api/health`, { cache: "no-store" });
    return response.headers.get("x-unfiled-commit");
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function applyMigrations() {
  if (SKIP_MIGRATIONS) {
    console.log("== migrations skipped by request");
    return;
  }
  console.log("== applying database migrations before any code that needs them ships");
  const dryRun = await run(
    "npx",
    ["--yes", "supabase@latest", "db", "push", ...migrationTarget(), "--dry-run"],
    { echo: false }
  );
  if (dryRun.code !== 0) {
    fail(`Could not read the production migration state.\n${dryRun.err.slice(-2000)}`);
  }
  const summary = dryRun.out
    .trim()
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .pop();
  let pending = [];
  try {
    pending = JSON.parse(summary ?? "{}").migrations ?? [];
  } catch {
    fail("Could not read the production migration state.");
  }
  if (pending.length === 0) {
    console.log("schema is already current");
    return;
  }
  console.log(`pending: ${pending.join(", ")}`);
  const push = await run("npx", [
    "--yes",
    "supabase@latest",
    "db",
    "push",
    ...migrationTarget(),
    "--yes"
  ]);
  if (push.code !== 0) fail("Applying migrations failed; nothing was deployed.");
  console.log(`applied ${pending.length} migration(s)`);
}

/** Provenance the Vercel dashboard shows, so a deployment names the commit it came from. */
function meta(commit) {
  return [
    "-m",
    `githubCommitSha=${commit}`,
    "-m",
    "githubCommitRef=main",
    "-m",
    "githubCommitOrg=Zachshotamartin",
    "-m",
    "githubCommitRepo=unfiled",
    "-m",
    "githubOrg=Zachshotamartin",
    "-m",
    "githubRepo=unfiled"
  ];
}
async function deployAll(commit) {
  const linkDir = mkdtempSync(join(tmpdir(), "unfiled-release-"));
  const deployed = {};
  for (const app of APPS) {
    console.log(`== deploying ${app}`);
    // Each project's own root directory resolves from the repository root, so the whole
    // repository is uploaded and the project settings select the app.
    writeFileSync(
      join(linkDir, "project.json"),
      JSON.stringify({ projectId: projectIdFor(app), orgId: process.env.VERCEL_ORG_ID })
    );
    const result = await run(
      "npx",
      [
        "--yes",
        "vercel@latest",
        "deploy",
        "--prod",
        "--yes",
        "--force",
        "--token",
        process.env.VERCEL_TOKEN,
        ...meta(commit),
        "--env",
        `VERCEL_GIT_COMMIT_SHA=${commit}`,
        "--build-env",
        `VERCEL_GIT_COMMIT_SHA=${commit}`
      ],
      {
        env: {
          VERCEL_ORG_ID: process.env.VERCEL_ORG_ID,
          VERCEL_PROJECT_ID: projectIdFor(app)
        }
      }
    );
    if (result.code !== 0) return { deployed, failedApp: app };
    const url = (result.out.match(/https:\/\/[a-z0-9-]+\.vercel\.app/giu) ?? []).pop() ?? null;
    deployed[app] = url;
    console.log(`${app} -> ${url ?? "deployed"}`);
  }
  return { deployed, failedApp: null };
}

async function waitForLiveCommit(commit) {
  console.log("== waiting for production to serve this commit");
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const live = await liveCommit();
    if (live === commit) {
      console.log(`production is serving ${commit.slice(0, 7)}`);
      return true;
    }
    await sleep(5000);
  }
  return false;
}

async function main() {
  requirements();
  const head = await run("git", ["rev-parse", "HEAD"], { echo: false });
  const commit = head.out.trim();
  if (!/^[0-9a-f]{40}$/u.test(commit)) fail("Could not read the commit being released.");
  console.log(`== releasing ${commit.slice(0, 7)}`);

  const previous = {};
  for (const app of APPS) previous[app] = await currentProductionDeployment(app);

  await applyMigrations();

  const { failedApp } = await deployAll(commit);
  if (failedApp !== null) {
    console.error(`Deploying ${failedApp} failed; restoring the previous deployments.`);
    await rollback(previous);
    process.exit(1);
  }

  if (!(await waitForLiveCommit(commit))) {
    console.error("Production never reported this commit; restoring the previous deployments.");
    await rollback(previous);
    process.exit(1);
  }

  console.log("== live gate against production");
  const gate = await run("node", ["scripts/operations/live-gate/api-gate.mjs"], {
    env: { UNFILED_GATE_WEB_ORIGIN: WEB_ORIGIN }
  });
  if (gate.code !== 0) {
    console.error("The live gate is red; restoring the previous deployments.");
    await rollback(previous);
    process.exit(1);
  }
  console.log(`== release GREEN: ${commit} is live and verified`);
}

async function rollback(previous) {
  for (const app of APPS) {
    const deployment = previous[app];
    if (!deployment) {
      console.error(`${app}: no previous production deployment recorded; restore it by hand.`);
      continue;
    }
    const restored = await promote(app, deployment);
    console.error(
      restored
        ? `${app}: restored ${deployment.url}`
        : `${app}: restore FAILED; promote ${deployment.url} by hand.`
    );
  }
}

await main();
