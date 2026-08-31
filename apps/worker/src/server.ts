import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { createWorkerComposition } from "./composition";
import { loadWorkerConfig } from "./config";

const HARD_BODY_LIMIT_BYTES = 16_384;

async function collectBody(
  incoming: IncomingMessage
): Promise<Readonly<{ body: Uint8Array | undefined; tooLarge: boolean }>> {
  if (incoming.method === "GET" || incoming.method === "HEAD") {
    return { body: undefined, tooLarge: false };
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of incoming) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
    size += chunk.byteLength;
    if (size > HARD_BODY_LIMIT_BYTES) {
      incoming.resume();
      return { body: undefined, tooLarge: true };
    }
    chunks.push(chunk);
  }
  return {
    body: size === 0 ? undefined : new Uint8Array(Buffer.concat(chunks)),
    tooLarge: false
  };
}

function requestHeaders(incoming: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const part of value) headers.append(name, part);
    } else {
      headers.set(name, value);
    }
  }
  return headers;
}

async function webRequest(incoming: IncomingMessage): Promise<Request> {
  const headers = requestHeaders(incoming);
  const { body, tooLarge } = await collectBody(incoming);
  if (tooLarge) headers.set("content-length", String(HARD_BODY_LIMIT_BYTES + 1));
  const host = headers.get("host") ?? "127.0.0.1";
  const url = new URL(incoming.url ?? "/", `http://${host}`);
  const method = incoming.method ?? "GET";
  return new Request(url, {
    ...(body === undefined ? {} : { body: new TextDecoder().decode(body) }),
    headers,
    method
  });
}

async function send(response: Response, outgoing: ServerResponse): Promise<void> {
  outgoing.statusCode = response.status;
  response.headers.forEach((value, name) => {
    outgoing.setHeader(name, value);
  });
  outgoing.end(Buffer.from(await response.arrayBuffer()));
}

const config = loadWorkerConfig();
const composition = createWorkerComposition(config);
const application = composition.app;
const server = createServer((incoming, outgoing) => {
  void webRequest(incoming)
    .then((request) => application(request))
    .then((response) => send(response, outgoing))
    .catch(() => {
      outgoing.writeHead(500, {
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
        "x-content-type-options": "nosniff"
      });
      outgoing.end('{"code":"provider_unavailable","message":"The worker is unavailable."}');
    });
});

server.listen(config.port, "127.0.0.1");

const close = (): void => {
  server.close(() => {
    void composition.close().finally(() => process.exit(0));
  });
};
process.once("SIGINT", close);
process.once("SIGTERM", close);
