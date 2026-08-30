import { DeterministicOrganizationModel } from "../fake-model.js";
import { smokeEvaluationExitCode, type SmokeEvaluationResult } from "./smoke.js";

const model = new DeterministicOrganizationModel();
const result = await model.plan({
  captureId: "cap_01J6M9Q7G4BMKB33GSG3NJ6D1X",
  text: "shopping: milk and batteries",
  inferredKind: "list_items",
  candidates: [
    {
      candidateId: "note_01J6M9Q7G4BMKB33GSG3NJ6D1Y",
      title: "Shopping",
      type: "list",
      spacePath: "Shopping",
      isOpen: true,
      ageBucket: "today",
      headings: ["Open items"],
      latestSnippet: "eggs"
    }
  ]
});

const evaluation: SmokeEvaluationResult = {
  corpusVersion: "milestone-a-smoke",
  cases: 1,
  passed: result.decision === "append_to_note"
};

process.stdout.write(`${JSON.stringify(evaluation, null, 2)}\n`);
process.exitCode = smokeEvaluationExitCode(evaluation);
