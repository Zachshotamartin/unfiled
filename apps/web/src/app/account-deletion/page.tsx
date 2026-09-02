import type { Metadata } from "next";
import Link from "next/link";

import { PublicCallout, PublicDocument, PublicSection } from "@/components/public/public-document";
import { supportRequestUrl } from "@/lib/public-site";

export const metadata: Metadata = {
  title: "Delete your account",
  description: "How to export data and permanently delete an Unfiled account."
};

const navigation = [
  { href: "#before", label: "Before deletion" },
  { href: "#web", label: "Delete on web" },
  { href: "#iphone", label: "Delete on iPhone" },
  { href: "#after", label: "What happens" },
  { href: "#help", label: "Get help" }
] as const;

export default function AccountDeletionPage() {
  return (
    <PublicDocument
      eyebrow="Account / Deletion"
      title="Delete the account, not just the app."
      summary="Uninstalling Unfiled removes the app from one device. The signed-in deletion flow removes live account data across the shared backend."
      navigation={navigation}
    >
      <PublicSection id="before" title="Before deletion">
        <p>
          Account deletion is permanent for live server data. If you want a copy, sign in and choose
          <strong> Download archive</strong> on the web or <strong>Prepare private export</strong>{" "}
          on iPhone before deleting the account. Store the resulting archive securely because it
          contains readable note content.
        </p>
        <PublicCallout>
          <p>
            Deleting one note, signing out, or uninstalling the iPhone app does not delete your
            account. Use the account deletion control and wait for its server receipt.
          </p>
        </PublicCallout>
      </PublicSection>

      <PublicSection id="web" title="Delete from the web app">
        <ol>
          <li>Sign in to Unfiled and open Settings.</li>
          <li>Find Your data and optionally download an archive.</li>
          <li>Select Delete account.</li>
          <li>Type DELETE exactly, then select Delete permanently.</li>
          <li>Keep the page open until Unfiled shows the deletion receipt.</li>
        </ol>
      </PublicSection>

      <PublicSection id="iphone" title="Delete from iPhone">
        <ol>
          <li>Open Unfiled, sign in, and open Settings.</li>
          <li>Find Your data and optionally prepare a private export.</li>
          <li>Select Delete my account.</li>
          <li>Type DELETE exactly and confirm the destructive action.</li>
          <li>Keep the app open until the receipt confirms server deletion and local cleanup.</li>
        </ol>
        <p>
          If the server succeeds but the iPhone reports that local cleanup failed, reinstall Unfiled
          before lending, selling, or transferring that device.
        </p>
      </PublicSection>

      <PublicSection id="after" title="What happens after confirmation">
        <ul>
          <li>Live account data is deleted in one server-side operation.</li>
          <li>Every active authentication session is revoked.</li>
          <li>
            The device clears its local encrypted profile and credentials when cleanup succeeds.
          </li>
          <li>
            The receipt records when encrypted provider backup copies are scheduled to expire.
          </li>
          <li>Current policy sets that backup expiration window to 30 days.</li>
          <li>Registering later creates a fresh account and does not restore deleted notes.</li>
        </ul>
        <p>
          A content-free deletion receipt may be retained to confirm that the request completed and
          to safely replay the exact request after an interrupted response. See the{" "}
          <Link href="/privacy">privacy policy</Link> for retention details.
        </p>
      </PublicSection>

      <PublicSection id="help" title="If you cannot complete deletion">
        <p>
          Retry the same in-product action first. The web and iPhone clients preserve a protected
          idempotency value so an interrupted response can recover the original receipt without
          deleting twice.
        </p>
        <p>
          If you cannot sign in or the receipt never appears, open a{" "}
          <a href={supportRequestUrl}>support request</a> without note text, codes, tokens, exports,
          or keys. Account ownership must be verified before a manual privacy request can be acted
          on.
        </p>
      </PublicSection>
    </PublicDocument>
  );
}
