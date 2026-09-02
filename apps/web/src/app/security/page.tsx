import type { Metadata } from "next";
import Link from "next/link";

import { PublicCallout, PublicDocument, PublicSection } from "@/components/public/public-document";
import { repositoryUrl, securityReportUrl } from "@/lib/public-site";

export const metadata: Metadata = {
  title: "Security",
  description: "The Unfiled security model and private vulnerability reporting path."
};

const navigation = [
  { href: "#model", label: "Security model" },
  { href: "#controls", label: "Current controls" },
  { href: "#boundaries", label: "Important boundaries" },
  { href: "#report", label: "Report a vulnerability" },
  { href: "#research", label: "Research guidelines" },
  { href: "#response", label: "Response process" }
] as const;

export default function SecurityPage() {
  return (
    <PublicDocument
      eyebrow="Trust / Security"
      title="Security claims should be specific and testable."
      summary="Unfiled narrows which service can handle each kind of data, encrypts note content, and publishes what that protection does not mean."
      navigation={navigation}
    >
      <PublicSection id="model" title="Security model">
        <p>
          Unfiled is designed around owner isolation, least-privilege workloads, authenticated
          encryption, and fail-closed state changes. The web app and native iPhone app share an
          authenticated backend. Separate services organize notes, build encrypted indexes, verify
          index generations, and answer AI-assisted semantic searches.
        </p>
        <PublicCallout>
          <p>
            Unfiled provides application encryption at rest. It is not end-to-end encryption or
            zero-knowledge storage. Authorized server workloads can decrypt narrowly scoped content
            when needed to deliver the feature you selected.
          </p>
        </PublicCallout>
      </PublicSection>

      <PublicSection id="controls" title="Current controls">
        <ul>
          <li>TLS protects supported network traffic in transit.</li>
          <li>
            Note content is stored in authenticated encryption envelopes with owner and purpose
            context bound to each operation.
          </li>
          <li>
            Production keys are designed to use owner-scoped intermediate keys and managed root keys
            held outside the application database.
          </li>
          <li>
            Database roles and cloud identities have exact workload-specific permissions. Search,
            organization, indexing, and verification do not share a general content identity.
          </li>
          <li>
            Private manual content is excluded from AI provider requests and semantic indexes.
          </li>
          <li>
            Product telemetry is designed to exclude note text, search text, provider keys,
            authentication codes, session tokens, and encryption material.
          </li>
          <li>
            The iPhone app uses SQLCipher, iOS complete file protection, and Keychain-backed key
            custody.
          </li>
          <li>
            Account deletion is atomic for live server data, revokes sessions, and returns a
            content-free receipt with the backup expiration date.
          </li>
        </ul>
        <p>
          Implementation details, automated evidence, known release blockers, and architecture
          decisions are maintained in the <a href={repositoryUrl}>public source repository</a>.
        </p>
      </PublicSection>

      <PublicSection id="boundaries" title="Important boundaries">
        <p>
          Encryption at rest protects stored records and backups from some classes of disclosure. It
          does not protect content from an already-authorized Unfiled service while that service is
          performing an allowed operation. A compromised signed-in device, mailbox, session,
          application service, or selected AI provider can create different risks.
        </p>
        <p>
          AI-assisted content can be processed by the configured provider. Private manual content
          stays outside that provider boundary, but still passes through authorized Unfiled services
          for sync and manual product features. Users should keep devices and email accounts secure
          and should not store authentication secrets inside notes.
        </p>
      </PublicSection>

      <PublicSection id="report" title="Report a vulnerability privately">
        <p>
          Use <a href={securityReportUrl}>GitHub private vulnerability reporting</a> for a suspected
          vulnerability. That channel creates a private security advisory visible to the repository
          maintainers. Include the affected surface, impact, safe reproduction steps, and any
          relevant content-free diagnostics.
        </p>
        <p>
          Do not report a vulnerability in a public issue. Never include real note text, account
          exports, API keys, authentication codes, session tokens, database credentials, or
          encryption keys. If a secret was exposed, revoke it before submitting the report when it
          is safe to do so.
        </p>
      </PublicSection>

      <PublicSection id="research" title="Good-faith research guidelines">
        <ul>
          <li>Test only accounts and content that you own or have written authorization to use.</li>
          <li>Use the Preview environment when it is available.</li>
          <li>
            Avoid privacy violations, persistence, denial of service, and service degradation.
          </li>
          <li>Stop after confirming the minimum evidence needed to explain the issue.</li>
          <li>Allow a reasonable remediation period before public disclosure.</li>
        </ul>
        <p>
          Unfiled does not currently offer a paid bug bounty or promise payment. Good-faith work
          consistent with these guidelines will be handled as a security report, not treated as an
          acceptable-use violation.
        </p>
      </PublicSection>

      <PublicSection id="response" title="Response process">
        <p>
          The goal is to acknowledge a complete report within 2 business days, establish severity
          and next steps within 7 business days, and send meaningful updates while remediation is in
          progress. These are beta response targets, not a service-level agreement.
        </p>
        <p>
          Security incidents that can expose note content, cross owner boundaries, or bypass
          authorization block release and feature work until contained. Ordinary support requests
          belong on the <Link href="/support">support page</Link>.
        </p>
      </PublicSection>
    </PublicDocument>
  );
}
