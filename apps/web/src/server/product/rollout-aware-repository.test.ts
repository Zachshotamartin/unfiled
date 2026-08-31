import { describe, expect, it, vi } from "vitest";

import { InMemoryManualNotesRepository } from "./in-memory-repository";
import {
  encryptedRepositoryReadMethods,
  encryptedRepositoryWriteMethods,
  encryptionRolloutStates,
  repositoryMethodClassificationIsExhaustive,
  rolloutRepositoryTarget,
  RolloutAwareManualNotesRepository,
  type EncryptionRolloutState
} from "./rollout-aware-repository";

const context = Object.freeze({
  accessToken: "owner-access-token",
  userId: "00000000-0000-4000-8000-000000000001"
});

describe("rollout-aware manual-notes repository", () => {
  it("classifies the complete repository surface without an unreviewed method gap", () => {
    expect(repositoryMethodClassificationIsExhaustive).toBe(true);
    const methods = [...encryptedRepositoryReadMethods, ...encryptedRepositoryWriteMethods];
    expect(new Set(methods).size).toBe(methods.length);
    expect([...methods].sort()).toEqual(
      [
        "applyOperations",
        "archiveNote",
        "archiveSpace",
        "createLink",
        "createNote",
        "createSpace",
        "createTag",
        "deleteLink",
        "deleteNote",
        "deleteTag",
        "getNote",
        "linkTag",
        "listLinks",
        "listNotes",
        "listRevisions",
        "listReviewItems",
        "listSpaces",
        "listTags",
        "moveNote",
        "restoreDeletedNote",
        "restoreRevision",
        "search",
        "unlinkTag",
        "undoMutation",
        "updateNote",
        "updateSpace",
        "updateTag"
      ].sort()
    );
  });

  it("keeps expanded traffic legacy, dual-writes every mutation, then cuts every read over", () => {
    for (const method of [...encryptedRepositoryReadMethods, ...encryptedRepositoryWriteMethods]) {
      expect(rolloutRepositoryTarget("expanded", method)).toBe("legacy");
    }
    for (const method of encryptedRepositoryReadMethods) {
      expect(rolloutRepositoryTarget("dual_write", method)).toBe("legacy");
    }
    for (const method of encryptedRepositoryWriteMethods) {
      expect(rolloutRepositoryTarget("dual_write", method)).toBe("encrypted");
    }
    for (const state of ["encrypted_read", "encrypted_only", "contracted"] as const) {
      for (const method of [
        ...encryptedRepositoryReadMethods,
        ...encryptedRepositoryWriteMethods
      ]) {
        expect(rolloutRepositoryTarget(state, method)).toBe("encrypted");
      }
    }
  });

  it("routes with fresh database state and never falls back when state lookup fails", async () => {
    const legacy = new InMemoryManualNotesRepository(false);
    const encrypted = new InMemoryManualNotesRepository(false);
    const legacyList = vi.spyOn(legacy, "listNotes");
    const encryptedList = vi.spyOn(encrypted, "listNotes");
    const encryptedCreate = vi.spyOn(encrypted, "createNote");
    let state: EncryptionRolloutState = "dual_write";
    const stateForOwner = vi.fn(() => Promise.resolve(state));
    const repository = new RolloutAwareManualNotesRepository({ stateForOwner }, legacy, encrypted);

    await repository.listNotes(context, {});
    await repository.createNote(
      context,
      {
        bodyMarkdown: "Owner ciphertext path",
        links: [],
        privacy: "private_manual",
        spaceId: null,
        tagIds: [],
        title: "Encrypted",
        type: "generic"
      },
      "key_00000000000000000000000001"
    );
    expect(legacyList).toHaveBeenCalledOnce();
    expect(encryptedCreate).toHaveBeenCalledOnce();

    state = "encrypted_read";
    await repository.listNotes(context, {});
    expect(encryptedList).toHaveBeenCalledOnce();
    expect(stateForOwner).toHaveBeenCalledTimes(3);

    const unavailableLegacy = new InMemoryManualNotesRepository(false);
    const unavailableEncrypted = new InMemoryManualNotesRepository(false);
    const legacyFallback = vi.spyOn(unavailableLegacy, "listNotes");
    const encryptedFallback = vi.spyOn(unavailableEncrypted, "listNotes");
    const unavailable = new RolloutAwareManualNotesRepository(
      { stateForOwner: () => Promise.reject(new Error("rollout unavailable")) },
      unavailableLegacy,
      unavailableEncrypted
    );
    await expect(unavailable.listNotes(context, {})).rejects.toThrow("rollout unavailable");
    expect(legacyFallback).not.toHaveBeenCalled();
    expect(encryptedFallback).not.toHaveBeenCalled();
  });

  it("keeps the accepted rollout states stable for database mapping", () => {
    expect(encryptionRolloutStates).toEqual([
      "expanded",
      "dual_write",
      "encrypted_read",
      "encrypted_only",
      "contracted"
    ]);
  });
});
