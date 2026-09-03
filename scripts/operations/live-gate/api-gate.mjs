#!/usr/bin/env node
// Live API gate: a synthetic account performs every real operation the product offers against a
// deployed origin (production by default). Output is content-free: step names, status codes,
// booleans, counts, and error codes. Never tokens, keys, or note text.
//
// Environment:
//   UNFILED_GATE_WEB_ORIGIN         default https://unfiled-web.vercel.app
//   UNFILED_GATE_CRON_SECRET        lets the gate drain the capture and indexing queues at once
//                                   (else it waits for the scheduled drains, up to 4 minutes)
//   UNFILED_GATE_OPENAI_API_KEY     saved on the synthetic account so the organizer can run; without
//                                   it every organizer-dependent step is a hard failure ("no_key")
//   UNFILED_GATE_OUTPUT             JSON summary path (default: live-gate-api.json in cwd)
//   UNFILED_GATE_KEEP_ACCOUNT=1     skip the account deletion at the end (debugging only)
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

const WEB = (process.env.UNFILED_GATE_WEB_ORIGIN ?? "https://unfiled-web.vercel.app").replace(
  /\/$/u,
  ""
);
const API = `${WEB}/api/v1`;
const CRON_SECRET = process.env.UNFILED_GATE_CRON_SECRET ?? null;
const OPENAI_KEY = process.env.UNFILED_GATE_OPENAI_API_KEY ?? null;
const OUTPUT = process.env.UNFILED_GATE_OUTPUT ?? "live-gate-api.json";
const startedAt = new Date().toISOString();
const results = [];
let failures = 0;

function record(step, ok, detail = {}) {
  results.push({ step, ok, ...detail });
  if (!ok) failures += 1;
  console.log(
    `${ok ? "pass" : "FAIL"}  ${step}${Object.keys(detail).length ? "  " + JSON.stringify(detail) : ""}`
  );
  return ok;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const key = () => randomUUID().toLowerCase();
const ULID = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function ulid() {
  let time = Date.now();
  let out = "";
  for (let index = 0; index < 10; index += 1) {
    out = ULID[time % 32] + out;
    time = Math.floor(time / 32);
  }
  const random = randomBytes(16);
  for (let index = 0; index < 16; index += 1) out += ULID[random[index] % 32];
  return out;
}

const MAX_RATE_LIMIT_WAIT_MS = 6 * 60_000;
async function api(method, path, options = {}) {
  // The auth endpoints rate-limit one address; a gate run right after another waits for the
  // window the server names instead of reporting a false failure.
  for (let attempt = 0; ; attempt += 1) {
    const response = await request(method, path, options);
    const retryAfter = Number(
      response.headers.get("retry-after") ?? response.json?.retryAfterSeconds ?? 0
    );
    const waitMs = Math.min(retryAfter * 1000, MAX_RATE_LIMIT_WAIT_MS);
    if (response.status !== 429 || attempt >= 2 || !path.startsWith("/auth/") || waitMs <= 0)
      return response;
    console.log(`wait  ${path} rate limited; retrying in ${Math.ceil(waitMs / 1000)}s`);
    await sleep(waitMs + 1000);
  }
}
async function request(method, path, { token, body, headers, idempotencyKey } = {}) {
  const requestHeaders = {
    accept: "application/json",
    ...(body !== undefined ? { "content-type": "application/json" } : {}),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
    ...(headers ?? {})
  };
  const response = await fetch(`${API}${path}`, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: response.status, json, headers: response.headers };
}
const code = (r) => r.json?.code ?? null;
// A write body carries its key; the same key rides in the header the API requires.
const write = (method, path, token, body) =>
  api(method, path, { token, body, idempotencyKey: body.idempotencyKey });

async function pollUntil(label, check, { timeoutMs = 240_000, everyMs = 4_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last.done) return last;
    await sleep(everyMs);
  }
  return { ...last, timedOut: true };
}
async function drainQueues() {
  if (!CRON_SECRET) return { skipped: true };
  const headers = { authorization: `Bearer ${CRON_SECRET}` };
  const captures = await fetch(`${WEB}/api/internal/captures/drain`, { headers });
  // Generation maintenance opens a search-index generation for accounts that have notes, so a
  // fresh account reaches the same indexed state as a long-lived one before the drain runs.
  const maintenance = await fetch(`${WEB}/api/internal/indexing/maintenance`, { headers });
  const indexing = await fetch(`${WEB}/api/internal/indexing/drain`, { headers });
  return { captures: captures.status, maintenance: maintenance.status, indexing: indexing.status };
}

