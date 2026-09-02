import type { Metadata } from "next";
import Link from "next/link";

import { PublicDocument, PublicSection } from "@/components/public/public-document";
import { repositoryUrl, supportRequestUrl } from "@/lib/public-site";

export const metadata: Metadata = {
  title: "Support",
  description: "Get help with the Unfiled private beta without exposing private note content."
};

const navigation = [
  { href: "#request", label: "Request support" },
  { href: "#include", label: "What to include" },
  { href: "#protect", label: "Protect private data" },
  { href: "#account", label: "Account help" },
  { href: "#availability", label: "Beta availability" }
] as const;

export default function SupportPage() {
  return (
    <PublicDocument
      eyebrow="Help / Support"
      title="Get unstuck without sharing the note."
      summary="A useful report describes the behavior and environment. It should never require your private content, credentials, or sign-in code."
      navigation={navigation}
    >
      <PublicSection id="request" title="Request support">
        <p>
          Open a <a href={supportRequestUrl}>structured GitHub support request</a> for beta access,
          account help, a product defect, export or deletion help, or a general question. You can
          also inspect known issues and release status in the{" "}
          <a href={repositoryUrl + "/issues"}>issue tracker</a>.
        </p>
        <p>
          GitHub issues are public. If a request cannot be explained safely without private data,
          describe only the category and ask the maintainer to establish a private channel.
        </p>
      </PublicSection>

      <PublicSection id="include" title="What to include">
        <ul>
          <li>whether you used the web app or the iPhone app;</li>
          <li>the Preview or Production environment, without copying a tokenized URL;</li>
          <li>the app version, iOS version, browser, and approximate time of the problem;</li>
          <li>the action you attempted, the result you expected, and what happened instead;</li>
          <li>a request ID or fixed error code if the interface displayed one; and</li>
          <li>steps that reproduce the issue using clearly synthetic text.</li>
        </ul>
      </PublicSection>

      <PublicSection id="protect" title="Protect private data">
        <p>Do not put any of the following in a support issue:</p>
        <ul>
          <li>note, capture, search, or routing-rule text;</li>
          <li>screenshots that show private content or a real email address;</li>
          <li>passwordless sign-in codes, session tokens, cookies, or magic links;</li>
          <li>OpenAI keys, database credentials, encryption material, or account exports; or</li>
          <li>another person&apos;s identifying information.</li>
        </ul>
        <p>
          Redact first, then verify the redaction before uploading. Report a suspected vulnerability
          through the private <Link href="/security">security channel</Link>, never support.
        </p>
      </PublicSection>

      <PublicSection id="account" title="Account, export, and deletion help">
        <p>
          Passwordless codes are sent only to the email address entered in Unfiled. Unfiled support
          will never ask you to forward a code or approve an unexpected sign-in. If a code arrives
          that you did not request, ignore it and open a content-free support request.
        </p>
        <p>
          Export and account deletion are available in Settings after sign-in. If you cannot sign
          in, request help using the account email only when a private support channel has been
          established. The <Link href="/account-deletion">deletion instructions</Link> explain what
          happens to live data, sessions, local data, and backups.
        </p>
      </PublicSection>

      <PublicSection id="availability" title="Beta availability">
        <p>
          The beta has no guaranteed response or uptime service level. The target is an initial
          support response within 2 business days. Security and confirmed deletion failures take
          priority over feature questions.
        </p>
      </PublicSection>
    </PublicDocument>
  );
}
