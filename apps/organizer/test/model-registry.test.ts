import { AI_MODEL_CATALOG, AI_MODEL_CATALOG_VERSION } from "@unfiled/contracts";
import { describe, expect, it } from "vitest";

import {
  ANTHROPIC_MODEL_IDS,
  OPENAI_MODEL_IDS,
  ORGANIZER_MODEL_IDS,
  ORGANIZER_MODEL_REGISTRY_VERSION,
  isOrganizerModelId,
  isOrganizerModelSelection,
  isOrganizerProvider,
  modelIdBelongsToProvider,
  providerNativeEffort,
  resolveOrganizerModelId
} from "../src/model-registry.js";

describe("organizer model registry v2", () => {
  it("mirrors the shared contracts catalog exactly", () => {
    expect(ORGANIZER_MODEL_REGISTRY_VERSION).toBe("organization-model-registry-v2");
    expect(ORGANIZER_MODEL_REGISTRY_VERSION).toBe(AI_MODEL_CATALOG_VERSION);
    expect(OPENAI_MODEL_IDS).toEqual(["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"]);
    expect(ANTHROPIC_MODEL_IDS).toEqual(["claude-sonnet-5", "claude-opus-5"]);
    expect(ORGANIZER_MODEL_IDS).toHaveLength(5);
    expect(AI_MODEL_CATALOG.providers.map(({ provider }) => provider)).toEqual([
      "openai",
      "anthropic"
    ]);
  });

  it("resolves Automatic deterministically and refuses cross-provider choices", () => {
    expect(resolveOrganizerModelId("openai", "auto", "economical")).toBe("gpt-5.6-luna");
    expect(resolveOrganizerModelId("openai", "auto", "standard")).toBe("gpt-5.6-terra");
    expect(resolveOrganizerModelId("openai", "auto", "thorough")).toBe("gpt-5.6-sol");
    expect(resolveOrganizerModelId("anthropic", "auto", "economical")).toBe("claude-sonnet-5");
    expect(resolveOrganizerModelId("anthropic", "auto", "standard")).toBe("claude-sonnet-5");
    expect(resolveOrganizerModelId("anthropic", "auto", "thorough")).toBe("claude-opus-5");
    expect(resolveOrganizerModelId("openai", "gpt-5.6-luna", "thorough")).toBe("gpt-5.6-luna");
    expect(resolveOrganizerModelId("anthropic", "claude-opus-5", "economical")).toBe(
      "claude-opus-5"
    );
    expect(resolveOrganizerModelId("openai", "claude-sonnet-5", "standard")).toBeNull();
    expect(resolveOrganizerModelId("anthropic", "gpt-5.6-terra", "standard")).toBeNull();
    expect(modelIdBelongsToProvider("openai", "claude-opus-5")).toBe(false);
    expect(modelIdBelongsToProvider("anthropic", "claude-opus-5")).toBe(true);
    expect(modelIdBelongsToProvider("openai", "gpt-latest")).toBe(false);
  });

  it("maps the stable wire effort to provider-native low/medium/high", () => {
    expect(providerNativeEffort("economical")).toBe("low");
    expect(providerNativeEffort("standard")).toBe("medium");
    expect(providerNativeEffort("thorough")).toBe("high");
  });

  it("classifies unknown values as outside the registry", () => {
    expect(isOrganizerProvider("openai")).toBe(true);
    expect(isOrganizerProvider("google")).toBe(false);
    expect(isOrganizerModelSelection("auto")).toBe(true);
    expect(isOrganizerModelSelection("gpt-5.4-mini-2026-03-17")).toBe(false);
    expect(isOrganizerModelId("auto")).toBe(false);
    expect(isOrganizerModelId("claude-sonnet-5")).toBe(true);
    expect(isOrganizerModelId(5)).toBe(false);
  });
});
