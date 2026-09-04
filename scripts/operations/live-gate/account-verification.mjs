// Supabase admin access for the live API gate. A deployment that confirms addresses emails six
// digits before a new account may sign in, so the synthetic account a gate run creates cannot
// reach the rest of the gate on its own. The gate is a privileged caller: it confirms its own
// account through Supabase's own admin API with a service role key that lives only in the gate
// environment, which is why the product never grew an endpoint that would let anyone else skip
// verification.
//
// Everything here is content-free, like the gate that calls it: statuses and booleans leave, and
// addresses, identifiers, and tokens never do.

export const SUPABASE_URL_VARIABLE = "UNFILED_GATE_SUPABASE_URL";
export const SUPABASE_SERVICE_ROLE_KEY_VARIABLE = "UNFILED_GATE_SUPABASE_SERVICE_ROLE_KEY";

// One page of the newest accounts is enough to find an address the gate created seconds ago; the
// bound exists so a project with many accounts can never turn a lookup into an unbounded walk.
const ADMIN_PAGE_SIZE = 200;
const ADMIN_PAGES = 3;

function trimmed(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isAbsoluteHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * Reads the admin configuration, naming every variable that is missing so a misconfigured run can
 * say what it needs and stop instead of half running.
 */
export function readSupabaseAdminConfiguration(environment) {
  const url = trimmed(environment[SUPABASE_URL_VARIABLE]).replace(/\/$/u, "");
  const serviceRoleKey = trimmed(environment[SUPABASE_SERVICE_ROLE_KEY_VARIABLE]);
  const missing = [];
  if (!isAbsoluteHttpUrl(url)) missing.push(SUPABASE_URL_VARIABLE);
  if (serviceRoleKey === "") missing.push(SUPABASE_SERVICE_ROLE_KEY_VARIABLE);
  if (missing.length > 0) return Object.freeze({ ok: false, missing: Object.freeze(missing) });
  return Object.freeze({ ok: true, url, serviceRoleKey });
}

/** The message a run prints before it stops, which names what the operator has to supply. */
export function missingConfigurationMessage(missing) {
  return (
    `live gate cannot start: set ${missing.join(" and ")}. ` +
    "A deployment that confirms addresses emails a code before a new account can sign in, so the " +
    "gate confirms its own synthetic account through Supabase admin."
  );
}

/**
 * The admin caller. `fetchImplementation` is injected so the caller can be exercised without a
 * project, and every reply is reduced to a status and a boolean before it leaves.
 */
export function createSupabaseAdmin({
  url,
  serviceRoleKey,
  fetchImplementation = fetch,
  pageSize = ADMIN_PAGE_SIZE,
  pages = ADMIN_PAGES
}) {
  const headers = Object.freeze({
    accept: "application/json",
    apikey: serviceRoleKey,
    authorization: `Bearer ${serviceRoleKey}`
  });

  async function send(method, path, body) {
    try {
      const response = await fetchImplementation(`${url}${path}`, {
        method,
        headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      const text = await response.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* not json */
      }
      return { status: response.status, json };
    } catch {
      // The project is unreachable. The gate records a failed step rather than an exception, so a
      // network problem reads the same way as every other failure in the run.
      return { status: 0, json: null };
    }
  }

  /**
   * Whether this deployment confirms new addresses. The provider is the authority, so the gate
   * asks it instead of inferring the answer from the sign-up it is about to assert.
   */
  async function deploymentConfirmsAddresses() {
    const settings = await send("GET", "/auth/v1/settings");
    const autoconfirm = settings.json?.mailer_autoconfirm;
    if (settings.status !== 200 || typeof autoconfirm !== "boolean") {
      return Object.freeze({ ok: false, status: settings.status, confirmsAddresses: null });
    }
    return Object.freeze({ ok: true, status: settings.status, confirmsAddresses: !autoconfirm });
  }

  async function findAccountId(address) {
    for (let page = 1; page <= pages; page += 1) {
      const query = `page=${page}&per_page=${pageSize}&filter=${encodeURIComponent(address)}`;
      const listed = await send("GET", `/auth/v1/admin/users?${query}`);
      const users = listed.json?.users;
      if (listed.status !== 200 || !Array.isArray(users))
        return { status: listed.status, id: null };
      const match = users.find(
        (user) => typeof user?.email === "string" && user.email.toLowerCase() === address
      );
      if (match !== undefined && typeof match.id === "string") {
        return { status: listed.status, id: match.id };
      }
      // A short page is the last page, so an address that is not on it does not exist.
      if (users.length < pageSize) return { status: listed.status, id: null };
    }
    return { status: 200, id: null };
  }

  /** Confirms one address so the account it belongs to can sign in. */
  async function confirmAddress(email) {
    const address = trimmed(email).toLowerCase();
    const found = await findAccountId(address);
    if (found.id === null) {
      return Object.freeze({ ok: false, found: false, status: found.status });
    }
    const updated = await send("PUT", `/auth/v1/admin/users/${found.id}`, { email_confirm: true });
    const confirmed =
      updated.status === 200 && typeof updated.json?.email_confirmed_at === "string";
    return Object.freeze({ ok: confirmed, found: true, status: updated.status });
  }

  /**
   * Creates the gate's synthetic account already confirmed, without any mail being sent.
   *
   * The gate used to create it through the product's own sign-up endpoint. On a deployment that
   * confirms addresses that makes the account depend on email delivery, and the gate's addresses
   * are at example.com, a domain reserved by RFC 2606 with no MX record: the send can never
   * succeed, Supabase answers 500 "Error sending confirmation email", and the product turns that
   * into 503 provider_unavailable. The gate failed on its first step for a reason that says
   * nothing about the deployment under test.
   *
   * Admin creation with email_confirm sends nothing, so the gate no longer needs a mailbox to
   * exist in order to test anything else.
   */
  async function provisionAccount(email, password) {
    const created = await send("POST", "/auth/v1/admin/users", {
      email,
      password,
      email_confirm: true
    });
    const id = created.json?.id;
    return Object.freeze({
      ok: created.status === 200 || created.status === 201,
      status: created.status,
      id: typeof id === "string" ? id : null
    });
  }

  return Object.freeze({ confirmAddress, deploymentConfirmsAddresses, provisionAccount });
}

/** Which of the two answers sign-up gave, read without touching what the answer carries. */
export function readSignUpAnswer(response) {
  const body = response?.json ?? null;
  return Object.freeze({
    ok: response?.status === 200,
    verificationRequired: body?.verificationRequired === true,
    hasSession: typeof body?.accessToken === "string" && typeof body?.refreshToken === "string"
  });
}

/**
 * A deployment that confirms addresses must ask for a code and withhold the session until it has
 * one; a deployment that confirms nothing must sign the owner straight in. Every client has to
 * handle both answers from the same build, so the gate fails the run when the answer does not
 * match the deployment it is running against.
 */
export function signUpAnswerMatchesDeployment(answer, confirmsAddresses) {
  if (!answer.ok) return false;
  return confirmsAddresses
    ? answer.verificationRequired && !answer.hasSession
    : answer.hasSession && !answer.verificationRequired;
}