// ---------------------------------------------------------------- account
const stamp = Date.now().toString(36);
const email = `gate-${stamp}-${randomBytes(3).toString("hex")}@example.com`;
const password = `Gate-${createHash("sha256").update(email).digest("hex").slice(0, 24)}-1`;
let token = null;
let refreshToken = null;
{
  const health = await fetch(`${WEB}/api/health`);
  record("web.health", health.status === 200, {
    status: health.status,
    commit: health.headers.get("x-unfiled-commit")?.slice(0, 7) ?? null
  });
  const unauth = await api("GET", "/notes");
  record("auth.unauthenticated_rejected", unauth.status === 401, { status: unauth.status });
  const up = await api("POST", "/auth/sign-up", { body: { email, password } });
  token = up.json?.accessToken ?? null;
  refreshToken = up.json?.refreshToken ?? null;
  record("auth.sign_up", up.status === 200 && typeof token === "string", {
    status: up.status,
    code: code(up)
  });
  if (!token) {
    finish();
    process.exit(1);
  }
  const again = await api("POST", "/auth/sign-up", { body: { email, password } });
  record(
    "auth.repeated_sign_up_is_account_exists",
    again.status === 409 && code(again) === "account_exists",
    { status: again.status, code: code(again) }
  );
  const wrong = await api("POST", "/auth/sign-in", { body: { email, password: `${password}x` } });
  record("auth.wrong_password_rejected", wrong.status === 401, {
    status: wrong.status,
    code: code(wrong)
  });
  const signedIn = await api("POST", "/auth/sign-in", { body: { email, password } });
  record(
    "auth.sign_in",
    signedIn.status === 200 && typeof signedIn.json?.accessToken === "string",
    { status: signedIn.status, code: code(signedIn) }
  );
  if (signedIn.json?.accessToken) {
    token = signedIn.json.accessToken;
    refreshToken = signedIn.json.refreshToken ?? refreshToken;
  }
  const session = await api("GET", "/auth/session", { token });
  record("auth.session", session.status === 200, { status: session.status });
  if (refreshToken) {
    const refreshed = await api("POST", "/auth/refresh", { body: { refreshToken } });
    record(
      "auth.refresh",
      refreshed.status === 200 && typeof refreshed.json?.accessToken === "string",
      { status: refreshed.status, code: code(refreshed) }
    );
    if (refreshed.json?.accessToken) {
      token = refreshed.json.accessToken;
      refreshToken = refreshed.json.refreshToken ?? refreshToken;
    }
  } else {
    record("auth.refresh", false, { reason: "no_refresh_token_in_sign_in_response" });
  }
}

// ---------------------------------------------------------------- settings and provider key
{
  const settings = await api("GET", "/me/settings", { token });
  record("settings.get", settings.status === 200 && settings.json?.settings !== undefined, {
    status: settings.status,
    providerMode: settings.json?.settings?.providerMode ?? null
  });
  const current = settings.json?.settings ?? {};
  const patched = await write("PATCH", "/me/settings", token, {
    expectedSettingsRevision: current.settingsRevision ?? 1,
    idempotencyKey: key(),
    expansionStyle: "off"
  });
  record("settings.patch_expansion_off", patched.status === 200, {
    status: patched.status,
    code: code(patched)
  });
  const status = await api("GET", "/me/provider-key?provider=openai", { token });
  record("provider_key.status_absent", status.status === 200 && status.json?.providerKey === null, {
    status: status.status,
    code: code(status)
  });
  if (OPENAI_KEY) {
    const put = await write("PUT", "/me/provider-key", token, {
      provider: "openai",
      apiKey: OPENAI_KEY,
      idempotencyKey: key(),
      expectedCredentialRevision: null
    });
    record("provider_key.put", put.status === 200 || put.status === 201, {
      status: put.status,
      code: code(put)
    });
    const after = await api("GET", "/me/provider-key?provider=openai", { token });
    record(
      "provider_key.status_present",
      after.status === 200 && after.json?.providerKey?.status === "active",
      { status: after.status, keyStatus: after.json?.providerKey?.status ?? null }
    );
    const latest = await api("GET", "/me/settings", { token });
    const byok = await write("PATCH", "/me/settings", token, {
      expectedSettingsRevision: latest.json?.settings?.settingsRevision ?? 1,
      idempotencyKey: key(),
      providerMode: "byok",
      byokProvider: "openai"
    });
    record("settings.patch_byok", byok.status === 200, { status: byok.status, code: code(byok) });
  } else {
    record("provider_key.put", false, {
      reason: "no_key",
      hint: "set UNFILED_GATE_OPENAI_API_KEY"
    });
  }
}

// ---------------------------------------------------------------- spaces and tags
let spaceId = null;
let tagId = null;
{
  const created = await write("POST", "/spaces", token, {
    idempotencyKey: key(),
    name: `Gate space ${stamp}`,
    parentId: null
  });
  spaceId = created.json?.space?.id ?? null;
  record("spaces.create", created.status === 201 && spaceId !== null, {
    status: created.status,
    code: code(created)
  });
  const list = await api("GET", "/spaces?limit=100", { token });
  record(
    "spaces.list_contains_new",
    list.status === 200 && (list.json?.items ?? []).some((s) => s.id === spaceId),
    { status: list.status, count: (list.json?.items ?? []).length }
  );
  if (spaceId) {
    const got = await api("GET", `/spaces/${spaceId}`, { token });
    record("spaces.get", got.status === 200, { status: got.status });
    const rev = got.json?.space?.currentRevision ?? created.json?.space?.currentRevision ?? 1;
    const renamed = await write("PATCH", `/spaces/${spaceId}`, token, {
      expectedRevision: rev,
      idempotencyKey: key(),
      name: `Gate space ${stamp} renamed`
    });
    record("spaces.rename", renamed.status === 200, {
      status: renamed.status,
      code: code(renamed)
    });
  }
  const tag = await write("POST", "/tags", token, { idempotencyKey: key(), name: `gate-${stamp}` });
  tagId = tag.json?.tag?.id ?? null;
  record("tags.create", tag.status === 201 && tagId !== null, {
    status: tag.status,
    code: code(tag)
  });
  const tags = await api("GET", "/tags?limit=100", { token });
  record(
    "tags.list_contains_new",
    tags.status === 200 && (tags.json?.items ?? []).some((t) => t.id === tagId),
    { status: tags.status }
  );
  if (tagId) {
    const renamedTag = await write("PATCH", `/tags/${tagId}`, token, {
      expectedRevision: tag.json?.tag?.currentRevision ?? 1,
      idempotencyKey: key(),
      name: `gate-${stamp}-r`
    });
    record("tags.rename", renamedTag.status === 200, {
      status: renamedTag.status,
      code: code(renamedTag)
    });
  }
}

