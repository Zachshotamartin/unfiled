import type { CaptureCreateRequest, CaptureCreateResponse } from "./captures.js";

export const captureV1Fixture = Object.freeze({
  clientCaptureId: "cap_01J6M9Q7G4BMKB33GSG3NJ6D1X",
  rawContent: "shopping: milk and batteries",
  source: "ios_lock_screen_widget",
  clientCreatedAt: "2026-08-30T18:30:00.000Z",
  clientTimezone: "America/Los_Angeles",
  privacy: "ai_assisted",
  expansionDisabled: false
}) satisfies CaptureCreateRequest;

export const captureV1ResponseFixture = Object.freeze({
  capture: Object.freeze({
    id: captureV1Fixture.clientCaptureId,
    rawContent: captureV1Fixture.rawContent,
    source: captureV1Fixture.source,
    privacy: captureV1Fixture.privacy,
    clientCreatedAt: captureV1Fixture.clientCreatedAt,
    receivedAt: "2026-08-30T18:30:01.000Z",
    status: "queued",
    lastErrorCode: null
  }),
  jobId: "job_01J6M9Q7G4BMKB33GSG3NJ6D1Y",
  replayed: false
}) satisfies CaptureCreateResponse;
