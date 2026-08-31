import { captureV1Fixture, captureV1ResponseFixture } from "@unfiled/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CaptureContentProtector } from "./content-protection";
import { SupabaseHttpCaptureRepository } from "./supabase-http-repository";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const context = { accessToken: "owner-access-token", userId: USER_ID };
const encryptedContent = {
  envelope: { opaque: "ciphertext-only" },
  fingerprint: "a".repeat(64),
  length: captureV1Fixture.rawContent.length
};

function protector(
  content: string = captureV1Fixture.rawContent,
  openError?: Error
): CaptureContentProtector {
  return {
    openCapture:
      openError === undefined
        ? vi.fn().mockResolvedValue(content)
        : vi.fn().mockRejectedValue(openError),
    protectCapture: vi.fn().mockResolvedValue({
      contentEnvelope: encryptedContent.envelope,
      contentFingerprint: encryptedContent.fingerprint,
      contentLength: encryptedContent.length
    }),
    ready: vi.fn().mockResolvedValue(undefined)
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function recordedBody(call: unknown): Record<string, unknown> {
  if (!Array.isArray(call)) throw new TypeError("missing fetch call");
  const init: unknown = call[1];
  if (init === null || typeof init !== "object") throw new TypeError("missing request init");
  const body = (init as { body?: unknown }).body;
  if (typeof body !== "string") throw new TypeError("missing request body");
  const parsed: unknown = JSON.parse(body);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("invalid request body");
  }
  return parsed as Record<string, unknown>;
}

function metadata(status: "done" | "inbox" | "processing" | "queued" = "queued") {
  return {
    id: captureV1Fixture.clientCaptureId,
    source: captureV1Fixture.source,
    deviceId: "iphone-15-pro",
    privacy: captureV1Fixture.privacy,
    explicitDestinationNoteId: null,
    expansionDisabled: captureV1Fixture.expansionDisabled,
    clientCreatedAt: captureV1Fixture.clientCreatedAt,
    clientTimezone: captureV1Fixture.clientTimezone,
    receivedAt: captureV1ResponseFixture.capture.receivedAt,
    status,
    lastErrorCode: null
  };
}

describe("Supabase capture HTTP repository", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.test";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  });

  it("encrypts before create and never sends persisted plaintext to Supabase", async () => {
    const contentProtector = protector();
    const fetchMock = vi.fn().mockResolvedValue(
      json({
        capture: metadata(),
        jobId: captureV1ResponseFixture.jobId,
        replayed: false
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const repository = new SupabaseHttpCaptureRepository(contentProtector);

    const result = await repository.createCapture(context, captureV1Fixture);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = recordedBody(fetchMock.mock.calls[0]);
    const captureBody = body.p_capture as Record<string, unknown>;

    expect(url).toBe("https://project.supabase.test/rest/v1/rpc/create_capture_with_job");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer test-service-role-key");
    expect(new Headers(init.headers).get("apikey")).toBe("test-service-role-key");
    expect(new Headers(init.headers).get("authorization")).not.toContain(context.accessToken);
    expect(JSON.stringify(body)).not.toContain(captureV1Fixture.rawContent);
    expect(captureBody).toMatchObject({
      clientCaptureId: captureV1Fixture.clientCaptureId,
      contentEnvelope: encryptedContent.envelope,
      contentFingerprint: encryptedContent.fingerprint,
      contentLength: captureV1Fixture.rawContent.length
    });
    expect(body.p_owner_id).toBe(USER_ID);
    expect(result.capture.rawContent).toBe(captureV1Fixture.rawContent);
    expect(JSON.stringify(result)).not.toContain("ciphertext-only");
  });

  it("decrypts owner-scoped list and detail envelopes and strips internal fields", async () => {
    const contentProtector = protector("   shopping: milk and batteries   ");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        json({
          items: [
            {
              ...metadata("queued"),
              jobId: captureV1ResponseFixture.jobId,
              receiptAvailable: false,
              encryptedContent
            }
          ],
          pageInfo: { hasMore: false, nextCursor: null }
        })
      )
      .mockResolvedValueOnce(
        json({
          capture: {
            ...metadata("processing"),
            jobId: captureV1ResponseFixture.jobId,
            receipt: null,
            encryptedContent
          }
        })
      );
    vi.stubGlobal("fetch", fetchMock);
    const repository = new SupabaseHttpCaptureRepository(contentProtector);

    const list = await repository.listCaptures(context, { limit: 30 });
    const detail = await repository.getCapture(context, captureV1Fixture.clientCaptureId);

    expect(list.items[0]?.rawContentPreview).toBe("shopping: milk and batteries");
    expect(detail.capture.rawContent).toBe("   shopping: milk and batteries   ");
    expect(contentProtector.openCapture).toHaveBeenNthCalledWith(
      1,
      encryptedContent,
      USER_ID,
      captureV1Fixture.clientCaptureId
    );
    expect(recordedBody(fetchMock.mock.calls[0]).p_owner_id).toBe(USER_ID);
    expect(recordedBody(fetchMock.mock.calls[1]).p_owner_id).toBe(USER_ID);
    expect(JSON.stringify({ list, detail })).not.toMatch(
      /encryptedContent|fingerprint|ciphertext/u
    );
  });

  it("maps Inbox receipts from references without exposing encrypted storage metadata", async () => {
    const contentProtector = protector();
    const fetchMock = vi.fn().mockResolvedValue(
      json({
        receipt: {
          schemaVersion: 1,
          captureId: captureV1Fixture.clientCaptureId,
          jobId: captureV1ResponseFixture.jobId,
          decisionId: null,
          reviewItemId: null,
          mutationId: null,
          outcome: "kept_in_inbox",
          headline: "Kept in Inbox",
          destination: null,
          insertedContentReferences: [],
          encryptedContent,
          actions: [],
          reasonCodes: [],
          createdAt: "2026-08-30T18:30:03.000Z"
        }
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const repository = new SupabaseHttpCaptureRepository(contentProtector);

    const result = await repository.getReceipt(context, captureV1Fixture.clientCaptureId);

    expect(result.receipt).toMatchObject({ outcome: "kept_in_inbox", insertedContent: [] });
    expect(contentProtector.openCapture).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("fingerprint");
  });

  it("reconstructs captured receipt content only after authenticating its envelope", async () => {
    const contentProtector = protector("captured source text");
    const fetchMock = vi.fn().mockResolvedValue(
      json({
        receipt: {
          schemaVersion: 1,
          captureId: captureV1Fixture.clientCaptureId,
          jobId: captureV1ResponseFixture.jobId,
          decisionId: "dec_01J6M9Q7G4BMKB33GSG3NJ6D1X",
          reviewItemId: null,
          mutationId: "mut_01J6M9Q7G4BMKB33GSG3NJ6D1X",
          outcome: "added_to_note",
          headline: "Added to Shopping",
          destination: {
            noteId: "note_01J6M9Q7G4BMKB33GSG3NJ6D1X",
            title: "Shopping"
          },
          insertedContentReferences: [
            { type: "captured", itemId: "itm_01J6M9Q7G4BMKB33GSG3NJ6D1X" }
          ],
          encryptedContent,
          actions: [
            { type: "open", noteId: "note_01J6M9Q7G4BMKB33GSG3NJ6D1X" },
            {
              type: "undo",
              mutationId: "mut_01J6M9Q7G4BMKB33GSG3NJ6D1X",
              expectedRevision: 2
            }
          ],
          reasonCodes: ["explicit_destination"],
          createdAt: "2026-08-30T18:30:03.000Z"
        }
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const repository = new SupabaseHttpCaptureRepository(contentProtector);

    const result = await repository.getReceipt(context, captureV1Fixture.clientCaptureId);

    expect(result.receipt.insertedContent).toEqual([
      {
        type: "captured",
        itemId: "itm_01J6M9Q7G4BMKB33GSG3NJ6D1X",
        content: "captured source text"
      }
    ]);
    expect(contentProtector.openCapture).toHaveBeenCalledWith(
      encryptedContent,
      USER_ID,
      captureV1Fixture.clientCaptureId
    );
    expect(JSON.stringify(result)).not.toContain("ciphertext-only");
  });

  it("decrypts retry acknowledgements and forwards atomic soft-delete parameters", async () => {
    const contentProtector = protector();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        json({
          capture: { ...metadata(), encryptedContent },
          jobId: captureV1ResponseFixture.jobId,
          replayed: false
        })
      )
      .mockResolvedValueOnce(
        json({
          captureId: captureV1Fixture.clientCaptureId,
          deletedAt: "2026-08-30T18:35:00.000Z",
          sourceRemovedFromNoteIds: [],
          removedInsertedContent: false,
          contentRemovalMutations: [],
          replayed: false
        })
      );
    vi.stubGlobal("fetch", fetchMock);
    const repository = new SupabaseHttpCaptureRepository(contentProtector);

    const retry = await repository.retryCapture(
      context,
      captureV1Fixture.clientCaptureId,
      "retry-once"
    );
    const removed = await repository.deleteCapture(context, captureV1Fixture.clientCaptureId, {
      idempotencyKey: "delete-once",
      removeInsertedContent: false,
      expectedNoteRevisions: []
    });
    const deleteBody = recordedBody(fetchMock.mock.calls[1]);

    expect(retry.capture.rawContent).toBe(captureV1Fixture.rawContent);
    expect(removed.removedInsertedContent).toBe(false);
    expect(deleteBody).toEqual({
      p_owner_id: USER_ID,
      p_capture_id: captureV1Fixture.clientCaptureId,
      p_idempotency_key: "delete-once",
      p_remove_inserted_content: false,
      p_expected_note_revisions: []
    });
  });

  it("fails closed on decryption errors and maps database errors to safe public codes", async () => {
    const contentProtector = protector(
      captureV1Fixture.rawContent,
      new Error("secret decryption detail")
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        json({
          capture: {
            ...metadata("processing"),
            jobId: captureV1ResponseFixture.jobId,
            receipt: null,
            encryptedContent
          }
        })
      )
      .mockResolvedValueOnce(json({ message: "invalid_idempotency_key: private detail" }, 400));
    vi.stubGlobal("fetch", fetchMock);
    const repository = new SupabaseHttpCaptureRepository(contentProtector);

    await expect(
      repository.getCapture(context, captureV1Fixture.clientCaptureId)
    ).rejects.toMatchObject({ code: "provider_unavailable", status: 503 });
    await expect(
      repository.deleteCapture(context, captureV1Fixture.clientCaptureId, {
        idempotencyKey: "delete-once",
        removeInsertedContent: false,
        expectedNoteRevisions: []
      })
    ).rejects.toMatchObject({ code: "invalid_idempotency_key", status: 409 });
  });
});
