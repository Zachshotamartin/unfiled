import type { Metadata } from "next";
import Link from "next/link";

import { PublicCallout, PublicDocument, PublicSection } from "@/components/public/public-document";
import { repositoryUrl, supportRequestUrl } from "@/lib/public-site";

export const metadata: Metadata = {
  title: "Terms of use",
  description: "Terms for participating in the Unfiled private beta."
};

const navigation = [
  { href: "#beta", label: "Private beta" },
  { href: "#account", label: "Your account" },
  { href: "#content", label: "Your content" },
  { href: "#acceptable-use", label: "Acceptable use" },
  { href: "#ai", label: "AI output" },
  { href: "#service", label: "Service changes" },
  { href: "#disclaimers", label: "Disclaimers" },
  { href: "#ending", label: "Ending access" },
  { href: "#contact", label: "Contact" }
] as const;

export default function TermsPage() {
  return (
    <PublicDocument
      eyebrow="Trust / Terms"
      title="Terms for the Unfiled private beta."
      summary="These terms set practical boundaries for trying an unfinished product without taking ownership of your notes."
      navigation={navigation}
    >
      <PublicSection id="beta" title="Private beta agreement">
        <p>
          By accessing the Unfiled beta, you agree to these terms and the{" "}
          <Link href="/privacy">privacy policy</Link>. If you do not agree, do not use the beta.
          Unfiled is an independent portfolio project under active development, not a generally
          available or paid service.
        </p>
        <PublicCallout>
          <p>
            Keep an independent copy of anything important. Beta software can contain defects,
            change without notice, or be unavailable while infrastructure is repaired.
          </p>
        </PublicCallout>
        <p>
          You must be at least 13 years old to use Unfiled. If the law where you live requires a
          higher minimum age or parental consent, that requirement applies.
        </p>
      </PublicSection>

      <PublicSection id="account" title="Your account">
        <p>
          Provide an email address you are authorized to use and keep access to that mailbox secure.
          You are responsible for activity under your sessions and for promptly signing out of a
          shared or lost device. Do not share sign-in codes, session tokens, provider keys, or
          account exports.
        </p>
        <p>
          Access may be limited by invitation, capacity, geography, device support, or security
          requirements. You may not transfer or sell beta access.
        </p>
      </PublicSection>

      <PublicSection id="content" title="Your content stays yours">
        <p>
          You retain ownership of content you submit. You give Unfiled a limited, non-exclusive
          permission to host, encrypt, process, transmit, and transform that content only as needed
          to operate the features you select, protect the service, and comply with law. This
          permission ends when the content is deleted from live systems, subject to the backup and
          legal retention described in the privacy policy.
        </p>
        <p>
          You are responsible for having the right to submit your content and for deciding whether
          Unfiled is appropriate for it. Do not use the beta as the only copy of medical, legal,
          financial, emergency, credential, or other high-risk records.
        </p>
      </PublicSection>

      <PublicSection id="acceptable-use" title="Acceptable use">
        <p>You may not use Unfiled to:</p>
        <ul>
          <li>break the law or violate another person&apos;s rights;</li>
          <li>access another account or bypass an authorization, rate, or privacy control;</li>
          <li>upload malware or intentionally disrupt the service or its providers;</li>
          <li>probe production accounts or data without written authorization;</li>
          <li>resell the beta or use it to provide a competing hosted service; or</li>
          <li>submit content you may not process through the selected AI provider.</li>
        </ul>
        <p>
          Good-faith security research must follow the <Link href="/security">security policy</Link>
          .
        </p>
      </PublicSection>

      <PublicSection id="ai" title="AI output requires judgment">
        <p>
          AI-assisted features can be incomplete, inaccurate, or surprising. Suggested organization,
          expansions, summaries, and search results are conveniences, not facts or professional
          advice. Review important results before relying on them. Unfiled preserves source context,
          revision history, and supported undo paths to make review easier, but those controls do
          not guarantee a correct result.
        </p>
        <p>
          Provider-specific terms may apply when you supply your own API key. You are responsible
          for provider charges caused by authorized use of that key within your selected settings.
        </p>
      </PublicSection>

      <PublicSection id="service" title="The service will change">
        <p>
          Features, limits, integrations, security controls, and supported devices may change during
          the beta. We may suspend a feature or account to investigate abuse, protect data, perform
          maintenance, or meet a legal obligation. When practical, material changes that affect
          stored content will be announced before they take effect.
        </p>
        <p>
          Feedback is welcome. If you send product feedback, you allow the project to use it without
          restriction or payment, provided that we do not publish private note content you may
          accidentally include.
        </p>
      </PublicSection>

      <PublicSection id="disclaimers" title="Disclaimers and responsibility">
        <p>
          To the maximum extent permitted by applicable law, the beta is provided as available and
          without warranties, including implied warranties of merchantability, fitness for a
          particular purpose, and non-infringement. Unfiled does not promise uninterrupted access,
          permanent preservation, or error-free AI output.
        </p>
        <p>
          To the maximum extent permitted by applicable law, the project operator will not be liable
          for indirect, incidental, special, consequential, exemplary, or punitive damages, or for
          lost content, profits, revenue, or opportunities arising from the beta. Some places do not
          permit particular exclusions, so those exclusions apply only to the extent allowed there.
        </p>
      </PublicSection>

      <PublicSection id="ending" title="Ending access">
        <p>
          You may stop using Unfiled at any time. Export your notes first if you want a copy, then
          delete your account from Settings. The <Link href="/account-deletion">deletion page</Link>{" "}
          explains the current flow and backup window.
        </p>
        <p>
          We may end beta access for a material violation of these terms, a security risk, prolonged
          inactivity, or discontinuation of the project. When practical and safe, we will provide a
          reasonable opportunity to export content before a planned discontinuation.
        </p>
      </PublicSection>

      <PublicSection id="contact" title="Questions and project record">
        <p>
          These terms contain the agreement for the private beta and replace earlier beta statements
          about the same subject. Applicable law controls any issue that cannot be resolved by these
          terms. No mandatory arbitration or exclusive forum is selected for the private beta.
        </p>
        <p>
          Ask a terms or account question through the{" "}
          <a href={supportRequestUrl}>support request</a>. The public{" "}
          <a href={repositoryUrl}>source repository</a> records the software implementation and
          release status. Do not include private note content in a public request.
        </p>
      </PublicSection>
    </PublicDocument>
  );
}
