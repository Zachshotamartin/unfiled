export type VerifierRoute = "health" | "internal_verify" | "unknown";

export type VerifierOperationalEvent = Readonly<{
  durationMs: number;
  errorClass?: "configuration" | "generation" | "http" | "timeout" | "unknown" | "unavailable";
  event: "request.completed";
  level: "error" | "info" | "warn";
  method: string;
  outcome: "error" | "ok";
  requestId: string;
  retryable?: boolean;
  route: VerifierRoute;
  runtime: "local" | "preview" | "production" | "unknown";
  status: number;
}>;

export type VerifierLogger = Readonly<{
  log(event: VerifierOperationalEvent): void;
}>;

const SAFE_FIELDS = [
  "durationMs",
  "errorClass",
  "event",
  "level",
  "method",
  "outcome",
  "requestId",
  "retryable",
  "route",
  "runtime",
  "service",
  "status",
  "timestamp"
] as const;

function safeEvent(event: VerifierOperationalEvent, now: () => Date): Record<string, unknown> {
  const candidate: Record<string, unknown> = {
    ...event,
    service: "unfiled-rag-verifier",
    timestamp: now().toISOString()
  };
  const output: Record<string, unknown> = {};
  for (const key of SAFE_FIELDS) {
    const value = candidate[key];
    if (value !== undefined) output[key] = value;
  }
  return output;
}

export function createStructuredLogger(
  sink: (serializedEvent: string) => void = (line) => {
    console.info(line);
  },
  now: () => Date = () => new Date()
): VerifierLogger {
  return Object.freeze({
    log(event): void {
      sink(JSON.stringify(safeEvent(event, now)));
    }
  });
}
