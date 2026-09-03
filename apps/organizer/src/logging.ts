export type OrganizerRoute = "health" | "internal_drain" | "unknown";
export type OrganizerRequestEvent = Readonly<{
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

/** One failed organizer job: its safe error code, whether it will retry, and where it threw. */
export type OrganizerJobFailureEvent = Readonly<{
  event: "organizer.job_failed";
  level: "error";
  errorCode: string;
  retryable: boolean;
  errorName?: string;
  origin?: string;
  providerStatus?: number;
}>;

export type OrganizerOperationalEvent = OrganizerRequestEvent | OrganizerJobFailureEvent;
export type OrganizerLogger = Readonly<{ log(event: OrganizerOperationalEvent): void }>;

/** The first stack frame of an error as file:function, content-free; undefined when unknown. */
export function errorOrigin(error: unknown): string | undefined {
  if (!(error instanceof Error) || typeof error.stack !== "string") return undefined;
  const frame = error.stack.split("\n").find((line) => /^\s*at /u.test(line));
  if (frame === undefined) return undefined;
  const match = /at (?:async )?([A-Za-z0-9_.$<>]+)? ?\(?([^()\s]+?)(?::\d+){1,2}\)?$/u.exec(
    frame.trim()
  );
  if (match === null) return undefined;
  const fn = match[1] ?? "anonymous";
  const file = (match[2] ?? "").split("/").pop() ?? "";
  const site = `${file.replace(/[^A-Za-z0-9_.-]/gu, "")}:${fn.replace(/[^A-Za-z0-9_.$<>]/gu, "")}`;
  return site.length > 1 && site.length <= 120 ? site : undefined;
}
const SAFE_FIELDS = [
  "causeName",
  "durationMs",
  "origin",
  "errorClass",
  "errorCode",
  "errorName",
  "providerStatus",
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
