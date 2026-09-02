import { runSeedCli } from "./seed-core.js";

process.exitCode = await runSeedCli(process.argv.slice(2));
