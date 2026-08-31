export type WorkerLogLevel = "error" | "info" | "warn";
export type WorkerRoute = "health" | "internal_drain" | "unknown";

export type WorkerOperationalEvent = Readonly<{
  durationMs: number;
  errorClass?: "configuration" | "http" | "timeout" | "unknown" | "unavailable";
  event: "request.completed";
  level: WorkerLogLevel;
  method: string;
  outcome: "error" | "ok";
  requestId: string;
  retryable?: boolean;
  route: WorkerRoute;
  runtime: "local" | "preview" | "production" | "unknown";
  status: number;
}>;

export type WorkerLogSink = (serializedEvent: string) => void;

export type WorkerLogger = Readonly<{
  log(event: WorkerOperationalEvent): void;
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

function safeEvent(event: WorkerOperationalEvent, now: () => Date): Record<string, unknown> {
  const candidate: Record<string, unknown> = {
    ...event,
    service: "unfiled-worker",
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
  sink: WorkerLogSink = (line) => {
    console.info(line);
  },
  now: () => Date = () => new Date()
): WorkerLogger {
  return Object.freeze({
    log(event) {
      sink(JSON.stringify(safeEvent(event, now)));
    }
  });
}
