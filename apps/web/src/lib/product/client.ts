import type { ApiError } from "@unfiled/contracts";

export class ProductApiError extends Error {
  public readonly body: ApiError;
  public readonly status: number;

  public constructor(status: number, body: ApiError) {
    super(body.message);
    this.name = "ProductApiError";
    this.status = status;
    this.body = body;
  }
}

function isApiError(value: unknown): value is ApiError {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.code === "string" &&
    typeof record.message === "string" &&
    typeof record.requestId === "string"
  );
}

export function createIdempotencyKey(): string {
  return `web_${crypto.randomUUID()}`;
}

export async function productRequest<T>(
  url: string,
  init?: RequestInit & { readonly idempotencyKey?: string }
): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  if (init?.idempotencyKey !== undefined) {
    headers.set("idempotency-key", init.idempotencyKey);
  }

  let response: Response;
  try {
    response = await fetch(url, { ...init, headers });
  } catch {
    throw new ProductApiError(0, {
      code: "offline",
      message: "You appear to be offline. Reconnect and try again.",
      requestId: "client-offline"
    });
  }

  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    if (isApiError(body)) throw new ProductApiError(response.status, body);
    throw new ProductApiError(response.status, {
      code: "provider_unavailable",
      message: "Unfiled could not complete that request. Try again.",
      requestId: response.headers.get("x-request-id") ?? "unknown"
    });
  }
  return body as T;
}

export function announceProductChange(entity: string): void {
  window.dispatchEvent(new CustomEvent("unfiled:change", { detail: entity }));
  if ("BroadcastChannel" in window) {
    const channel = new BroadcastChannel("unfiled-product-events");
    channel.postMessage(entity);
    channel.close();
  }
}