// ---------------------------------------------------------------- notes lifecycle
let noteId = null;
let noteRevision = 0;
let secondNoteId = null;
{
  const created = await write("POST", "/notes", token, {
    idempotencyKey: key(),
    title: "Gate list",
    type: "list",
    spaceId,
    privacy: "ai_assisted",
    bodyMarkdown: "- [ ] alpha\n- [x] beta"
  });
  noteId = created.json?.note?.id ?? null;
  noteRevision = created.json?.note?.currentRevision ?? 0;
  const items = created.json?.note?.structuredData?.items ?? [];
  record("notes.create_list", created.status === 201 && noteId !== null && items.length === 2, {
    status: created.status,
    code: code(created),
    items: items.length
  });
  record(
    "notes.list_body_keeps_checks_in_place",
    created.json?.note?.bodyMarkdown === "- [ ] alpha\n- [x] beta",
    { body: created.json?.note?.bodyMarkdown === "- [ ] alpha\n- [x] beta" }
  );
  if (noteId) {
    const toggled = await write("POST", `/notes/${noteId}/operations`, token, {
      expectedRevision: noteRevision,
      idempotencyKey: key(),
      operations: [{ type: "toggle_item_checked", itemId: items[0]?.id, checked: true }]
    });
    record(
      "notes.toggle_item",
      toggled.status === 200 && toggled.json?.note?.structuredData?.items?.[0]?.checked === true,
      { status: toggled.status, code: code(toggled) }
    );
    noteRevision = toggled.json?.note?.currentRevision ?? noteRevision;
    const stale = await write("POST", `/notes/${noteId}/operations`, token, {
      expectedRevision: 1,
      idempotencyKey: key(),
      operations: [{ type: "toggle_item_checked", itemId: items[0]?.id, checked: false }]
    });
    record(
      "notes.stale_revision_rejected",
      stale.status === 409 && code(stale) === "stale_revision",
      { status: stale.status, code: code(stale) }
    );
    const updated = await write("PATCH", `/notes/${noteId}`, token, {
      expectedRevision: noteRevision,
      idempotencyKey: key(),
      title: "Gate list v2",
      bodyMarkdown: "- [x] alpha\n- [x] beta\n- [ ] gamma",
      privacy: "ai_assisted",
      spaceId
    });
    record("notes.update", updated.status === 200 && updated.json?.note?.title === "Gate list v2", {
      status: updated.status,
      code: code(updated)
    });
    noteRevision = updated.json?.note?.currentRevision ?? noteRevision;
    const got = await api("GET", `/notes/${noteId}`, { token });
    record("notes.get", got.status === 200 && got.json?.note?.currentRevision === noteRevision, {
      status: got.status
    });
    const revisions = await api("GET", `/notes/${noteId}/revisions?limit=30`, { token });
    const revisionItems = revisions.json?.items ?? [];
    record("notes.revisions_list", revisions.status === 200 && revisionItems.length >= 2, {
      status: revisions.status,
      count: revisionItems.length
    });
    const earliest = revisionItems.at(-1);
    if (earliest) {
      const restored = await write("POST", `/notes/${noteId}/restore`, token, {
        expectedRevision: noteRevision,
        idempotencyKey: key(),
        revisionId: earliest.id
      });
      record("notes.restore_revision", restored.status === 200, {
        status: restored.status,
        code: code(restored)
      });
      noteRevision = restored.json?.note?.currentRevision ?? noteRevision;
    }
    if (tagId) {
      const linkedTag = await write("POST", `/notes/${noteId}/tags`, token, {
        expectedRevision: noteRevision,
        idempotencyKey: key(),
        tagId
      });
      record("notes.link_tag", linkedTag.status === 200, {
        status: linkedTag.status,
        code: code(linkedTag)
      });
      noteRevision = linkedTag.json?.note?.currentRevision ?? noteRevision;
      const unlinked = await write("DELETE", `/notes/${noteId}/tags/${tagId}`, token, {
        expectedRevision: noteRevision,
        idempotencyKey: key()
      });
      record("notes.unlink_tag", unlinked.status === 200, {
        status: unlinked.status,
        code: code(unlinked)
      });
      noteRevision = unlinked.json?.note?.currentRevision ?? noteRevision;
    }
    const second = await write("POST", "/notes", token, {
      idempotencyKey: key(),
      title: "Gate second",
      type: "generic",
      spaceId: null,
      privacy: "ai_assisted",
      bodyMarkdown: "A second note for links and search: kitchen tap plumber."
    });
    secondNoteId = second.json?.note?.id ?? null;
    record("notes.create_generic", second.status === 201 && secondNoteId !== null, {
      status: second.status,
      code: code(second)
    });
    if (secondNoteId) {
      const link = await write("POST", `/notes/${noteId}/links`, token, {
        expectedRevision: noteRevision,
        idempotencyKey: key(),
        toNoteId: secondNoteId,
        linkType: "reference"
      });
      record("notes.create_link", link.status === 200, { status: link.status, code: code(link) });
      noteRevision = link.json?.note?.currentRevision ?? noteRevision;
      const links = await api("GET", `/notes/${noteId}/links`, { token });
      const linkItems = links.json?.items ?? links.json?.links ?? [];
      record("notes.list_links", links.status === 200 && linkItems.length >= 1, {
        status: links.status,
        count: linkItems.length
      });
      const backlinks = await api("GET", `/notes/${secondNoteId}/backlinks`, { token });
      record("notes.backlinks", backlinks.status === 200, {
        status: backlinks.status,
        count: (backlinks.json?.items ?? []).length
      });
      const sources = await api("GET", `/notes/${noteId}/sources`, { token });
      record("notes.sources", sources.status === 200, { status: sources.status });
      const linkId = linkItems[0]?.id ?? null;
      if (linkId) {
        const unlinked = await write("DELETE", `/notes/${noteId}/links/${linkId}`, token, {
          expectedRevision: noteRevision,
          idempotencyKey: key(),
          toNoteId: secondNoteId,
          linkType: "reference"
        });
        record("notes.delete_link", unlinked.status === 200, {
          status: unlinked.status,
          code: code(unlinked)
        });
        noteRevision = unlinked.json?.note?.currentRevision ?? noteRevision;
      }
    }
    const moved = await write("POST", `/notes/${noteId}/move`, token, {
      expectedRevision: noteRevision,
      idempotencyKey: key(),
      spaceId: null
    });
    record("notes.move_out_of_space", moved.status === 200 && moved.json?.note?.spaceId === null, {
      status: moved.status,
      code: code(moved)
    });
    noteRevision = moved.json?.note?.currentRevision ?? noteRevision;
    const archived = await write("POST", `/notes/${noteId}/archive`, token, {
      expectedRevision: noteRevision,
      idempotencyKey: key(),
      archived: true
    });
    record("notes.archive", archived.status === 200 && archived.json?.note?.archivedAt !== null, {
      status: archived.status,
      code: code(archived)
    });
    noteRevision = archived.json?.note?.currentRevision ?? noteRevision;
    const archivedList = await api("GET", "/notes?archive=include", { token });
    record(
      "notes.list_includes_archived",
      archivedList.status === 200 &&
        (archivedList.json?.items ?? archivedList.json?.notes ?? []).some((n) => n.id === noteId),
      { status: archivedList.status }
    );
    const unarchived = await write("POST", `/notes/${noteId}/archive`, token, {
      expectedRevision: noteRevision,
      idempotencyKey: key(),
      archived: false
    });
    record(
      "notes.unarchive",
      unarchived.status === 200 && unarchived.json?.note?.archivedAt === null,
      { status: unarchived.status, code: code(unarchived) }
    );
    noteRevision = unarchived.json?.note?.currentRevision ?? noteRevision;
    const deleted = await write("DELETE", `/notes/${noteId}`, token, {
      expectedRevision: noteRevision,
      idempotencyKey: key()
    });
    record("notes.soft_delete", deleted.status === 200 && deleted.json?.note?.deletedAt !== null, {
      status: deleted.status,
      code: code(deleted)
    });
    noteRevision = deleted.json?.note?.currentRevision ?? noteRevision;
    const activeList = await api("GET", "/notes", { token });
    record(
      "notes.deleted_note_leaves_list",
      activeList.status === 200 &&
        !(activeList.json?.items ?? activeList.json?.notes ?? []).some((n) => n.id === noteId),
      { status: activeList.status }
    );
    const restoredDeleted = await write("POST", `/notes/${noteId}/restore-deleted`, token, {
      expectedRevision: noteRevision,
      idempotencyKey: key()
    });
    record(
      "notes.restore_deleted",
      restoredDeleted.status === 200 && restoredDeleted.json?.note?.deletedAt === null,
      { status: restoredDeleted.status, code: code(restoredDeleted) }
    );
    noteRevision = restoredDeleted.json?.note?.currentRevision ?? noteRevision;
    const blocks = await api("GET", `/notes/${noteId}/generated-blocks`, { token });
    record("notes.generated_blocks_list", blocks.status === 200, {
      status: blocks.status,
      count: (blocks.json?.items ?? []).length
    });
  }
}

