import { z, type ZodType } from "zod";

import { CaptureCreateRequestSchema, CaptureCreateResponseSchema } from "./captures.js";
import { ApiErrorSchema } from "./errors.js";

function openApiSchema(schema: ZodType): Record<string, unknown> {
  const { $schema: dialect, ...document } = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    unrepresentable: "any"
  });
  void dialect;
  return document;
}

export const openApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "Unfiled API",
    version: "1.0.0",
    description: "Versioned API for durable capture and self-organizing notes."
  },
  servers: [{ url: "/api/v1" }],
  paths: {
    "/captures": {
      post: {
        operationId: "createCapture",
        summary: "Persist a capture and enqueue one organization job",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "Idempotency-Key",
            in: "header",
            required: true,
            description: "Stable per-capture key. The client capture ULID is the canonical value.",
            schema: {
              type: "string",
              pattern: "^cap_[0-9A-HJKMNP-TV-Z]{26}$"
            }
          }
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/CaptureCreateRequest" } }
          }
        },
        responses: {
          "202": {
            description: "Capture durably accepted or idempotently replayed",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/CaptureCreateResponse" } }
            }
          },
          "400": {
            description: "Invalid capture or idempotency key",
            content: { "application/json": { schema: { $ref: "#/components/schemas/ApiError" } } }
          },
          "401": {
            description: "Authentication required",
            content: { "application/json": { schema: { $ref: "#/components/schemas/ApiError" } } }
          }
        }
      }
    }
  },
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" }
    },
    schemas: {
      CaptureCreateRequest: openApiSchema(CaptureCreateRequestSchema),
      CaptureCreateResponse: openApiSchema(CaptureCreateResponseSchema),
      ApiError: openApiSchema(ApiErrorSchema)
    }
  }
} as const;
