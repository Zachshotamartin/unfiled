import type { PayloadCodec } from "./payloads.js";
import {
  EncryptedAggregateError,
  EncryptedAggregateErrorCode,
  aggregateFailure
} from "./errors.js";

const MAX_DEPTH = 64;
const MAX_NODES = 100_000;
const FORBIDDEN_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);

interface CanonicalState {
  ancestors: Set<object>;
  nodes: number;
}

function compareKeys(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function nextNode(state: CanonicalState): void {
  state.nodes += 1;
  if (state.nodes > MAX_NODES) {
    aggregateFailure(EncryptedAggregateErrorCode.PAYLOAD_INVALID, "Payload is invalid");
  }
}

function canonicalValue(value: unknown, depth: number, state: CanonicalState): unknown {
  nextNode(state);
  if (depth > MAX_DEPTH) {
    aggregateFailure(EncryptedAggregateErrorCode.PAYLOAD_INVALID, "Payload is invalid");
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      aggregateFailure(EncryptedAggregateErrorCode.PAYLOAD_INVALID, "Payload is invalid");
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") {
    aggregateFailure(EncryptedAggregateErrorCode.PAYLOAD_INVALID, "Payload is invalid");
  }
  if (state.ancestors.has(value)) {
    aggregateFailure(EncryptedAggregateErrorCode.PAYLOAD_INVALID, "Payload is invalid");
  }
  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (
        Object.getOwnPropertySymbols(value).length > 0 ||
        Object.keys(value).some((key) => !/^(?:0|[1-9][0-9]*)$/u.test(key))
      ) {
        aggregateFailure(EncryptedAggregateErrorCode.PAYLOAD_INVALID, "Payload is invalid");
      }
      const result: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          aggregateFailure(EncryptedAggregateErrorCode.PAYLOAD_INVALID, "Payload is invalid");
        }
        result.push(canonicalValue(value[index], depth + 1, state));
      }
      return result;
    }

    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      aggregateFailure(EncryptedAggregateErrorCode.PAYLOAD_INVALID, "Payload is invalid");
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.getOwnPropertySymbols(value).length > 0) {
      aggregateFailure(EncryptedAggregateErrorCode.PAYLOAD_INVALID, "Payload is invalid");
    }
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(descriptors).sort(compareKeys)) {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor) ||
        FORBIDDEN_OBJECT_KEYS.has(key)
      ) {
        aggregateFailure(EncryptedAggregateErrorCode.PAYLOAD_INVALID, "Payload is invalid");
      }
      result[key] = canonicalValue(descriptor.value, depth + 1, state);
    }
    return result;
  } finally {
    state.ancestors.delete(value);
  }
}

export function parsePayload<Value>(codec: PayloadCodec<Value>, value: unknown): Value {
  try {
    return codec.parse(value);
  } catch {
    aggregateFailure(EncryptedAggregateErrorCode.PAYLOAD_INVALID, "Payload is invalid");
  }
}

export function canonicalPayloadBytes<Value>(
  codec: PayloadCodec<Value>,
  value: unknown
): Readonly<{ parsed: Value; bytes: Uint8Array }> {
  const parsed = parsePayload(codec, value);
  const canonical = canonicalValue(parsed, 0, { ancestors: new Set(), nodes: 0 });
  return Object.freeze({ parsed, bytes: new TextEncoder().encode(JSON.stringify(canonical)) });
}

export function decodePayload<Value>(bytes: Uint8Array, codec: PayloadCodec<Value>): Value {
  try {
    const serialized = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return parsePayload(codec, JSON.parse(serialized) as unknown);
  } catch (error: unknown) {
    if (error instanceof EncryptedAggregateError) throw error;
    aggregateFailure(EncryptedAggregateErrorCode.PAYLOAD_INVALID, "Payload is invalid");
  }
}