// ---------------------------------------------------------------- indexed note deletion
// The owner's own failure: a note the search index already holds could not be deleted.
{
  const indexed = await write("POST", "/notes", token, {
    idempotencyKey: key(),
    title: "Gate indexed",
    type: "generic",
    spaceId: null,
    privacy: "ai_assisted",
    bodyMarkdown: "Indexed before deletion: saxophone lesson on Tuesday."
  });
  const indexedId = indexed.json?.note?.id ?? null;
  let indexedRevision = indexed.json?.note?.currentRevision ?? 0;
  record("notes.create_for_index", indexed.status === 201 && indexedId !== null, {
    status: indexed.status,
    code: code(indexed)
  });
  if (indexedId) {
    await drainQueues();
    const seen = await pollUntil(
      "search.indexed",
      async () => {
        await drainQueues();
        const response = await api("POST", "/search", {
          token,
          body: { query: "saxophone", archive: "exclude" }
        });
        const hits = response.json?.items ?? [];
        return {
          done: response.status === 200 && hits.some((hit) => (hit.noteId ?? hit.id) === indexedId),
          status: response.status,
          hits: hits.length
        };
      },
      { timeoutMs: 120_000, everyMs: 5_000 }
    );
    record("search.indexes_new_note", seen.done === true, {
      hits: seen.hits,
      timedOut: seen.timedOut === true,
      drained: CRON_SECRET !== null
    });
    const deleted = await write("DELETE", `/notes/${indexedId}`, token, {
      expectedRevision: indexedRevision,
      idempotencyKey: key()
    });
    record(
      "notes.soft_delete_indexed_note",
      deleted.status === 200 && deleted.json?.note?.deletedAt !== null,
      { status: deleted.status, code: code(deleted) }
    );
    indexedRevision = deleted.json?.note?.currentRevision ?? indexedRevision;
    const gone = await api("POST", "/search", {
      token,
      body: { query: "saxophone", archive: "exclude" }
    });
    record(
      "search.excludes_deleted_note",
      gone.status === 200 &&
        !(gone.json?.items ?? []).some((hit) => (hit.noteId ?? hit.id) === indexedId),
      { status: gone.status, hits: (gone.json?.items ?? []).length }
    );
    const restored = await write("POST", `/notes/${indexedId}/restore-deleted`, token, {
      expectedRevision: indexedRevision,
      idempotencyKey: key()
    });
    record(
      "notes.restore_indexed_note",
      restored.status === 200 && restored.json?.note?.deletedAt === null,
      { status: restored.status, code: code(restored) }
    );
  }
}

