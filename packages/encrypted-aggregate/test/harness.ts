import { generateKeyEncryptionKey } from "@unfiled/content-crypto";
import type {
  KeyClass,
  ManagedContentMacKey,
  ManagedObjectWrappingKey,
  OwnerBoundKeyResolver
} from "@unfiled/key-management";
import { vi } from "vitest";

import {
  authorizeAggregateOwner,
  createEncryptedAggregateService,
  type ContentMacKeyReference,
  type ObjectWrapKeyReference,
  type ObjectWrapReservation,
  type ObjectWrapReservationPort,
  type PrivacyTransition
} from "../src/index.js";

export const OWNER_A = "11111111-1111-4111-8111-111111111111";
export const OWNER_B = "22222222-2222-4222-8222-222222222222";

export const IDS = Object.freeze({
  block: "blk_01J6M9Q7G4BMKB33GSG3NJ6D1X",
  capture: "cap_01J6M9Q7G4BMKB33GSG3NJ6D1X",
  decision: "dec_01J6M9Q7G4BMKB33GSG3NJ6D1X",
  job: "job_01J6M9Q7G4BMKB33GSG3NJ6D1X",
  mutation: "mut_01J6M9Q7G4BMKB33GSG3NJ6D1X",
  note: "note_01J6M9Q7G4BMKB33GSG3NJ6D1X",
  revision: "rev_01J6M9Q7G4BMKB33GSG3NJ6D1X",
  review: "rvw_01J6M9Q7G4BMKB33GSG3NJ6D1X",
  rule: "rule_01J6M9Q7G4BMKB33GSG3NJ6D1X",
  space: "spc_01J6M9Q7G4BMKB33GSG3NJ6D1X",
  tag: "tag_01J6M9Q7G4BMKB33GSG3NJ6D1X"
} as const);

export const OTHER_IDS = Object.freeze({
  capture: "cap_01J6M9Q7G4BMKB33GSG3NJ6D1Y",
  note: "note_01J6M9Q7G4BMKB33GSG3NJ6D1Y",
  space: "spc_01J6M9Q7G4BMKB33GSG3NJ6D1Y",
  tag: "tag_01J6M9Q7G4BMKB33GSG3NJ6D1Y"
} as const);

export const AI_TRANSITION = Object.freeze({
  before: "ai_assisted",
  after: "ai_assisted"
} as const satisfies PrivacyTransition);

export const PRIVATE_TRANSITION = Object.freeze({
  before: "ai_assisted",
  after: "private_manual"
} as const satisfies PrivacyTransition);

function selectorIdentity(ownerId: string, keyClass: KeyClass, keyId: string): string {
  return `${ownerId}:${keyClass}:${keyId}`;
}

function bindingIdentity(ownerId: string, keyClass: KeyClass): string {
  return `${ownerId}:${keyClass}`;
}

async function contentMacKey(
  ownerId: string,
  keyClass: KeyClass,
  keyId: string,
  keyVersion: number
): Promise<ManagedContentMacKey> {
  const key = await crypto.subtle.generateKey(
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign", "verify"]
  );
  return Object.freeze({
    reference: Object.freeze({
      ownerId,
      keyClass,
      purpose: "content_mac" as const,
      keyId,
      keyVersion
    }),
    key
  });
}

async function objectWrappingKey(
  ownerId: string,
  keyClass: KeyClass,
  keyId: string,
  keyVersion: number
): Promise<ManagedObjectWrappingKey & Readonly<{ reference: ObjectWrapKeyReference }>> {
  return Object.freeze({
    reference: Object.freeze({
      ownerId,
      keyClass,
      purpose: "object_wrap" as const,
      keyId,
      keyVersion
    }),
    key: await generateKeyEncryptionKey(keyId)
  });
}

