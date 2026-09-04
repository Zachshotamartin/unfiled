"use client";

import { createAccountDeletionToken } from "@unfiled/api-client";
import type { AccountDeletionReceipt, AccountDeletionToken } from "@unfiled/contracts";
import Link from "next/link";
import { useState } from "react";

import {
  browserApi,
  isAmbiguousProductMutationFailure,
  productErrorMessage
} from "@/lib/product/browser-api";

import { UnfiledGlyph } from "./unfiled-glyph";

type DeletionClient = Readonly<{
  deleteAccount(input: {
    confirmation: "DELETE";
    idempotencyKey: AccountDeletionToken;
  }): Promise<AccountDeletionReceipt>;
  replayAccountDeletionReceipt(input: {
    idempotencyKey: AccountDeletionToken;
  }): Promise<AccountDeletionReceipt>;
}>;

export async function deleteAccountWithReceiptRecovery(
  client: DeletionClient,
  token: AccountDeletionToken
): Promise<AccountDeletionReceipt> {
  try {
    return await client.deleteAccount({ confirmation: "DELETE", idempotencyKey: token });
  } catch (error) {
    if (!isAmbiguousProductMutationFailure(error)) throw error;
    try {
      return await client.replayAccountDeletionReceipt({ idempotencyKey: token });
    } catch {
      throw error;
    }
  }
}

function DeletedAccountReceipt({ receipt }: Readonly<{ receipt: AccountDeletionReceipt }>) {
  return (
    <section className="account-deleted-receipt" role="status" aria-labelledby="deleted-title">
      <span className="section-label">Deletion complete</span>
      <h2 id="deleted-title">Your live account data is deleted.</h2>
      <p>
        Signed-in sessions were revoked. Backup copies are scheduled to expire by{" "}
        <time dateTime={receipt.backupExpiresAt}>
          {new Date(receipt.backupExpiresAt).toLocaleDateString()}
        </time>
        . Registering again starts a fresh account.
      </p>
      <Link href="/auth" className="button-secondary">
        Return to sign in
      </Link>
    </section>
  );
}

export function AccountDataControls() {
  const [confirming, setConfirming] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [attemptToken, setAttemptToken] = useState<AccountDeletionToken | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<AccountDeletionReceipt | null>(null);

  async function deleteAccount(): Promise<void> {
    if (confirmation !== "DELETE" || pending) return;
    const token = attemptToken ?? createAccountDeletionToken();
    setAttemptToken(token);
    setPending(true);
    setError(null);
    try {
      const nextReceipt = await deleteAccountWithReceiptRecovery(browserApi, token);
      setReceipt(nextReceipt);
      setAttemptToken(null);
      setConfirmation("");
      setConfirming(false);
    } catch (reason) {
      setError(
        productErrorMessage(
          reason,
          "Deletion could not be confirmed. Keep this page open and retry the same action."
        )
      );
    } finally {
      setPending(false);
    }
  }

  if (receipt !== null) return <DeletedAccountReceipt receipt={receipt} />;

  return (
    <section className="settings-row account-data-controls" aria-labelledby="account-data-title">
      <div>
        <h2 id="account-data-title" className="settings-section-title">
          Your data
        </h2>
        <p className="mt-2 max-w-xl text-sm leading-6 text-muted-content">
          Download a readable archive before removing your account. Export streams Markdown files,
          relationships, source captures, and a JSON manifest directly to your device.
        </p>
        <a className="button-secondary account-export-action" href="/api/v1/me/export">
          <UnfiledGlyph glyph="down" size={17} weight={1.9} /> Download archive
        </a>
      </div>

      {!confirming ? (
        <button type="button" className="account-delete-action" onClick={() => setConfirming(true)}>
          <UnfiledGlyph glyph="trash" size={17} weight={1.9} /> Delete account
        </button>
      ) : (
        <div className="account-deletion-confirmation" role="group" aria-labelledby="delete-title">
          <div className="account-deletion-heading">
            <div>
              <h3 id="delete-title">Permanently delete this account</h3>
              <p>
                Live data and sessions are removed immediately. Encrypted backup copies expire after
                the documented 30-day retention window.
              </p>
            </div>
            <button
              type="button"
              className="icon-button"
              aria-label="Cancel account deletion"
              disabled={pending}
              onClick={() => {
                setConfirming(false);
                setConfirmation("");
                setAttemptToken(null);
                setError(null);
              }}
            >
              <UnfiledGlyph glyph="close" size={16} weight={1.9} />
            </button>
          </div>
          <div className="account-deletion-field">
            <label htmlFor="account-delete-confirmation">Type DELETE to confirm</label>
            <input
              id="account-delete-confirmation"
              value={confirmation}
              maxLength={6}
              autoComplete="off"
              spellCheck={false}
              disabled={pending}
              onChange={(event) => setConfirmation(event.target.value)}
            />
            <p>Account deletion cannot be undone from live storage.</p>
          </div>
          <button
            type="button"
            className="account-delete-confirm"
            disabled={confirmation !== "DELETE" || pending}
            onClick={() => void deleteAccount()}
          >
            {pending ? "Deleting account" : "Delete permanently"}
          </button>
          <p className="account-deletion-error" role={error === null ? undefined : "alert"}>
            {error}
          </p>
        </div>
      )}
    </section>
  );
}