// ---------------------------------------------------------------- log note fields
{
  const log = await write("POST", "/notes", token, {
    idempotencyKey: key(),
    title: "Gate log",
    type: "log",
    spaceId: null,
    privacy: "ai_assisted",
    bodyMarkdown: "5 km"
  });
  const entry = log.json?.note?.structuredData?.entries?.[0] ?? null;
  record("notes.create_log", log.status === 201 && entry !== null, {
    status: log.status,
    code: code(log)
  });
  if (entry) {
    const field = Object.keys(entry.fields ?? {})[0] ?? "text";
    const updated = await write("POST", `/notes/${log.json.note.id}/operations`, token, {
      expectedRevision: log.json.note.currentRevision,
      idempotencyKey: key(),
      operations: [
        { type: "update_log_field", entryId: entry.id, fieldPath: [field], value: "6 km" }
      ]
    });
    record("notes.update_log_field", updated.status === 200, {
      status: updated.status,
      code: code(updated)
    });
  }
}

// ---------------------------------------------------------------- routing rules
let liveRulePrefix = null;
let liveRuleId = null;
let liveRuleRevision = 1;
{
  const list = await api("GET", "/routing-rules", { token });
  record("routing_rules.list", list.status === 200, {
    status: list.status,
    count: (list.json?.items ?? []).length
  });
  if (secondNoteId) {
    const created = await write("POST", "/routing-rules", token, {
      idempotencyKey: key(),
      enabled: true,
      ruleType: "prefix",
      condition: `gate-${stamp}:`,
      destination: { type: "note", noteId: secondNoteId },
      priority: 10
    });
    const ruleId = created.json?.rule?.id ?? created.json?.routingRule?.id ?? null;
    record("routing_rules.create", created.status === 201 && ruleId !== null, {
      status: created.status,
      code: code(created)
    });
    if (ruleId) {
      const rule = created.json?.rule ?? created.json?.routingRule;
      const disabled = await write("PATCH", `/routing-rules/${ruleId}`, token, {
        expectedRevision: rule?.revision ?? rule?.currentRevision ?? 1,
        idempotencyKey: key(),
        enabled: false
      });
      record("routing_rules.disable", disabled.status === 200, {
        status: disabled.status,
        code: code(disabled)
      });
      const latest = disabled.json?.rule ?? disabled.json?.routingRule ?? rule;
      const reenabled = await write("PATCH", `/routing-rules/${ruleId}`, token, {
        expectedRevision: latest?.revision ?? latest?.currentRevision ?? 1,
        idempotencyKey: key(),
        enabled: true
      });
      record("routing_rules.enable", reenabled.status === 200, {
        status: reenabled.status,
        code: code(reenabled)
      });
      const live = reenabled.json?.rule ?? reenabled.json?.routingRule ?? latest;
      liveRulePrefix = `gate-${stamp}:`;
      liveRuleId = ruleId;
      liveRuleRevision = live?.revision ?? live?.currentRevision ?? 1;
    }
  }
}

// ---------------------------------------------------------------- captures and the organizer
// Capture A: an unmatched capture. With a key the organizer plans it (the account's first
// captures go to review by policy), the review is decided into a new note, and the placement is
// undone. Without a key it fails as provider_unavailable and is retried.
async function organize(rawContent, label) {
  const clientCaptureId = `cap_${ulid()}`;
  const created = await api("POST", "/captures", {
    token,
    idempotencyKey: clientCaptureId,
    body: {
      clientCaptureId,
      rawContent,
      source: "web",
      privacy: "ai_assisted",
      clientCreatedAt: new Date().toISOString(),
      clientTimezone: "UTC"
    }
  });
  const captureId = created.json?.capture?.id ?? clientCaptureId;
  record(`${label}.create`, created.status === 201 || created.status === 202, {
    status: created.status,
    code: code(created),
    captureStatus: created.json?.capture?.status ?? null
  });
  const drained = await drainQueues();
  const outcome = await pollUntil(`${label}.organized`, async () => {
    const detail = await api("GET", `/captures/${captureId}`, { token });
    const capture = detail.json?.capture ?? {};
    const done = ["done", "needs_review", "failed", "inbox"].includes(capture.status);
    if (!done && drained.skipped !== true) await drainQueues();
    return {
      done,
      status: detail.status,
      captureStatus: capture.status ?? null,
      lastErrorCode: capture.lastErrorCode ?? null,
      receipt: capture.receipt ?? null
    };
  });
  return { captureId, outcome, drained };
}
const receiptOf = async (captureId) =>
  (await api("GET", `/captures/${captureId}`, { token })).json?.capture?.receipt ?? null;
async function undoReceipt(captureId, receipt, label) {
  const undo = receipt?.actions?.find((action) => action.type === "undo");
  if (!undo || !receipt?.destination?.noteId) {
    record(`${label}.undo`, false, {
      reason: receipt ? "no_undo_action" : "no_receipt",
      outcome: receipt?.outcome ?? null
    });
    return;
  }
  const note = await api("GET", `/notes/${receipt.destination.noteId}`, { token });
  const undone = await write("POST", `/mutation-batches/${undo.mutationId}/undo`, token, {
    expectedRevision: note.json?.note?.currentRevision ?? undo.expectedRevision,
    idempotencyKey: key()
  });
  record(`${label}.undo`, undone.status === 200, { status: undone.status, code: code(undone) });
  const after = await receiptOf(captureId);
  const undoStillOffered = after?.actions?.some((action) => action.type === "undo") === true;
  record(`${label}.undo_reflected_on_receipt`, after !== null && !undoStillOffered, {
    outcome: after?.outcome ?? null,
    undoStillOffered
  });
}

