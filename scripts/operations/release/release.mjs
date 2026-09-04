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
import { pendingMigrationsFromDryRun, unappliedMigrationsFromList } from "./migration-state.mjs";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

/**
 * Fills in any project id the environment did not name, by asking Vercel for the projects this
 * token can see. A release should work from a clean checkout: requiring a linked working copy
 * meant the script only ran where someone had already run `vercel link` by hand.
 */
async function resolveProjectIds() {
  if (APPS.every((app) => projectIdFor(app))) return;
  const { status, body } = await vercelApi("/v9/projects?limit=100");
  if (status !== 200 || !Array.isArray(body?.projects)) return;
  for (const app of APPS) {
    if (projectIdFor(app)) continue;
    const project = body.projects.find((candidate) => candidate.name === `unfiled-${app}`);
    if (project === undefined) continue;
    process.env[`VERCEL_PROJECT_ID_${app.toUpperCase()}`] = project.id;
    if (!process.env.VERCEL_ORG_ID) process.env.VERCEL_ORG_ID = project.accountId;
  }
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
  // Everything the live gate needs, checked here rather than discovered by the gate. The gate
  // confirms its own synthetic account through Supabase's admin API, so without these two it
  // stops at once with exit 2 -- and it runs after the five deploys, which meant a release could
  // put new code in front of every owner and only then find out it could not verify any of it.
  for (const name of [
    "UNFILED_GATE_OPENAI_API_KEY",
    "UNFILED_GATE_CRON_SECRET",
    "UNFILED_GATE_SUPABASE_URL",
    "UNFILED_GATE_SUPABASE_SERVICE_ROLE_KEY"
  ]) {
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

/**
 * The Supabase CLI that pushes the schema to production is the one the repository pins, because
 * that is the one CI reset, linted and tested the schema with. Reading it from package.json keeps a
 * single version in the repository instead of a second one hidden in a command line here.
 */
function supabaseCli() {
  const manifest = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url)));
  const pinned = manifest.devDependencies?.supabase;
  if (typeof pinned !== "string" || !/^\d+\.\d+\.\d+$/u.test(pinned)) {
    fail(
      "Could not read the pinned Supabase CLI version from package.json; the schema is not pushed " +
        "with an unknown CLI."
    );
  }
  return ["--yes", `supabase@${pinned}`];
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
// The deployment production is serving right now: the one the project's production target
// points at. This used to be the newest READY deployment made for production, which is not the
// same thing after a rollback -- the newest one is then the build that was just un-promoted.
// Release 33850771049 rolled back on a red gate and "restored" the broken organizer from the
// release before it, so production stayed broken until a human promoted the last good build.
async function currentProductionDeployment(app) {
  const projectId = projectIdFor(app);
  const teamQuery = new URLSearchParams({ teamId: process.env.VERCEL_ORG_ID });
  const project = await vercelApi(`/v9/projects/${projectId}?${teamQuery.toString()}`);
  const serving = project.status === 200 ? project.body?.targets?.production : undefined;
  if (serving && typeof (serving.uid ?? serving.id) === "string") {
    return {
      id: serving.uid ?? serving.id,
      url: serving.url ?? null,
      commit: serving.meta?.githubCommitSha ?? null
    };
  }
  // Without a production target to read, the newest ready production deployment is the best
  // available guess, and the log says so, because a guess is what a rollback would then restore.
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
  if (!deployment) return null;
  console.warn(
    `${app}: production target unavailable; recording the newest ready deployment as previous`
  );
  return {
    id: deployment.uid ?? deployment.id,
    url: deployment.url,
    commit: deployment.meta?.githubCommitSha ?? null
  };
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
  const cli = supabaseCli();
  // --output-format json asks for the summary the parser expects; the text form is read too.
  const dryRun = await run(
    "npx",
    [...cli, "db", "push", ...migrationTarget(), "--dry-run", "--output-format", "json"],
    {
      echo: false
    }
  );
  if (dryRun.code !== 0) {
    fail(`Could not read the production migration state.\n${dryRun.err.slice(-2000)}`);
  }
  // Read strictly: an answer the release cannot read is a reason to stop, never to deploy. On
  // 2026-09-04 an unreadable dry run was taken as "schema is already current" and five services
  // shipped against a migration that was never applied.
  let pending;
  try {
    pending = pendingMigrationsFromDryRun({ stdout: dryRun.out, stderr: dryRun.err });
  } catch (error) {
    fail(
      `${error instanceof Error ? error.message : String(error)}\n--- stdout:\n${dryRun.out.slice(-2000)}\n--- stderr:\n${dryRun.err.slice(-2000)}`
    );
  }
  if (pending.length > 0) {
    console.log(`pending: ${pending.join(", ")}`);
    const push = await run("npx", [...cli, "db", "push", ...migrationTarget(), "--yes"]);
    if (push.code !== 0) fail("Applying migrations failed; nothing was deployed.");
    console.log(`applied ${pending.length} migration(s)`);
  } else {
    console.log("dry run reports the schema current");
  }
  // Whatever the dry run said, the database's own migration table decides. No code deploys while
  // a local migration has no remote entry.
  const listed = await run(
    "npx",
    [...cli, "migration", "list", ...migrationTarget(), "--output-format", "json"],
    {
      echo: false
    }
  );
  if (listed.code !== 0) {
    fail(`Could not read the production migration list.\n${listed.err.slice(-2000)}`);
  }
  let unapplied;
  try {
    unapplied = unappliedMigrationsFromList(listed.out, listed.err);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  if (unapplied.length > 0) {
    fail(`Migrations not recorded in production: ${unapplied.join(", ")}. Nothing was deployed.`);
  }
  console.log("every local migration is recorded in production");
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
  if (!process.env.VERCEL_TOKEN) {
    fail(
      "VERCEL_TOKEN is not set. Create one at https://vercel.com/account/tokens; the Vercel CLI's" +
        " own login is a session the API refuses."
    );
  }
  await resolveProjectIds();
  requirements();
  const head = await run("git", ["rev-parse", "HEAD"], { echo: false });
  const commit = head.out.trim();
  if (!/^[0-9a-f]{40}$/u.test(commit)) fail("Could not read the commit being released.");
  console.log(`== releasing ${commit.slice(0, 7)}`);

  // Recording what is live is what makes the gate's rollback possible, so a release that cannot
  // read it does not start. Discovering that only after a red gate would leave production on a
  // broken deployment with nothing to promote back.
  const previous = {};
  for (const app of APPS) {
    const deployment = await currentProductionDeployment(app);
    if (deployment === null) {
      fail(
        `Could not read the deployment currently serving ${app}. Without it a red gate could not` +
          ` be rolled back, so nothing was deployed. Check that VERCEL_TOKEN is a Vercel API` +
          ` token (Account Settings, Tokens) rather than the CLI's own login, which the API` +
          ` rejects.`
      );
    }
    previous[app] = deployment;
    console.log(
      `== ${app}: a rollback would restore ${deployment.url ?? deployment.id}` +
        (deployment.commit ? ` (${String(deployment.commit).slice(0, 7)})` : "")
    );
  }

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
