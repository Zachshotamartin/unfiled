import { strict as assert } from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

const host = "127.0.0.1";
const appDirectory = fileURLToPath(new URL("../..", import.meta.url));

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function unusedPort(): Promise<number> {
  const reservation = createServer();
  reservation.listen(0, host);
  await once(reservation, "listening");
  const address = reservation.address();
  if (address === null || typeof address === "string") {
    reservation.close();
    throw new Error("Could not reserve a smoke-test port.");
  }
  const port = address.port;
  reservation.close();
  await once(reservation, "close");
  return port;
}

async function stop(child: ChildProcess): Promise<void> {
  const hasExited = (): boolean => child.exitCode !== null;
  if (hasExited()) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), delay(1_000)]);
  if (hasExited()) return;
  child.kill("SIGKILL");
  await once(child, "exit");
}

const port = await unusedPort();
const child = spawn(process.execPath, ["dist/server.js"], {
  cwd: appDirectory,
  env: {
    PORT: String(port),
    UNFILED_VERIFIER_ENV: "local"
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
    if (child.exitCode !== null) {
      throw new Error(`Built verifier exited before health check.\n${output}`);
    }
    try {
      response = await fetch(`http://${host}:${port}/health`, {
        signal: AbortSignal.timeout(250)
      });
      break;
    } catch {
      await delay(50);
    }
  }
  if (response === undefined) throw new Error(`Built verifier did not become ready.\n${output}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body: unknown = await response.json();
  assert.deepEqual(body, { service: "unfiled-rag-verifier", status: "ok" });
  process.stdout.write("built verifier /health smoke passed\n");
} finally {
  await stop(child);
}