let organizedCaptureId = null;
let receipt = null;
{
  const canary = `gate-${stamp}`;
  const a = await organize(`Groceries ${canary}: milk, eggs, bread`, "capture_a");
  organizedCaptureId = a.captureId;
  receipt = a.outcome.receipt;
  const list = await api("GET", "/captures?limit=50", { token });
  record(
    "captures.list_contains_new",
    list.status === 200 && (list.json?.items ?? []).some((c) => c.id === organizedCaptureId),
    { status: list.status, count: (list.json?.items ?? []).length }
  );
  record("cron.drain", a.drained.skipped === true || a.drained.captures === 200, {
    ...a.drained,
    note: a.drained.skipped ? "no cron secret; waiting for the schedule" : undefined
  });
  if (OPENAI_KEY) {
    record(
      "capture_a.organized_with_key",
      !a.outcome.timedOut && ["done", "needs_review"].includes(a.outcome.captureStatus),
      {
        captureStatus: a.outcome.captureStatus,
        lastErrorCode: a.outcome.lastErrorCode,
        timedOut: a.outcome.timedOut === true,
        receiptOutcome: receipt?.outcome ?? null
      }
    );
  } else {
    record(
      "capture_a.keyless_fails_with_provider_unavailable",
      !a.outcome.timedOut &&
        a.outcome.captureStatus === "failed" &&
        a.outcome.lastErrorCode === "provider_unavailable",
      {
        captureStatus: a.outcome.captureStatus,
        lastErrorCode: a.outcome.lastErrorCode,
        timedOut: a.outcome.timedOut === true
      }
    );
    record("captures.organizer_path", false, {
      reason: "no_key",
      hint: "set UNFILED_GATE_OPENAI_API_KEY to exercise review, undo, correction, and search over organized notes"
    });
  }
  const receiptRead = await api("GET", `/captures/${organizedCaptureId}/receipt`, { token });
  record("captures.receipt_read", receiptRead.status === 200 || receiptRead.status === 404, {
    status: receiptRead.status,
    code: code(receiptRead)
  });
  if (a.outcome.captureStatus === "failed") {
    const retry = await write("POST", `/captures/${organizedCaptureId}/retry`, token, {
      idempotencyKey: key()
    });
    record("captures.retry_failed_capture", retry.status === 200 || retry.status === 202, {
      status: retry.status,
      code: code(retry),
      replayed: retry.json?.replayed ?? null
    });
  }
}

// ---------------------------------------------------------------- review and undo (capture A)
if (receipt) {
  const reviews = await api("GET", "/review-items?state=open&limit=50", { token });
  const open = reviews.json?.items ?? [];
  record("review.list_open", reviews.status === 200, {
    status: reviews.status,
    count: open.length
  });
  if (receipt.outcome === "needs_review" && receipt.reviewItemId) {
    const mine = open.find((item) => item.id === receipt.reviewItemId);
    record("review.receipt_review_is_open", mine !== undefined, { found: mine !== undefined });
    if (mine) {
      const resolved = await write("POST", `/review-items/${mine.id}/resolve`, token, {
        idempotencyKey: key(),
        resolution: { type: "create", title: "Gate groceries", noteType: "list", spaceId: null }
      });
      record(
        "review.resolve_create",
        resolved.status === 200 && resolved.json?.reviewItem?.state === "resolved",
        { status: resolved.status, code: code(resolved) }
      );
      receipt = (await receiptOf(organizedCaptureId)) ?? receipt;
      record(
        "review.receipt_updated_after_resolution",
        ["created_note", "added_to_note"].includes(receipt?.outcome),
        { outcome: receipt?.outcome ?? null }
      );
      const closedList = await api("GET", "/review-items?state=open&limit=50", { token });
      record(
        "review.resolved_item_leaves_open_list",
        closedList.status === 200 &&
          !(closedList.json?.items ?? []).some((item) => item.id === mine.id),
        { status: closedList.status }
      );
    }
  }
  await undoReceipt(organizedCaptureId, receipt, "capture_a");
}

// ---------------------------------------------------------------- rule-filed capture, move, undo (capture B)
// Capture B carries the routing-rule prefix, so it files into the rule's note deterministically
// (no provider needed). Its decision is corrected into another generic note, then undone.
if (liveRulePrefix && secondNoteId) {
  const b = await organize(
    `${liveRulePrefix} Rule-filed ${stamp}: call the plumber back`,
    "capture_b"
  );
  let receiptB = b.outcome.receipt;
  record(
    "capture_b.filed_by_rule",
    ["done"].includes(b.outcome.captureStatus) &&
      ["added_to_note", "created_note"].includes(receiptB?.outcome),
    {
      captureStatus: b.outcome.captureStatus,
      outcome: receiptB?.outcome ?? null,
      lastErrorCode: b.outcome.lastErrorCode,
      timedOut: b.outcome.timedOut === true
    }
  );
  const move = receiptB?.actions?.find((action) => action.type === "move");
  const target = await write("POST", "/notes", token, {
    idempotencyKey: key(),
    title: "Gate move target",
    type: "generic",
    spaceId: null,
    privacy: "ai_assisted",
    bodyMarkdown: "A generic note that receives the moved capture."
  });
  const targetId = target.json?.note?.id ?? null;
  record("notes.create_move_target", target.status === 201 && targetId !== null, {
    status: target.status,
    code: code(target)
  });
  if (move && targetId && receiptB?.destination?.noteId) {
    const sourceNote = await api("GET", `/notes/${receiptB.destination.noteId}`, { token });
    const corrected = await write("POST", `/decisions/${move.decisionId}/correct`, token, {
      idempotencyKey: key(),
      source: {
        noteId: receiptB.destination.noteId,
        expectedRevision: sourceNote.json?.note?.currentRevision ?? 1
      },
      destination: {
        type: "existing_note",
        noteId: targetId,
        expectedRevision: target.json?.note?.currentRevision ?? 1
      }
    });
    record("decision.correct_move", corrected.status === 200, {
      status: corrected.status,
      code: code(corrected),
      applied: corrected.json?.outcome ?? corrected.json?.applied ?? null
    });
    receiptB = (await receiptOf(b.captureId)) ?? receiptB;
    record("decision.receipt_shows_new_destination", receiptB?.destination?.noteId === targetId, {
      moved: receiptB?.destination?.noteId === targetId,
      outcome: receiptB?.outcome ?? null
    });
    const targetAfter = await api("GET", `/notes/${targetId}`, { token });
    record(
      "decision.target_note_changed",
      (targetAfter.json?.note?.currentRevision ?? 1) > (target.json?.note?.currentRevision ?? 1),
      { revision: targetAfter.json?.note?.currentRevision ?? null }
    );
  } else {
    record("decision.correct_move", false, {
      reason: move ? "no_target" : "no_move_action",
      outcome: receiptB?.outcome ?? null
    });
  }
  await undoReceipt(b.captureId, receiptB, "capture_b");
}

