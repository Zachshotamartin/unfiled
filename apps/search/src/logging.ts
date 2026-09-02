import type { SearchRuntime } from "./config.js";

export type SearchRoute = "health" | "internal_query" | "unknown";

export type SearchLogEvent = Readonly<{
  durationMs: number;
  errorClass?: string;
  event: "request.completed";
  level: "error" | "info" | "warn";
  method: string;
  outcome: "error" | "ok";
  requestId: string;
  retryable?: boolean;
  route: SearchRoute;
  runtime: SearchRuntime;
  status: number;
}>;

export type SearchLogger = Readonly<{ log(event: SearchLogEvent): void }>;

export function createStructuredSearchLogger(): SearchLogger {
  return Object.freeze({
    log(event) {
      process.stdout.write(`${JSON.stringify(event)}\n`);
    }
  });
}