export async function createHarness(cryptoImplementation?: Crypto) {
  const objectKeys = new Map<
    string,
    ManagedObjectWrappingKey & Readonly<{ reference: ObjectWrapKeyReference }>
  >();
  const macKeys = new Map<string, ManagedContentMacKey>();
  const activeObject = new Map<
    string,
    ManagedObjectWrappingKey & Readonly<{ reference: ObjectWrapKeyReference }>
  >();
  const activeMac = new Map<string, ManagedContentMacKey>();

  for (const ownerId of [OWNER_A, OWNER_B]) {
    for (const keyClass of ["ai_assisted", "private_manual"] as const) {
      const className = keyClass === "ai_assisted" ? "ai" : "private";
      const object = await objectWrappingKey(
        ownerId,
        keyClass,
        `key_${ownerId.slice(0, 4)}_${className}_wrap_v2`,
        2
      );
      const activeContentMac = await contentMacKey(
        ownerId,
        keyClass,
        `key_${ownerId.slice(0, 4)}_${className}_mac_v2`,
        2
      );
      const retiredContentMac = await contentMacKey(
        ownerId,
        keyClass,
        `key_${ownerId.slice(0, 4)}_${className}_mac_v1`,
        1
      );
      objectKeys.set(selectorIdentity(ownerId, keyClass, object.reference.keyId), object);
      macKeys.set(
        selectorIdentity(ownerId, keyClass, activeContentMac.reference.keyId),
        activeContentMac
      );
      macKeys.set(
        selectorIdentity(ownerId, keyClass, retiredContentMac.reference.keyId),
        retiredContentMac
      );
      activeObject.set(bindingIdentity(ownerId, keyClass), object);
      activeMac.set(bindingIdentity(ownerId, keyClass), activeContentMac);
    }
  }

  const activeObjectWrappingKey = vi.fn<OwnerBoundKeyResolver["activeObjectWrappingKey"]>(() =>
    Promise.reject(new Error("sealing must not select an unreserved active wrapping key"))
  );
  const activeContentMacKey = vi.fn<OwnerBoundKeyResolver["activeContentMacKey"]>(
    ({ ownerId, keyClass }) => {
      const key = activeMac.get(bindingIdentity(ownerId, keyClass));
      if (key === undefined) throw new Error("missing active MAC key");
      return Promise.resolve(key);
    }
  );
  const resolveObjectWrappingKey = vi.fn<OwnerBoundKeyResolver["resolveObjectWrappingKey"]>(
    ({ ownerId, keyClass, keyId }) =>
      Promise.resolve(objectKeys.get(selectorIdentity(ownerId, keyClass, keyId)) ?? null)
  );
  const resolveContentMacKey = vi.fn<OwnerBoundKeyResolver["resolveContentMacKey"]>(
    ({ ownerId, keyClass, keyId }) =>
      Promise.resolve(macKeys.get(selectorIdentity(ownerId, keyClass, keyId)) ?? null)
  );

  const resolver: OwnerBoundKeyResolver = Object.freeze({
    activeContentMacKey,
    activeObjectWrappingKey,
    contentKeyResolver({ ownerId, keyClass }) {
      return async (keyId) =>
        Promise.resolve(objectKeys.get(selectorIdentity(ownerId, keyClass, keyId))?.key ?? null);
    },
    resolveContentMacKey,
    resolveObjectWrappingKey
  });

  let reservationSequence = 0;
  let reservationOverride: ((ownerId: string, keyClass: KeyClass) => Promise<unknown>) | undefined;
  const reserveObjectWrappingKey = vi.fn<ObjectWrapReservationPort["reserveObjectWrappingKey"]>(
    async ({ ownerId, keyClass }) => {
      if (reservationOverride !== undefined) {
        return (await reservationOverride(ownerId, keyClass)) as ObjectWrapReservation;
      }
      const key = activeObject.get(bindingIdentity(ownerId, keyClass));
      if (key === undefined) throw new Error("missing active wrapping key");
      reservationSequence += 1;
      return Object.freeze({
        reservationId: `reservation_${reservationSequence}`,
        reference: key.reference
      });
    }
  );

  const service = createEncryptedAggregateService({
    ...(cryptoImplementation === undefined ? {} : { crypto: cryptoImplementation }),
    keyResolver: resolver,
    objectWrapReservations: { reserveObjectWrappingKey }
  });

  return {
    accessA: authorizeAggregateOwner({
      authenticatedOwnerId: OWNER_A,
      resourceOwnerId: OWNER_A
    }),
    accessB: authorizeAggregateOwner({
      authenticatedOwnerId: OWNER_B,
      resourceOwnerId: OWNER_B
    }),
    activeContentMacKey,
    activeObjectWrappingKey,
    activeMac,
    activeObject,
    macKeys,
    objectKeys,
    reserveObjectWrappingKey,
    resolveContentMacKey,
    resolveObjectWrappingKey,
    resolver,
    service,
    setReservationOverride(
      override: ((ownerId: string, keyClass: KeyClass) => Promise<unknown>) | undefined
    ) {
      reservationOverride = override;
    },
    contentMacReference(
      ownerId: string,
      keyClass: KeyClass,
      version: "active" | "retired"
    ): ContentMacKeyReference {
      const className = keyClass === "ai_assisted" ? "ai" : "private";
      const keyId = `key_${ownerId.slice(0, 4)}_${className}_mac_${version === "active" ? "v2" : "v1"}`;
      const key = macKeys.get(selectorIdentity(ownerId, keyClass, keyId));
      if (key === undefined) throw new Error("fixture MAC key missing");
      return key.reference as ContentMacKeyReference;
    }
  };
}