// ---------------------------------------------------------------- photos (capture D)
// A photo is uploaded as raw bytes before its capture exists, bound when the capture is
// created, shown to the organizer's provider, placed into the filed note by reference, and
// read back only under private, no-store. The fixture is a real 96 by 64 JPEG.
async function uploadPhoto(captureId, attachmentId, bytes, extra = {}) {
  const response = await fetch(`${API}/captures/attachments`, {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      "content-type": "image/jpeg",
      "idempotency-key": attachmentId,
      "x-unfiled-capture-id": captureId,
      "x-unfiled-privacy": "ai_assisted",
      "x-unfiled-width": "96",
      "x-unfiled-height": "64",
      ...extra
    },
    body: bytes
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: response.status, json, headers: response.headers };
}
{
  const photo = readFileSync(new URL("./fixtures/photo.jpg", import.meta.url));
  const captureId = `cap_${ulid()}`;
  const attachmentId = `att_${ulid()}`;
  const uploaded = await uploadPhoto(captureId, attachmentId, photo);
  record(
    "photo.upload",
    uploaded.status === 201 &&
      uploaded.json?.id === attachmentId &&
      uploaded.json?.kind === "image" &&
      uploaded.json?.byteLength === photo.byteLength,
    { status: uploaded.status, code: code(uploaded), byteLength: uploaded.json?.byteLength ?? null }
  );
  const replayed = await uploadPhoto(captureId, attachmentId, photo);
  record(
    "photo.upload_replay_is_idempotent",
    replayed.status === 201 && replayed.json?.id === attachmentId,
    { status: replayed.status, code: code(replayed) }
  );
  const wrongType = await uploadPhoto(captureId, `att_${ulid()}`, photo, {
    "content-type": "image/png"
  });
  record("photo.upload_refuses_other_media_types", wrongType.status === 400, {
    status: wrongType.status,
    code: code(wrongType)
  });
  const mismatched = await uploadPhoto(captureId, `att_${ulid()}`, photo, {
    "x-unfiled-duration-ms": "1200"
  });
  record("photo.upload_refuses_measurements_of_the_wrong_kind", mismatched.status === 400, {
    status: mismatched.status,
    code: code(mismatched)
  });
  const created = await api("POST", "/captures", {
    token,
    idempotencyKey: captureId,
    body: {
      clientCaptureId: captureId,
      rawContent: `Whiteboard gate-${stamp}`,
      source: "web",
      privacy: "ai_assisted",
      clientCreatedAt: new Date().toISOString(),
      clientTimezone: "UTC",
      attachmentIds: [attachmentId]
    }
  });
  record("photo.capture_binds_the_upload", created.status === 201 || created.status === 202, {
    status: created.status,
    code: code(created)
  });
  const strangerBind = await api("POST", "/captures", {
    token,
    idempotencyKey: `cap_${ulid()}`,
    body: {
      clientCaptureId: `cap_${ulid()}`,
      rawContent: "Not my photo",
      source: "web",
      privacy: "ai_assisted",
      clientCreatedAt: new Date().toISOString(),
      clientTimezone: "UTC",
      attachmentIds: [attachmentId]
    }
  });
  record(
    "photo.another_capture_cannot_bind_a_bound_photo",
    strangerBind.status === 403 || strangerBind.status === 404 || strangerBind.status === 409,
    { status: strangerBind.status, code: code(strangerBind) }
  );
  const read = await fetch(`${API}/captures/attachments/${attachmentId}`, {
    headers: { authorization: `Bearer ${token}` }
  });
  const readBytes = Buffer.from(await read.arrayBuffer());
  record(
    "photo.read_returns_the_same_bytes_uncached",
    read.status === 200 &&
      read.headers.get("content-type") === "image/jpeg" &&
      read.headers.get("cache-control") === "private, no-store" &&
      readBytes.equals(photo),
    {
      status: read.status,
      contentType: read.headers.get("content-type"),
      cacheControl: read.headers.get("cache-control"),
      sameBytes: readBytes.equals(photo)
    }
  );
  const drained = await drainQueues();
  const outcome = await pollUntil("photo.organized", async () => {
    const detail = await api("GET", `/captures/${captureId}`, { token });
    const capture = detail.json?.capture ?? {};
    const done = ["done", "needs_review", "failed", "inbox"].includes(capture.status);
    if (!done && drained.skipped !== true) await drainQueues();
    return {
      done,
      status: detail.status,
      captureStatus: capture.status ?? null,
      lastErrorCode: capture.lastErrorCode ?? null,
      receipt: capture.receipt ?? null
    };
  });
  if (OPENAI_KEY) {
    record(
      "photo.organized_with_key",
      !outcome.timedOut && ["done", "needs_review"].includes(outcome.captureStatus),
      {
        captureStatus: outcome.captureStatus,
        lastErrorCode: outcome.lastErrorCode,
        timedOut: outcome.timedOut === true,
        receiptOutcome: outcome.receipt?.outcome ?? null
      }
    );
    const noteId = outcome.receipt?.destination?.noteId ?? null;
    if (noteId) {
      const note = await api("GET", `/notes/${noteId}`, { token });
      const body = note.json?.note?.bodyMarkdown ?? "";
      record(
        "photo.filed_note_references_the_photo",
        note.status === 200 && body.includes(`unfiled-attachment:${attachmentId}`),
        { status: note.status, referenced: body.includes(`unfiled-attachment:${attachmentId}`) }
      );
    } else {
      record("photo.filed_note_references_the_photo", outcome.captureStatus === "needs_review", {
        reason: "no_destination",
        captureStatus: outcome.captureStatus,
        note: "a review outcome carries no note yet"
      });
    }
  } else {
    record(
      "photo.keyless_fails_with_provider_unavailable",
      !outcome.timedOut &&
        outcome.captureStatus === "failed" &&
        outcome.lastErrorCode === "provider_unavailable",
      {
        captureStatus: outcome.captureStatus,
        lastErrorCode: outcome.lastErrorCode,
        timedOut: outcome.timedOut === true
      }
    );
  }
  const strangerRead = await fetch(`${API}/captures/attachments/att_${ulid()}`, {
    headers: { authorization: `Bearer ${token}` }
  });
  record("photo.unknown_attachment_is_not_found", strangerRead.status === 404, {
    status: strangerRead.status
  });
}

