import { ApiErrorCode } from "@unfiled/contracts";
import { describe, expect, it, vi } from "vitest";

import { errorResponse, HttpError, readJsonObject } from "./errors";

const MAX_JSON_REQUEST_BYTES = 250_000;
const encoder = new TextEncoder();

function streamingRequest(
  chunks: readonly Uint8Array[],
  headers?: HeadersInit,
  options: Readonly<{ close?: boolean; cancel?: () => void | Promise<void> }> = {}
): Request {
  const source: UnderlyingDefaultSource<Uint8Array> = {
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      if (options.close !== false) controller.close();
    }
  };
  if (options.cancel !== undefined) source.cancel = options.cancel;
  const body = new ReadableStream<Uint8Array>(source);
  const init: RequestInit & { duplex: "half" } = {
    method: "POST",
    ...(headers === undefined ? {} : { headers }),
    body,
    duplex: "half"
  };
  return new Request("https://unfiled.test/api/v1/captures", init);
}

async function rejection(request: Request): Promise<HttpError> {
  const reason = await readJsonObject(request).catch((error: unknown) => error);
  expect(reason).toBeInstanceOf(HttpError);
  return reason as HttpError;
}

describe("readJsonObject", () => {
  it.each([
    { label: "an omitted Content-Length", headers: undefined },
    { label: "a chunked body", headers: { "transfer-encoding": "chunked" } },
    { label: "a forged-small Content-Length", headers: { "content-length": "2" } }
  ])("caps the streamed body with $label and cancels it on overflow", async ({ headers }) => {
    const cancel = vi.fn();
    const privatePayload = encoder.encode(`{"private":"${"x".repeat(MAX_JSON_REQUEST_BYTES)}"}`);
    const request = streamingRequest([privatePayload], headers, { close: false, cancel });

    const reason = await rejection(request);

    expect(reason).toMatchObject({
      code: ApiErrorCode.VALIDATION_FAILED,
      message: "That request is too large.",
      status: 413
    });
    expect(String(reason)).not.toContain("private");
    expect(cancel).toHaveBeenCalledOnce();

    const response = errorResponse(
      reason,
      new Request("https://unfiled.test/api/v1/captures", {
        headers: { "x-request-id": "request-size-test" }
      })
    );
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      code: ApiErrorCode.VALIDATION_FAILED,
      message: "That request is too large.",
      requestId: "request-size-test"
    });
  });

  it("accepts a valid JSON object whose UTF-8 representation is exactly the byte limit", async () => {
    const serialized = `{"value":"${"a".repeat(MAX_JSON_REQUEST_BYTES - 12)}"}`;
    const bytes = encoder.encode(serialized);
    expect(bytes.byteLength).toBe(MAX_JSON_REQUEST_BYTES);
    const request = streamingRequest([bytes.slice(0, 101_003), bytes.slice(101_003)], {
      "content-length": String(MAX_JSON_REQUEST_BYTES)
    });

    const value = await readJsonObject(request);

    expect(value.value).toBe("a".repeat(MAX_JSON_REQUEST_BYTES - 12));
  });

  it("rejects a declared body over the byte limit without trusting numeric coercion", async () => {
    const reason = await rejection(
      streamingRequest([encoder.encode("{}")], {
        "content-length": "000000000000250001"
      })
    );

    expect(reason).toMatchObject({
      code: ApiErrorCode.VALIDATION_FAILED,
      message: "That request is too large.",
      status: 413
    });
  });

  it.each([
    { label: "empty", value: "" },
    { label: "negative", value: "-1" },
    { label: "fractional", value: "2.5" },
    { label: "exponential", value: "2e1" },
    { label: "multiple matching", value: "2, 2" },
    { label: "multiple conflicting", value: "2, 3" }
  ])("rejects a $label Content-Length", async ({ value }) => {
    const reason = await rejection(
      streamingRequest([encoder.encode("{}")], { "content-length": value })
    );

    expect(reason).toMatchObject({
      code: ApiErrorCode.VALIDATION_FAILED,
      message: "Send a valid JSON request.",
      status: 400
    });
  });

  it("rejects duplicate Content-Length fields after the platform combines them", async () => {
    const headers = new Headers([
      ["content-length", "2"],
      ["content-length", "3"]
    ]);
    expect(headers.get("content-length")).toBe("2, 3");

    const reason = await rejection(streamingRequest([encoder.encode("{}")], headers));

    expect(reason.status).toBe(400);
    expect(reason.message).toBe("Send a valid JSON request.");
  });

  it.each([
    {
      label: "malformed UTF-8",
      bytes: Uint8Array.from([123, 34, 118, 34, 58, 34, 195, 40, 34, 125])
    },
    {
      label: "malformed JSON",
      bytes: encoder.encode('{"private-canary":"unterminated"')
    }
  ])("rejects $label without exposing request content", async ({ bytes }) => {
    const reason = await rejection(streamingRequest([bytes]));

    expect(reason).toMatchObject({
      code: ApiErrorCode.VALIDATION_FAILED,
      message: "Send a valid JSON request.",
      status: 400
    });
    expect(String(reason)).not.toContain("private-canary");
  });

  it("sanitizes a body-stream failure", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"value":'));
        controller.error(new TypeError("private-canary-stream-failure"));
      }
    });
    const init: RequestInit & { duplex: "half" } = {
      method: "POST",
      body,
      duplex: "half"
    };

    const reason = await rejection(new Request("https://unfiled.test/api/v1/captures", init));

    expect(reason.status).toBe(400);
    expect(reason.message).toBe("Send a valid JSON request.");
    expect(String(reason)).not.toContain("private-canary");
  });
});
