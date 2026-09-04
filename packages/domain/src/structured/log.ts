import {
  ApiErrorCode,
  LOG_FIELD_VALUE_MAX_CHARACTERS,
  LogStructuredDataSchema,
  type LogFieldValue,
  type LogStructuredData
} from "@unfiled/contracts";

import { DomainError } from "../errors.js";
import type { EntityIdFactory } from "../id-factory.js";

const numericValue = /^-?(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)$/u;

function conflict(message: string): never {
  throw new DomainError(ApiErrorCode.STRUCTURE_CONFLICT, message);
}

function validOccurredAt(value: string): boolean {
  return LogStructuredDataSchema.safeParse({
    schemaVersion: 1,
    entries: [{ id: "ent_00000000000000000000000000", occurredAt: value, fields: {} }]
  }).success;
}

function validFieldKey(value: string): boolean {
  return (
    value === value.trim() && value.length >= 1 && value.length <= 80 && !/[:\r\n]/u.test(value)
  );
}

function quotedString(value: string): boolean {
  return (
    value === "null" ||
    numericValue.test(value) ||
    value.startsWith('"') ||
    value !== value.trim() ||
    /[\r\n]/u.test(value)
  );
}

function renderNumber(value: number): string {
  if (Object.is(value, -0)) return "0";
  const source = String(value);
  const exponent = /^(-?)([0-9]+)(?:\.([0-9]+))?[eE]([+-]?[0-9]+)$/u.exec(source);
  if (exponent === null) return source;
  const sign = exponent[1] ?? "";
  const whole = exponent[2] ?? "";
  const fraction = exponent[3] ?? "";
  const digits = `${whole}${fraction}`;
  const decimalPosition = whole.length + Number(exponent[4]);
  if (decimalPosition <= 0) {
    return `${sign}0.${"0".repeat(-decimalPosition)}${digits}`;
  }
  if (decimalPosition >= digits.length) {
    return `${sign}${digits}${"0".repeat(decimalPosition - digits.length)}`;
  }
  return `${sign}${digits.slice(0, decimalPosition)}.${digits.slice(decimalPosition)}`;
}

function renderValue(value: LogFieldValue): string {
  if (value === null) return "null";
  if (typeof value === "string" && quotedString(value)) return JSON.stringify(value);
  return typeof value === "number" ? renderNumber(value) : value;
}

export function renderLogMarkdown(data: LogStructuredData): string {
  const parsed = LogStructuredDataSchema.parse(data);
  return [...parsed.entries]
    .sort(
      (left, right) =>
        left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id)
    )
    .map((entry) => {
      const fields = Object.entries(entry.fields)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => {
          if (!validFieldKey(key)) conflict("Log field keys cannot contain colons or newlines");
          return `- ${key}: ${renderValue(value)}`;
        });
      return [`## ${entry.occurredAt}`, "", ...fields].join("\n");
    })
    .join("\n\n");
}

function parseFieldValue(source: string): LogFieldValue {
  if (source.startsWith('"') && source.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(source);
      if (typeof parsed !== "string" || parsed.length > LOG_FIELD_VALUE_MAX_CHARACTERS) {
        return conflict("Quoted log values must decode to a bounded string");
      }
      return parsed;
    } catch {
      return conflict("Quoted log values must be valid JSON strings");
    }
  }
  if (source === "null") return null;
  if (numericValue.test(source)) {
    const parsed = Number(source);
    if (!Number.isFinite(parsed)) return conflict("Log numbers must be finite");
    return parsed;
  }
  if (source.length > LOG_FIELD_VALUE_MAX_CHARACTERS) {
    return conflict(`Log field values are limited to ${LOG_FIELD_VALUE_MAX_CHARACTERS} characters`);
  }
  return source;
}

export function reconcileLogMarkdown(
  previous: LogStructuredData,
  markdown: string,
  idFactory: EntityIdFactory
): LogStructuredData {
  const priorResult = LogStructuredDataSchema.safeParse(previous);
  if (!priorResult.success) return conflict("Log note structure is invalid");
  const prior = priorResult.data;
  const priorIds = new Set<string>();
  const priorByTime = new Map<string, typeof prior.entries>();
  for (const entry of prior.entries) {
    if (priorIds.has(entry.id)) return conflict("Duplicate log entry IDs are ambiguous");
    priorIds.add(entry.id);
    for (const key of Object.keys(entry.fields)) {
      if (!validFieldKey(key)) return conflict("Log field keys cannot contain colons or newlines");
    }
    const entries = priorByTime.get(entry.occurredAt) ?? [];
    priorByTime.set(entry.occurredAt, [...entries, entry]);
  }
  for (const entries of priorByTime.values()) {
    entries.sort((left, right) => left.id.localeCompare(right.id));
  }

  const occurrences = new Map<string, number>();
  const entries: (typeof prior.entries)[number][] = [];
  let current:
    | {
        fields: Record<string, LogFieldValue>;
        id: (typeof prior.entries)[number]["id"];
        occurredAt: string;
      }
    | undefined;

  const finish = (): void => {
    if (current === undefined) return;
    entries.push({ id: current.id, occurredAt: current.occurredAt, fields: current.fields });
  };

  for (const line of markdown.split(/\r?\n/u)) {
    if (line.trim().length === 0) continue;
    const heading = /^##\s+(\S(?:.*?\S)?)\s*$/u.exec(line);
    if (heading?.[1]) {
      finish();
      const occurredAt = heading[1];
      if (!validOccurredAt(occurredAt)) conflict("Log headings must be ISO-offset timestamps");
      const occurrence = occurrences.get(occurredAt) ?? 0;
      occurrences.set(occurredAt, occurrence + 1);
      const id = priorByTime.get(occurredAt)?.[occurrence]?.id ?? idFactory("ent");
      current = { fields: {}, id, occurredAt };
      continue;
    }

    const field = /^\s*-\s+([^:]+):\s*(.*)$/u.exec(line);
    if (current === undefined || !field?.[1] || field[2] === undefined) {
      conflict("Log Markdown contains a non-log line");
    }
    const key = field[1].trim();
    if (!validFieldKey(key) || Object.hasOwn(current.fields, key)) {
      conflict("Log field keys must be unique and unambiguous");
    }
    current.fields[key] = parseFieldValue(field[2]);
  }
  finish();

  const parsed = LogStructuredDataSchema.safeParse({ schemaVersion: 1, entries });
  if (!parsed.success) return conflict("Log Markdown exceeds the structured-data contract");
  return parsed.data;
}