// ---------------------------------------------------------------- search and export
{
  await drainQueues();
  const search = await pollUntil(
    "search",
    async () => {
      const response = await api("POST", "/search", {
        token,
        body: { query: "plumber", archive: "exclude" }
      });
      const hits = response.json?.items ?? [];
      return {
        done: response.status === 200 && hits.length >= 1,
        status: response.status,
        hits: hits.length,
        code: code(response)
      };
    },
    { timeoutMs: 120_000, everyMs: 5_000 }
  );
  record("search.finds_note_text", search.done === true, {
    status: search.status,
    hits: search.hits,
    code: search.code,
    timedOut: search.timedOut === true
  });
  const exported = await fetch(`${API}/me/export`, {
    headers: { authorization: `Bearer ${token}` }
  });
  const bytes = Buffer.from(await exported.arrayBuffer());
  let plain = "";
  try {
    plain = gunzipSync(bytes).toString("utf8");
  } catch {
    plain = "";
  }
  record(
    "export.archive_has_manifest_and_notes",
    exported.status === 200 && plain.includes("manifest.json") && plain.includes("Gate second"),
    { status: exported.status, bytes: bytes.length }
  );
}

// ---------------------------------------------------------------- capture deletion, provider key removal, sign-out, account deletion
{
  const clientCaptureId = `cap_${ulid()}`;
  const created = await api("POST", "/captures", {
    token,
    idempotencyKey: clientCaptureId,
    body: {
      clientCaptureId,
      rawContent: `Gate delete ${stamp}`,
      source: "web",
      privacy: "private_manual",
      clientCreatedAt: new Date().toISOString(),
      clientTimezone: "UTC"
    }
  });
  const captureId = created.json?.capture?.id ?? clientCaptureId;
  record("captures.create_private", created.status === 201 || created.status === 202, {
    status: created.status,
    code: code(created)
  });
  const removed = await write("DELETE", `/captures/${captureId}`, token, { idempotencyKey: key() });
  record("captures.delete", removed.status === 200 || removed.status === 204, {
    status: removed.status,
    code: code(removed)
  });
  if (OPENAI_KEY) {
    const stored = await api("GET", "/me/provider-key?provider=openai", { token });
    if (stored.json?.providerKey) {
      const removedKey = await write("DELETE", "/me/provider-key", token, {
        provider: "openai",
        idempotencyKey: key(),
        expectedCredentialRevision: stored.json.providerKey.credentialRevision
      });
      record("provider_key.delete", removedKey.status === 200 || removedKey.status === 204, {
        status: removedKey.status,
        code: code(removedKey)
      });
    } else {
      record("provider_key.delete", false, { reason: "no_stored_key" });
    }
  }
  if (liveRuleId) {
    const rules = await api("GET", "/routing-rules", { token });
    const current = (rules.json?.items ?? []).find((rule) => rule.id === liveRuleId);
    const removed = await write("DELETE", `/routing-rules/${liveRuleId}`, token, {
      expectedRevision: current?.revision ?? liveRuleRevision,
      idempotencyKey: key()
    });
    record("routing_rules.delete", removed.status === 200 || removed.status === 204, {
      status: removed.status,
      code: code(removed)
    });
  }
  const signedOut = await api("POST", "/auth/sign-out", { token });
  record("auth.sign_out", signedOut.status === 200 || signedOut.status === 204, {
    status: signedOut.status,
    code: code(signedOut)
  });
  const back = await api("POST", "/auth/sign-in", { body: { email, password } });
  token = back.json?.accessToken ?? token;
  if (process.env.UNFILED_GATE_KEEP_ACCOUNT === "1") {
    record("account.kept_for_debugging", true, {});
  } else {
    const deleted = await api("DELETE", "/me", {
      token,
      body: {
        confirmation: "DELETE",
        idempotencyKey: `delete_${randomBytes(32).toString("base64url")}`
      }
    });
    record("account.delete", deleted.status === 200 || deleted.status === 202, {
      status: deleted.status,
      code: code(deleted)
    });
    const gone = await api("GET", "/auth/session", { token });
    record("account.session_invalid_after_delete", gone.status === 401, { status: gone.status });
  }
}

finish();
process.exit(failures === 0 ? 0 : 1);

function finish() {
  const summary = {
    schemaVersion: 1,
    gate: "api",
    origin: WEB,
    startedAt,
    finishedAt: new Date().toISOString(),
    organizerKey: OPENAI_KEY !== null,
    cronDrain: CRON_SECRET !== null,
    totals: { steps: results.length, failed: failures },
    results
  };
  writeFileSync(OUTPUT, JSON.stringify(summary, null, 2));
  console.log(`\n${results.length} steps, ${failures} failed -> ${OUTPUT}`);
}
