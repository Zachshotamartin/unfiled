import { describe, expect, it } from "vitest";

import { providerResponseFailure, readProviderErrorIdentity } from "../src/provider-transport.js";

const signal = new AbortController().signal;

function errorResponse(error: unknown, status = 400): Response {
  return new Response(JSON.stringify({ error }), { status });
}

describe("readProviderErrorIdentity", () => {
  it("keeps only the provider's identifiers and a schema validation message", async () => {
    const message =
      "Invalid schema for response_format 'plan': In context=('properties', 'a'), 'const' is not permitted.";
    await expect(
      readProviderErrorIdentity(
        errorResponse({
          code: null,
          message,
          param: "text.format.schema",
          type: "invalid_request_error"
        }),
        signal
      )
    ).resolves.toEqual({
      param: "text.format.schema",
      schemaError: message,
      type: "invalid_request_error"
    });
  });

  it("drops every message that is not a schema validation message", async () => {
    const identity = await readProviderErrorIdentity(
      errorResponse({
        code: "context_length_exceeded",
        message: "PRIVATE-PROVIDER-ERROR-CANARY",
        param: "input",
        type: "invalid_request_error"
      }),
      signal
    );
    expect(identity).toEqual({
      code: "context_length_exceeded",
      param: "input",
      type: "invalid_request_error"
    });
    expect(JSON.stringify(identity)).not.toContain("CANARY");
  });

  it("yields nothing for text, malformed, empty, or oversized bodies", async () => {
    await expect(
      readProviderErrorIdentity(
        new Response("PRIVATE-PROVIDER-ERROR-CANARY", { status: 400 }),
        signal
      )
    ).resolves.toEqual({});
    await expect(readProviderErrorIdentity(errorResponse("text"), signal)).resolves.toEqual({});
    await expect(
      readProviderErrorIdentity(new Response(null, { status: 400 }), signal)
    ).resolves.toEqual({});
    await expect(
      readProviderErrorIdentity(new Response("x".repeat(256 * 1_024 + 1), { status: 400 }), signal)
    ).resolves.toEqual({});
  });

  it("rejects identifiers with unexpected characters and bounds the schema message", async () => {
    const identity = await readProviderErrorIdentity(
      errorResponse({
        message: `Invalid schema ${"y".repeat(500)}\t`,
        param: "a".repeat(65),
        type: "invalid request error!"
      }),
      signal
    );
    expect(identity.type).toBeUndefined();
    expect(identity.param).toBeUndefined();
    expect(identity.schemaError).toHaveLength(240);
    expect(identity.schemaError).not.toContain("\t");
  });
});

describe("providerResponseFailure", () => {
  it("attaches the identity to the failure it classifies", () => {
    const failure = providerResponseFailure(400, { param: "text.format.schema" });
    expect(failure.safeCode).toBe("validation_failed");
    expect(failure.identity).toEqual({ param: "text.format.schema" });
    expect(providerResponseFailure(503).identity).toBeNull();
  });
});
