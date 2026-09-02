export type OrganizerRoute = "health" | "internal_drain" | "unknown";
export type OrganizerOperationalEvent = Readonly<{
  causeName?: string;
  origin?: string;
  durationMs: number;
  errorClass?: "configuration" | "http" | "timeout" | "unknown" | "unavailable";
  event: "request.completed";
  level: "error" | "info" | "warn";
  method: string;
  outcome: "error" | "ok";
  requestId: string;
  retryable?: boolean;
  route: OrganizerRoute;
  runtime: "local" | "preview" | "production" | "unknown";
  status: number;
}>;
export type OrganizerLogger = Readonly<{ log(event: OrganizerOperationalEvent): void }>;
const SAFE_FIELDS = [
  "causeName",
  "durationMs",
  "origin",
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

export function createStructuredLogger(
  sink: (line: string) => void = (line) => console.info(line),
  now: () => Date = () => new Date()
): OrganizerLogger {
  return Object.freeze({
    log(event) {
      const candidate: Record<string, unknown> = {
        ...event,
        service: "unfiled-organizer",
        timestamp: now().toISOString()
      };
      const output: Record<string, unknown> = {};
      for (const key of SAFE_FIELDS) if (candidate[key] !== undefined) output[key] = candidate[key];
      sink(JSON.stringify(output));
    }
  });
}
