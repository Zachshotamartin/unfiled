import { executeReleaseProbeCli } from "./deployed-release-probe.js";

const execution = await executeReleaseProbeCli(process.argv.slice(2), process.env, {
  fetch: globalThis.fetch
});

process.stdout.write(execution.stdout);
if (execution.stderr.length > 0) process.stderr.write(execution.stderr);
process.exitCode = execution.exitCode;
