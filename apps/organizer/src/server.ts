import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { createOrganizerComposition } from "./composition.js";
import { loadOrganizerConfig } from "./config.js";

const HARD_BODY_LIMIT = 16_384;
async function requestFrom(incoming: IncomingMessage): Promise<Request> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const part of value) headers.append(name, part);
    else headers.set(name, value);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  if (incoming.method !== "GET" && incoming.method !== "HEAD") {
    for await (const value of incoming) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
      size += chunk.byteLength;
      if (size > HARD_BODY_LIMIT) {
        tooLarge = true;
        incoming.resume();
        break;
      }
      chunks.push(chunk);
    }
  }
  if (tooLarge) headers.set("content-length", String(HARD_BODY_LIMIT + 1));
  const body = size === 0 || tooLarge ? undefined : Buffer.concat(chunks);
  return new Request(new URL(incoming.url ?? "/", `http://${headers.get("host") ?? "127.0.0.1"}`), {
    ...(body === undefined ? {} : { body }),
    headers,
    method: incoming.method ?? "GET"
  });
}
async function send(response: Response, outgoing: ServerResponse): Promise<void> {
  outgoing.statusCode = response.status;
  response.headers.forEach((value, name) => outgoing.setHeader(name, value));
  outgoing.end(Buffer.from(await response.arrayBuffer()));
}
const config = loadOrganizerConfig();
const composition = createOrganizerComposition(config);
const server = createServer((incoming, outgoing) => {
  void requestFrom(incoming)
    .then(composition.app)
    .then((response) => send(response, outgoing))
    .catch(() => {
      outgoing.writeHead(500, {
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
        "x-content-type-options": "nosniff"
      });
      outgoing.end('{"code":"provider_unavailable","message":"The organizer is unavailable."}');
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
