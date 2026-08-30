export interface SmokeEvaluationResult {
  readonly corpusVersion: string;
  readonly cases: number;
  readonly passed: boolean;
}

export function smokeEvaluationExitCode(result: SmokeEvaluationResult): 0 | 1 {
  return result.passed ? 0 : 1;
}
