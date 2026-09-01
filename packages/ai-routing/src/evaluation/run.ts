import { loadRoutingEvaluationCorpus } from "./corpus.js";
import { evaluateRoutingCorpus, routingEvaluationExitCode } from "./harness.js";

try {
  const corpus = await loadRoutingEvaluationCorpus();
  const report = evaluateRoutingCorpus(corpus);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = routingEvaluationExitCode(report);
} catch (error: unknown) {
  process.stderr.write(
    `${JSON.stringify({ passed: false, error: error instanceof Error ? error.message : "Routing evaluation failed" })}\n`
  );
  process.exitCode = 1;
}
