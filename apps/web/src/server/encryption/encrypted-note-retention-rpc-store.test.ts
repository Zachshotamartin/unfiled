import type { ContentEnvelopeV1 } from "@unfiled/content-crypto";
import type { EncryptedFieldRpcValue, KeyedMacRpcValue } from "@unfiled/encrypted-aggregate";
import { describe, expect, it, vi } from "vitest";

import {
  createEncryptedNoteRetentionRpcStore,
  encryptedNoteRetentionRpcFunctions,
  type EncryptedNoteRetentionReceiptCommit
} from "./encrypted-note-retention-rpc-store";
import { ServiceRpcErrorCode, type ServiceRpcClient } from "./service-rpc-client";

const OWNER_ID = "81818181-8181-4181-8181-818181818181";
const RUN_ID = "81000000-0000-4000-8000-000000000001";
const LEASE_TOKEN = "81000000-0000-4000-8000-000000000002";
const CLAIM_ID = "81000000-0000-4000-8000-000000000003";
const CAPTURE_ID = "cap_81000000000000000000000001" as const;
const NOTE_ID = "note_81000000000000000000000001" as const;
const TARGET_NOTE_ID = "note_81000000000000000000000002" as const;
const MUTATION_ID = "mut_81000000000000000000000002" as const;
const RESERVATION_ID = "81000000-0000-4000-8000-000000000004";

function envelope(): ContentEnvelopeV1 {
  return Object.freeze({
    version: 1,
    suite: "A256GCM",
    keyId: "retention.ai.object.v1",
    context: Object.freeze({
      tenantId: OWNER_ID,
      resourceId: CAPTURE_ID,
      recordVersion: 2,
      kind: "capture_receipt"
    }),
    wrappedDataKey: Object.freeze({ nonce: "A".repeat(16), ciphertext: "a".repeat(64) }),
    payload: Object.freeze({ nonce: "B".repeat(16), ciphertext: "b".repeat(64) })
  });
}

function cipher(): EncryptedFieldRpcValue<"capture_receipt"> {
  return Object.freeze({
    envelope: envelope(),
    keyId: "retention.ai.object.v1",
    keyClass: "ai_assisted",
    keyPurpose: "object_wrap",
    keyVersion: 1,
    reservationId: RESERVATION_ID
  });
}

function mac(): KeyedMacRpcValue {
  return Object.freeze({
    mac: "c".repeat(64),
    keyId: "retention.ai.mac.v1",
    keyClass: "ai_assisted",
    keyPurpose: "content_mac",
    keyVersion: 1
  });
}

function receipt(): EncryptedNoteRetentionReceiptCommit {
  return Object.freeze({
    captureId: CAPTURE_ID,
    recordVersion: 2,
    receiptCipher: cipher(),
    verificationMac: mac(),
    projection: Object.freeze({
      mode: "routed",
      primary: Object.freeze({
        noteId: TARGET_NOTE_ID,
        mutationId: MUTATION_ID,
        expectedRevision: 4,
        noteRecordVersion: 4
      })
    })
  });
}

describe("encrypted note retention RPC store", () => {
  it("exposes exactly the bounded retention capabilities", () => {
    expect(encryptedNoteRetentionRpcFunctions).toEqual([
      "claim_encrypted_note_retention",
      "cancel_encrypted_note_retention_claim",
      "commit_encrypted_note_retention"
    ]);
    expect(Object.isFrozen(encryptedNoteRetentionRpcFunctions)).toBe(true);
  });

  it("sends only ciphertext and operational projection in a retention commit", async () => {
    const rpc = vi.fn<ServiceRpcClient["rpc"]>(() =>
      Promise.resolve({
        claimId: CLAIM_ID,
        noteId: NOTE_ID,
        purged: true,
        purgedCaptureCount: 1,
        purgedReceiptCount: 1,
        replayed: false
      })
    );
    const store = createEncryptedNoteRetentionRpcStore(Object.freeze({ rpc }));

    await expect(
      store.commit({
        ownerId: OWNER_ID,
        runId: RUN_ID,
        claimId: CLAIM_ID,
        leaseToken: LEASE_TOKEN,
        contextDigest: "d".repeat(64),
        receipts: [receipt()]
      })
    ).resolves.toMatchObject({ noteId: NOTE_ID, purged: true, replayed: false });

    const parameters = rpc.mock.calls[0]?.[1];
    expect(rpc.mock.calls[0]?.[0]).toBe("commit_encrypted_note_retention");
    expect(parameters).toEqual({
      p_owner_id: OWNER_ID,
      p_run_id: RUN_ID,
      p_claim_id: CLAIM_ID,
      p_lease_token: LEASE_TOKEN,
      p_command: {
        contextDigest: "d".repeat(64),
        receipts: [receipt()]
      }
    });
    expect(JSON.stringify(parameters)).not.toContain("Live sibling");
  });

  it("rejects plaintext or extension fields hidden inside a cipher command", async () => {
    const rpc = vi.fn<ServiceRpcClient["rpc"]>();
    const store = createEncryptedNoteRetentionRpcStore(Object.freeze({ rpc }));
    const tainted = Object.freeze({
      ...receipt(),
      receiptCipher: Object.freeze({
        ...cipher(),
        title: "Live sibling must remain inside the sealed receipt"
      })
    });

    await expect(
      store.commit({
        ownerId: OWNER_ID,
        runId: RUN_ID,
        claimId: CLAIM_ID,
        leaseToken: LEASE_TOKEN,
        contextDigest: "d".repeat(64),
        receipts: [tainted]
      })
    ).rejects.toMatchObject({ code: ServiceRpcErrorCode.VALIDATION_FAILED });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects claim projection drift before it can become trusted work", async () => {
    const rpc = vi.fn<ServiceRpcClient["rpc"]>(() =>
      Promise.resolve({
        runAt: "2026-08-31T00:00:00.000Z",
        cutoff: "2026-08-01T00:00:00.000Z",
        eligibleCount: 1,
        executed: true,
        claimedCount: 1,
        claims: [
          {
            claimId: CLAIM_ID,
            ownerId: OWNER_ID,
            noteId: NOTE_ID,
            deletedAt: "2026-07-01T00:00:00.000Z",
            contextDigest: "e".repeat(64),
            receiptContexts: [],
            replayed: false,
            plaintext: "must not be accepted"
          }
        ],
        replayed: false
      })
    );
    const store = createEncryptedNoteRetentionRpcStore(Object.freeze({ rpc }));

    await expect(
      store.claim({
        runId: RUN_ID,
        leaseToken: LEASE_TOKEN,
        ownerId: OWNER_ID,
        now: "2026-08-31T00:00:00.000Z",
        batchSize: 1,
        execute: true
      })
    ).rejects.toMatchObject({ code: ServiceRpcErrorCode.PROVIDER_UNAVAILABLE });
  });
});
