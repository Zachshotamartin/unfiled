import { describe, expect, it } from "vitest";

import {
  AI_MODEL_CATALOG,
  AI_MODEL_CATALOG_VERSION,
  AiModelSelectionSchema,
  AnthropicModelSelectionSchema,
  isAiModelSelectionForProvider,
  OpenAiModelSelectionSchema,
  openApiDocument,
  ProviderKeyDeleteRequestSchema,
  ProviderKeyDeleteResponseSchema,
  ProviderKeyMetadataSchema,
  ProviderKeyPutRequestSchema,
  ProviderKeyQuerySchema,
  PublicByokProviderSchema,
  UserSettingsDtoSchema,
  UserSettingsUpdateRequestSchema
} from "../src/index.js";

const NOW = "2026-09-02T18:30:00.000Z";

const OPENAI_MODELS = ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"] as const;
const ANTHROPIC_MODELS = ["claude-sonnet-5", "claude-opus-5"] as const;

const byokSettings = Object.freeze({
  settingsRevision: 3,
  organizationMode: "balanced",
  providerMode: "byok",
  byokProvider: "openai",
  modelSelection: "auto",
  byokFallbackToApp: false,
  routingEffort: "standard",
  expansionStyle: "brief",
  timezone: "America/Los_Angeles",
  locale: "en-US",
  updatedAt: NOW
} as const);

function catalogEntry(provider: "anthropic" | "openai") {
  const entry = AI_MODEL_CATALOG.providers.find((candidate) => candidate.provider === provider);
  if (entry === undefined) throw new Error(`Missing catalog entry for ${provider}`);
  return entry;
}

function parameterLocations(parameters: readonly Readonly<{ in: string }>[]): readonly string[] {
  return parameters.map((parameter) => parameter.in);
}

function updateRequest(fields: Readonly<Record<string, unknown>>) {
  return UserSettingsUpdateRequestSchema.safeParse({
    expectedSettingsRevision: 3,
    idempotencyKey: "settings-adr-0015",
    ...fields
  });
}

