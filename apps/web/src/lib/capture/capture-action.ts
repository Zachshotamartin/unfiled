import {
  ApiErrorCodeSchema,
  CaptureDeleteRequestSchema,
  CaptureRetryRequestSchema,
  MutationUndoRequestSchema,
  entityIdSchema,
  type ApiErrorCodeValue,
  type CaptureDeleteRequest,
  type CaptureRetryRequest,
  type EntityId,
  type MutationUndoRequest
} from "@unfiled/contracts";

export type CaptureActionSchedule = Readonly<{
  attempts: number;
  errorCode: ApiErrorCodeValue | null;
  nextAttemptAt: number | null;
}>;

export type RetryCaptureIntent = CaptureActionSchedule &
  Readonly<{
    actionType: "retry_capture";
    captureId: EntityId<"cap">;
    createdAt: number;
    request: CaptureRetryRequest;
    state: "pending";
    updatedAt: number;
  }>;

export type DeleteCaptureIntent = CaptureActionSchedule &
  Readonly<{
    actionType: "delete_capture";
    captureId: EntityId<"cap">;
    createdAt: number;
    request: CaptureDeleteRequest;
    state: "pending";
    updatedAt: number;
  }>;

export type UndoMutationIntent = CaptureActionSchedule &
  Readonly<{
    actionType: "undo_mutation";
    captureId: EntityId<"cap">;
    createdAt: number;
    mutationId: EntityId<"mut">;
    noteId: EntityId<"note"> | null;
    request: MutationUndoRequest;
    source: "receipt" | "delete_content";
    state: "available" | "pending" | "consumed";
    updatedAt: number;
  }>;

export type CaptureTombstone = Readonly<{
  actionType: "capture_tombstone";
  captureId: EntityId<"cap">;
  createdAt: number;
  deletedAt: string;
  updatedAt: number;
}>;

export type CaptureLocalAction =
  RetryCaptureIntent | DeleteCaptureIntent | UndoMutationIntent | CaptureTombstone;

export function retryCaptureActionId(captureId: EntityId<"cap">): string {
  return `retry:${captureId}`;
}

export function deleteCaptureActionId(captureId: EntityId<"cap">): string {
  return `delete:${captureId}`;
}

export function undoMutationActionId(mutationId: EntityId<"mut">): string {
  return `undo:${mutationId}`;
}

export function captureTombstoneActionId(captureId: EntityId<"cap">): string {
  return `tombstone:${captureId}`;
}

export function captureActionId(action: CaptureLocalAction): string {
  switch (action.actionType) {
    case "retry_capture":
      return retryCaptureActionId(action.captureId);
    case "delete_capture":
      return deleteCaptureActionId(action.captureId);
    case "undo_mutation":
      return undoMutationActionId(action.mutationId);
    case "capture_tombstone":
      return captureTombstoneActionId(action.captureId);
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[]
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function validTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseSchedule(value: Readonly<Record<string, unknown>>): CaptureActionSchedule | null {
  const error = ApiErrorCodeSchema.nullable().safeParse(value.errorCode);
  if (
    typeof value.attempts !== "number" ||
    !Number.isSafeInteger(value.attempts) ||
    value.attempts < 0 ||
    (value.nextAttemptAt !== null && !validTimestamp(value.nextAttemptAt)) ||
    !error.success
  ) {
    return null;
  }
  return {
    attempts: value.attempts,
    errorCode: error.data,
    nextAttemptAt: value.nextAttemptAt
  };
}

const SCHEDULE_KEYS = ["attempts", "errorCode", "nextAttemptAt"] as const;
const COMMON_KEYS = ["actionType", "captureId", "createdAt", "updatedAt"] as const;

export function parseCaptureLocalAction(value: unknown): CaptureLocalAction | null {
  if (!isRecord(value) || !validTimestamp(value.createdAt) || !validTimestamp(value.updatedAt)) {
    return null;
  }
  const captureId = entityIdSchema("cap").safeParse(value.captureId);
  if (!captureId.success) return null;

  if (value.actionType === "capture_tombstone") {
    if (
      !hasExactKeys(value, [...COMMON_KEYS, "deletedAt"]) ||
      typeof value.deletedAt !== "string" ||
      Number.isNaN(Date.parse(value.deletedAt))
    ) {
      return null;
    }
    return {
      actionType: value.actionType,
      captureId: captureId.data,
      createdAt: value.createdAt,
      deletedAt: value.deletedAt,
      updatedAt: value.updatedAt
    };
  }

  const schedule = parseSchedule(value);
  if (schedule === null) return null;
  if (value.actionType === "retry_capture") {
    const request = CaptureRetryRequestSchema.safeParse(value.request);
    if (
      !request.success ||
      !hasExactKeys(value, [...COMMON_KEYS, ...SCHEDULE_KEYS, "request", "state"])
    ) {
      return null;
    }
    if (value.state !== "pending") return null;
    return {
      ...schedule,
      actionType: value.actionType,
      captureId: captureId.data,
      createdAt: value.createdAt,
      request: request.data,
      state: value.state,
      updatedAt: value.updatedAt
    };
  }
  if (value.actionType === "delete_capture") {
    const request = CaptureDeleteRequestSchema.safeParse(value.request);
    if (
      !request.success ||
      !hasExactKeys(value, [...COMMON_KEYS, ...SCHEDULE_KEYS, "request", "state"])
    ) {
      return null;
    }
    if (value.state !== "pending") return null;
    return {
      ...schedule,
      actionType: value.actionType,
      captureId: captureId.data,
      createdAt: value.createdAt,
      request: request.data,
      state: value.state,
      updatedAt: value.updatedAt
    };
  }
  if (value.actionType !== "undo_mutation") return null;
  const mutationId = entityIdSchema("mut").safeParse(value.mutationId);
  const noteId = value.noteId === null ? null : entityIdSchema("note").safeParse(value.noteId);
  const request = MutationUndoRequestSchema.safeParse(value.request);
  if (
    !mutationId.success ||
    (noteId !== null && !noteId.success) ||
    !request.success ||
    !hasExactKeys(value, [
      ...COMMON_KEYS,
      ...SCHEDULE_KEYS,
      "mutationId",
      "noteId",
      "request",
      "source",
      "state"
    ]) ||
    (value.source !== "receipt" && value.source !== "delete_content") ||
    (value.state !== "available" && value.state !== "pending" && value.state !== "consumed")
  ) {
    return null;
  }
  return {
    ...schedule,
    actionType: value.actionType,
    captureId: captureId.data,
    createdAt: value.createdAt,
    mutationId: mutationId.data,
    noteId: noteId === null ? null : noteId.data,
    request: request.data,
    source: value.source,
    state: value.state,
    updatedAt: value.updatedAt
  };
}
