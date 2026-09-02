import {
  ApiErrorCode,
  MAX_AI_SETTINGS_REQUEST_BYTES,
  MAX_PROVIDER_KEY_REQUEST_BYTES,
  ProviderKeyDeleteRequestSchema,
  ProviderKeyDeleteResponseSchema,
  ProviderKeyPutRequestSchema,
  ProviderKeyPutResponseSchema,
  ProviderKeyResponseSchema,
  UserSettingsResponseSchema,
  UserSettingsUpdateRequestSchema,
  UserSettingsUpdateResponseSchema
} from "@unfiled/contracts";

import { authenticateRequest, type AuthenticatedRequest } from "@/server/auth/session";
import { createProductionAiSettingsRepository } from "@/server/ai-settings/production-repository";
import type {
  AiSettingsRepository,
  AiSettingsRepositoryContext
} from "@/server/ai-settings/repository";

import {
  errorResponse,
  HttpError,
  jsonResponse,
  readJsonObject,
  requireIdempotencyKey
} from "./errors";

type Schema<T> = Readonly<{
  safeParse(
    value: unknown
  ):
    | Readonly<{ data: T; success: true }>
    | Readonly<{ error: { issues: readonly unknown[] }; success: false }>;
}>;

export type AiSettingsHandlerDependencies = Readonly<{
  authenticate?: (request: Request) => Promise<AuthenticatedRequest>;
  repository: AiSettingsRepository | ((request: Request) => AiSettingsRepository);
}>;

const PRIVATE_OWNER_CONTENT_CACHE_CONTROL = "private, no-store";

function requestInput<T>(schema: Schema<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new HttpError(
      400,
      ApiErrorCode.VALIDATION_FAILED,
      "Check the fields in this request and try again."
    );
  }
  return parsed.data;
}

function repositoryOutput<T>(schema: Schema<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new HttpError(
      503,
      ApiErrorCode.PROVIDER_UNAVAILABLE,
      "Settings are temporarily unavailable. Try again."
    );
  }
  return parsed.data;
}

function requireNoQuery(request: Request): void {
  if (new URL(request.url).search !== "") {
    throw new HttpError(
      400,
      ApiErrorCode.VALIDATION_FAILED,
      "This endpoint does not accept query parameters."
    );
  }
}

function privateOwnerContentResponse(response: Response): Response {
  response.headers.set("cache-control", PRIVATE_OWNER_CONTENT_CACHE_CONTROL);
  response.headers.set("pragma", "no-cache");
  return response;
}

export function createAiSettingsHandlers(dependencies: AiSettingsHandlerDependencies) {
  const authenticate = dependencies.authenticate ?? authenticateRequest;

  async function run(
    request: Request,
    action: (
      repository: AiSettingsRepository,
      context: AiSettingsRepositoryContext
    ) => Promise<Response>
  ): Promise<Response> {
    try {
      const session = await authenticate(request);
      const repository =
        typeof dependencies.repository === "function"
          ? dependencies.repository(request)
          : dependencies.repository;
      const response = await action(repository, {
        accessToken: session.accessToken,
        userId: session.user.id
      });
      for (const cookie of session.cookies) response.headers.append("set-cookie", cookie);
      return privateOwnerContentResponse(response);
    } catch (error: unknown) {
      return privateOwnerContentResponse(errorResponse(error, request));
    }
  }

  return Object.freeze({
    methodNotAllowed(allow: string): Response {
      return privateOwnerContentResponse(new Response(null, { status: 405, headers: { allow } }));
    },

    getSettings(request: Request) {
      return run(request, async (repository, context) => {
        requireNoQuery(request);
        const output = repositoryOutput(
          UserSettingsResponseSchema,
          await repository.getSettings(context)
        );
        return jsonResponse(output);
      });
    },

    updateSettings(request: Request) {
      return run(request, async (repository, context) => {
        requireNoQuery(request);
        const body = await readJsonObject(request, MAX_AI_SETTINGS_REQUEST_BYTES);
        const input = requestInput(UserSettingsUpdateRequestSchema, body);
        requireIdempotencyKey(request, body);
        const output = repositoryOutput(
          UserSettingsUpdateResponseSchema,
          await repository.updateSettings(context, input)
        );
        return jsonResponse(output);
      });
    },

    getProviderKey(request: Request) {
      return run(request, async (repository, context) => {
        requireNoQuery(request);
        const output = repositoryOutput(
          ProviderKeyResponseSchema,
          await repository.getProviderKey(context)
        );
        return jsonResponse(output);
      });
    },

    putProviderKey(request: Request) {
      return run(request, async (repository, context) => {
        requireNoQuery(request);
        const body = await readJsonObject(request, MAX_PROVIDER_KEY_REQUEST_BYTES);
        let input: ReturnType<typeof ProviderKeyPutRequestSchema.parse> | null = null;
        try {
          input = requestInput(ProviderKeyPutRequestSchema, body);
          requireIdempotencyKey(request, body);
          const output = repositoryOutput(
            ProviderKeyPutResponseSchema,
            await repository.putProviderKey(context, input)
          );
          return jsonResponse(output);
        } finally {
          body.apiKey = "";
          if (input !== null) input.apiKey = "";
        }
      });
    },

    deleteProviderKey(request: Request) {
      return run(request, async (repository, context) => {
        requireNoQuery(request);
        const body = await readJsonObject(request, MAX_PROVIDER_KEY_REQUEST_BYTES);
        const input = requestInput(ProviderKeyDeleteRequestSchema, body);
        requireIdempotencyKey(request, body);
        const output = repositoryOutput(
          ProviderKeyDeleteResponseSchema,
          await repository.deleteProviderKey(context, input)
        );
        return jsonResponse(output);
      });
    }
  });
}

export const aiSettingsHandlers = createAiSettingsHandlers({
  repository: (request) =>
    createProductionAiSettingsRepository({ signalForOperation: () => request.signal })
});
