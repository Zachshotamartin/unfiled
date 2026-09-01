import { describe, expect, it } from "vitest";

import {
  FLOAT32_LE_BASE64URL_ENCODING,
  buildFloat32LeEmbedding,
  decodeFloat32LeBase64Url,
  encodeFloat32LeBase64Url,
  parseFloat32LeEmbedding
} from "../src/index.js";
import type { PrivateRagValidationError } from "../src/index.js";

describe("strict f32le-base64url embeddings", () => {
  it("uses a stable little-endian, unpadded base64url representation", () => {
    expect(encodeFloat32LeBase64Url([1, 2, 3])).toBe("AACAPwAAAEAAAEBA");
    expect([...decodeFloat32LeBase64Url("AACAPwAAAEAAAEBA", 3)]).toEqual([1, 2, 3]);
  });

  it("builds and parses an exactly versioned, model-bound value", () => {
    const value = buildFloat32LeEmbedding({ modelId: "embed.v1", values: [0.25, -2] });
    expect(value).toEqual({
      schemaVersion: 1,
      encoding: FLOAT32_LE_BASE64URL_ENCODING,
      modelId: "embed.v1",
      dimensions: 2,
      data: "AACAPgAAAMA"
    });
    const parsed = parseFloat32LeEmbedding(value, { modelId: "embed.v1", dimensions: 2 });
    expect([...parsed.values]).toEqual([0.25, -2]);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1e40])(
    "rejects a non-finite or float32-overflowing component %s",
    (component) => {
      expect(() => encodeFloat32LeBase64Url([component])).toThrow(
        expect.objectContaining<Partial<PrivateRagValidationError>>({
          code: "non_finite_embedding"
        })
      );
    }
  );

  it("rejects non-canonical base64url and encoded NaN", () => {
    expect(() => decodeFloat32LeBase64Url("AACAPw==", 1)).toThrow(
      expect.objectContaining({ code: "invalid_base64url" })
    );
    expect(() => decodeFloat32LeBase64Url("AACAPx", 1)).toThrow(
      expect.objectContaining({ code: "invalid_base64url" })
    );
    expect(() => decodeFloat32LeBase64Url("AACAPgAAAMB", 2)).toThrow(
      expect.objectContaining({ code: "invalid_base64url" })
    );
    expect(() => decodeFloat32LeBase64Url("AADAfw", 1)).toThrow(
      expect.objectContaining({ code: "non_finite_embedding" })
    );
  });

  it("rejects unknown fields, versions, encoding, model and dimensions", () => {
    const value = buildFloat32LeEmbedding({ modelId: "embed.v1", values: [1] });
    expect(() => parseFloat32LeEmbedding({ ...value, extra: true })).toThrow(
      expect.objectContaining({ code: "invalid_shape" })
    );
    expect(() => parseFloat32LeEmbedding({ ...value, schemaVersion: 2 })).toThrow(
      expect.objectContaining({ code: "unsupported_version" })
    );
    expect(() => parseFloat32LeEmbedding({ ...value, encoding: "float32" })).toThrow(
      expect.objectContaining({ code: "unsupported_encoding" })
    );
    expect(() => parseFloat32LeEmbedding(value, { modelId: "embed.v2" })).toThrow(
      expect.objectContaining({ code: "context_mismatch" })
    );
    expect(() => decodeFloat32LeBase64Url(value.data, 2)).toThrow(
      expect.objectContaining({ code: "invalid_base64url" })
    );
  });
});
