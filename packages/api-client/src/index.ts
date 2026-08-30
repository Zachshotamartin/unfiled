import {
  ApiErrorSchema,
  CaptureCreateRequestSchema,
  CaptureCreateResponseSchema,
  type ApiError,
  type CaptureCreateRequest,
  type CaptureCreateResponse
} from "@unfiled/contracts";
import type { ZodType } from "zod";

export class ApiClientError extends Error {
  public readonly error: ApiError;
  public readonly status: number;

  public constructor(status: number, error: ApiError) {
    super(error.message);
    this.name = "ApiClientError";
    this.status = status;
    this.error = error;
  }
}

export type ApiClientOptions = Readonly<{
  baseUrl: string;
  getAccessToken: () => Promise<string | null>;
  fetch?: typeof globalThis.fetch;
}>;

async function decode<T>(response: Response, schema: ZodType<T>): Promise<T> {
  const body: unknown = await response.json();
  if (!response.ok) throw new ApiClientError(response.status, ApiErrorSchema.parse(body));
  return schema.parse(body);
}

export function createApiClient(options: ApiClientOptions) {
  const fetcher = options.fetch ?? globalThis.fetch;
  const baseUrl = options.baseUrl.replace(/\/$/u, "");

  return Object.freeze({
    async createCapture(input: CaptureCreateRequest): Promise<CaptureCreateResponse> {
      const request = CaptureCreateRequestSchema.parse(input);
      const token = await options.getAccessToken();
      const response = await fetcher(`${baseUrl}/api/v1/captures`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": request.clientCaptureId,
          ...(token ? { authorization: `Bearer ${token}` } : {})
        },
        body: JSON.stringify(request)
      });
      return decode(response, CaptureCreateResponseSchema);
    }
  });
}
