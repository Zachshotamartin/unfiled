import { strict as assert } from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

const host = "127.0.0.1";
const directory = fileURLToPath(new URL("../..", import.meta.url));
const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function unusedPort(): Promise<number> {
  const reservation = createServer();
  reservation.listen(0, host);
  await once(reservation, "listening");
  const address = reservation.address();
  if (address === null || typeof address === "string") {
    throw new Error("Could not reserve a search smoke-test port.");
  }
  reservation.close();
  await once(reservation, "close");
  return address.port;
}

function running(child: ChildProcess): boolean {
  return child.exitCode === null;
}

async function stop(child: ChildProcess): Promise<void> {
  if (!running(child)) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), delay(1_000)]);
  if (!running(child)) return;
  child.kill("SIGKILL");
  await once(child, "exit");
}

const port = await unusedPort();
const child = spawn(process.execPath, ["dist/server.js"], {
  cwd: directory,
  env: {
    PORT: String(port),
    UNFILED_SEARCH_ENV: "local",
    UNFILED_SEARCH_INVOCATION_SECRET: "built-search-smoke-secret-at-least-32-characters"
  },
  stdio: ["ignore", "pipe", "pipe"]
});
let output = "";
for (const stream of [child.stdout, child.stderr]) {
  stream.on("data", (chunk: Buffer) => {
    output = `${output}${String(chunk)}`.slice(-8_192);
  });
}

try {
  let response: Response | undefined;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Built search exited early.\n${output}`);
    try {
      response = await fetch(`http://${host}:${port}/health`, {
        signal: AbortSignal.timeout(250)
      });
      break;
    } catch {
      await delay(50);
    }
  }
  if (response === undefined) throw new Error(`Built search did not become ready.\n${output}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { service: "unfiled-search", status: "ok" });
  process.stdout.write("built search /health smoke passed\n");
} finally {
  await stop(child);
}