describe("ADR-0015 provider, model, and effort contracts", () => {
  it("publishes exactly the two gated providers", () => {
    expect(PublicByokProviderSchema.options).toEqual(["openai", "anthropic"]);
    expect(PublicByokProviderSchema.safeParse("google").success).toBe(false);
    expect(PublicByokProviderSchema.safeParse("OpenAI").success).toBe(false);
  });

  it("freezes the organization-model-registry-v2 catalog exactly as decided", () => {
    expect(AI_MODEL_CATALOG_VERSION).toBe("organization-model-registry-v2");
    expect(AI_MODEL_CATALOG.version).toBe("organization-model-registry-v2");
    expect(AI_MODEL_CATALOG.effortMapping).toEqual({
      economical: "low",
      standard: "medium",
      thorough: "high"
    });
    expect(AI_MODEL_CATALOG.providers.map((entry) => entry.provider)).toEqual([
      "openai",
      "anthropic"
    ]);
    const openai = catalogEntry("openai");
    const anthropic = catalogEntry("anthropic");
    expect(openai.label).toBe("OpenAI");
    expect(anthropic.label).toBe("Claude");
    expect(openai.models.map((model) => model.value)).toEqual(["auto", ...OPENAI_MODELS]);
    expect(anthropic.models.map((model) => model.value)).toEqual(["auto", ...ANTHROPIC_MODELS]);
    expect(openai.autoByEffort).toEqual({
      economical: "gpt-5.6-luna",
      standard: "gpt-5.6-terra",
      thorough: "gpt-5.6-sol"
    });
    expect(anthropic.autoByEffort).toEqual({
      economical: "claude-sonnet-5",
      standard: "claude-sonnet-5",
      thorough: "claude-opus-5"
    });
    expect(Object.isFrozen(AI_MODEL_CATALOG)).toBe(true);
    expect(Object.isFrozen(AI_MODEL_CATALOG.providers)).toBe(true);
    expect(Object.isFrozen(openai.models)).toBe(true);
    for (const entry of AI_MODEL_CATALOG.providers) {
      for (const model of entry.models) {
        expect(model.label.length).toBeGreaterThan(0);
        expect(model.detail.length).toBeGreaterThan(0);
      }
      for (const resolved of Object.values(entry.autoByEffort)) {
        expect(entry.models.map((model) => model.value)).toContain(resolved);
      }
    }
  });

  it("keeps the per-provider and combined model enums aligned with the catalog", () => {
    expect(OpenAiModelSelectionSchema.options).toEqual(["auto", ...OPENAI_MODELS]);
    expect(AnthropicModelSelectionSchema.options).toEqual(["auto", ...ANTHROPIC_MODELS]);
    expect(AiModelSelectionSchema.options).toEqual(["auto", ...OPENAI_MODELS, ...ANTHROPIC_MODELS]);
    expect(AiModelSelectionSchema.safeParse("gpt-5.5-retired-example").success).toBe(false);
    expect(AiModelSelectionSchema.safeParse("GPT-5.6-LUNA").success).toBe(false);
    expect(AiModelSelectionSchema.safeParse("").success).toBe(false);
  });

  it("checks model compatibility per provider with Automatic always allowed", () => {
    expect(isAiModelSelectionForProvider("openai", "auto")).toBe(true);
    expect(isAiModelSelectionForProvider("anthropic", "auto")).toBe(true);
    for (const model of OPENAI_MODELS) {
      expect(isAiModelSelectionForProvider("openai", model)).toBe(true);
      expect(isAiModelSelectionForProvider("anthropic", model)).toBe(false);
    }
    for (const model of ANTHROPIC_MODELS) {
      expect(isAiModelSelectionForProvider("anthropic", model)).toBe(true);
      expect(isAiModelSelectionForProvider("openai", model)).toBe(false);
    }
  });

  it("accepts every compatible provider/model pair in the settings DTO", () => {
    for (const model of ["auto", ...OPENAI_MODELS] as const) {
      expect(
        UserSettingsDtoSchema.safeParse({ ...byokSettings, modelSelection: model }).success
      ).toBe(true);
    }
    for (const model of ["auto", ...ANTHROPIC_MODELS] as const) {
      expect(
        UserSettingsDtoSchema.safeParse({
          ...byokSettings,
          byokProvider: "anthropic",
          modelSelection: model
        }).success
      ).toBe(true);
    }
  });

  it("rejects cross-provider, unknown, and app-default exact models in the DTO", () => {
    for (const model of ANTHROPIC_MODELS) {
      const result = UserSettingsDtoSchema.safeParse({ ...byokSettings, modelSelection: model });
      expect(result.success).toBe(false);
      expect(result.success ? [] : result.error.issues.map((issue) => issue.path)).toEqual([
        ["modelSelection"]
      ]);
    }
    for (const model of OPENAI_MODELS) {
      expect(
        UserSettingsDtoSchema.safeParse({
          ...byokSettings,
          byokProvider: "anthropic",
          modelSelection: model
        }).success
      ).toBe(false);
    }
    expect(
      UserSettingsDtoSchema.safeParse({ ...byokSettings, modelSelection: "gpt-5.6-nova" }).success
    ).toBe(false);
    expect(
      UserSettingsDtoSchema.safeParse({
        ...byokSettings,
        providerMode: "app_default",
        byokProvider: null,
        modelSelection: "gpt-5.6-terra"
      }).success
    ).toBe(false);
    expect(
      UserSettingsDtoSchema.safeParse({
        ...byokSettings,
        providerMode: "app_default",
        byokProvider: null,
        modelSelection: "auto"
      }).success
    ).toBe(true);
    const { modelSelection: _omitted, ...withoutModel } = byokSettings;
    void _omitted;
    expect(UserSettingsDtoSchema.safeParse(withoutModel).success).toBe(false);
  });

  it("rejects cross-provider, unknown, and app-default exact models in update requests", () => {
    expect(updateRequest({ byokProvider: "openai", modelSelection: "gpt-5.6-sol" }).success).toBe(
      true
    );
    expect(
      updateRequest({ byokProvider: "anthropic", modelSelection: "claude-opus-5" }).success
    ).toBe(true);
    expect(updateRequest({ modelSelection: "claude-sonnet-5" }).success).toBe(true);
    expect(
      updateRequest({ byokProvider: "openai", modelSelection: "claude-sonnet-5" }).success
    ).toBe(false);
    expect(
      updateRequest({ byokProvider: "anthropic", modelSelection: "gpt-5.6-luna" }).success
    ).toBe(false);
    expect(updateRequest({ modelSelection: "gpt-4o" }).success).toBe(false);
    expect(
      updateRequest({ providerMode: "app_default", byokProvider: null, modelSelection: "auto" })
        .success
    ).toBe(true);
    expect(
      updateRequest({
        providerMode: "app_default",
        byokProvider: null,
        modelSelection: "gpt-5.6-terra"
      }).success
    ).toBe(false);
    expect(
      updateRequest({ providerMode: "byok", byokProvider: "anthropic", modelSelection: "auto" })
        .success
    ).toBe(true);
    expect(updateRequest({ providerMode: "byok", byokProvider: null }).success).toBe(false);
    for (const routingEffort of ["economical", "standard", "thorough"] as const) {
      expect(updateRequest({ routingEffort }).success).toBe(true);
    }
    expect(updateRequest({ routingEffort: "maximum" }).success).toBe(false);
    expect(updateRequest({ temperature: 0.2 }).success).toBe(false);
  });

  it("addresses provider-key status by exactly one gated provider", () => {
    expect(ProviderKeyQuerySchema.parse({ provider: "openai" })).toEqual({ provider: "openai" });
    expect(ProviderKeyQuerySchema.parse({ provider: "anthropic" })).toEqual({
      provider: "anthropic"
    });
    expect(ProviderKeyQuerySchema.safeParse({}).success).toBe(false);
    expect(ProviderKeyQuerySchema.safeParse({ provider: null }).success).toBe(false);
    expect(ProviderKeyQuerySchema.safeParse({ provider: "google" }).success).toBe(false);
    expect(ProviderKeyQuerySchema.safeParse({ provider: "openai", extra: "1" }).success).toBe(
      false
    );
    expect(ProviderKeyQuerySchema.safeParse({ provider: ["openai", "anthropic"] }).success).toBe(
      false
    );
  });

  it("carries the provider through Anthropic key metadata and mutations", () => {
    const metadata = {
      provider: "anthropic",
      lastFour: "wxyz",
      status: "active",
      credentialRevision: 2,
      validatedAt: NOW,
      updatedAt: NOW
    } as const;
    expect(ProviderKeyMetadataSchema.parse(metadata)).toEqual(metadata);
    expect(
      ProviderKeyPutRequestSchema.safeParse({
        idempotencyKey: "provider-put-anthropic",
        provider: "anthropic",
        expectedCredentialRevision: 1,
        apiKey: "sk-ant-test-example-not-a-real-key-0000"
      }).success
    ).toBe(true);
    expect(
      ProviderKeyPutRequestSchema.safeParse({
        idempotencyKey: "provider-put-missing-provider",
        expectedCredentialRevision: null,
        apiKey: "sk-ant-test-example-not-a-real-key-0000"
      }).success
    ).toBe(false);
    expect(
      ProviderKeyDeleteRequestSchema.safeParse({
        idempotencyKey: "provider-delete-anthropic",
        provider: "anthropic",
        expectedCredentialRevision: 2
      }).success
    ).toBe(true);
    expect(
      ProviderKeyDeleteRequestSchema.safeParse({
        idempotencyKey: "provider-delete-missing-provider",
        expectedCredentialRevision: 2
      }).success
    ).toBe(false);
    expect(
      ProviderKeyDeleteResponseSchema.safeParse({
        provider: "anthropic",
        deleted: true,
        deletedCredentialRevision: 2,
        replayed: false
      }).success
    ).toBe(true);
  });

  it("publishes the provider enum, model selection, and provider query in OpenAPI", () => {
    const { schemas } = openApiDocument.components;
    const providerEnum = { type: "string", enum: ["openai", "anthropic"] };
    const modelEnum = {
      type: "string",
      enum: ["auto", ...OPENAI_MODELS, ...ANTHROPIC_MODELS]
    };
    expect(schemas.ProviderKeyMetadata).toMatchObject({
      properties: { provider: providerEnum }
    });
    expect(schemas.ProviderKeyPutRequest).toMatchObject({
      properties: { provider: providerEnum }
    });
    expect(schemas.ProviderKeyDeleteRequest).toMatchObject({
      properties: { provider: providerEnum }
    });
    expect(schemas.ProviderKeyDeleteResponse).toMatchObject({
      properties: { provider: providerEnum }
    });
    expect(schemas.ProviderKeyQuery).toEqual({
      type: "object",
      properties: { provider: providerEnum },
      required: ["provider"],
      additionalProperties: false
    });
    expect(schemas.UserSettingsDto).toMatchObject({
      properties: { modelSelection: modelEnum }
    });
    expect(schemas.UserSettingsDto.required).toContain("modelSelection");
    expect(schemas.UserSettingsUpdateRequest).toMatchObject({
      properties: { modelSelection: modelEnum }
    });
    expect(schemas.UserSettingsUpdateRequest.required).not.toContain("modelSelection");
    expect(openApiDocument.paths["/me/provider-key"].get.parameters).toEqual([
      expect.objectContaining({
        name: "provider",
        in: "query",
        required: true,
        schema: providerEnum
      })
    ]);
    for (const method of ["put", "delete"] as const) {
      expect(
        parameterLocations(openApiDocument.paths["/me/provider-key"][method].parameters)
      ).not.toContain("query");
    }
  });
});
