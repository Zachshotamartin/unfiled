import type { Metadata } from "next";
import Link from "next/link";

import { PublicCallout, PublicDocument, PublicSection } from "@/components/public/public-document";
import { supportRequestUrl } from "@/lib/public-site";

export const metadata: Metadata = {
  title: "Privacy policy",
  description: "How the Unfiled beta handles account, note, AI, and service data."
};

const navigation = [
  { href: "#scope", label: "Scope" },
  { href: "#data", label: "Data we handle" },
  { href: "#use", label: "How data is used" },
  { href: "#ai", label: "AI-assisted features" },
  { href: "#security", label: "Security model" },
  { href: "#sharing", label: "Service providers" },
  { href: "#retention", label: "Retention and deletion" },
  { href: "#choices", label: "Your choices" },
  { href: "#contact", label: "Contact" }
] as const;

export default function PrivacyPage() {
  return (
    <PublicDocument
      eyebrow="Trust / Privacy"
      title="Your notes are personal. The policy should be plain."
      summary="This policy explains what the Unfiled private beta handles, why it is needed, and where AI is allowed to participate."
      navigation={navigation}
    >
      <PublicSection id="scope" title="Scope">
        <p>
          This policy applies to the Unfiled website, web app, native iPhone app, and Lock Screen
          capture widget. Unfiled is the selected launch candidate for a planned, invite-only
          portfolio beta. This policy does not cover third-party sites that you choose to visit.
        </p>
        <PublicCallout>
          <p>
            Unfiled is built for private notes, but it is not end-to-end encrypted or a
            zero-knowledge service. Authorized application services can decrypt narrowly scoped
            content to sync it and, only for AI-assisted content, provide organization and search
            features.
          </p>
        </PublicCallout>
      </PublicSection>

      <PublicSection id="data" title="Data we handle">
        <h3>Account and session data</h3>
        <p>
          We handle your email address, account identifier, authentication sessions, and security
          metadata needed to sign you in and protect your account. Unfiled uses passwordless email
          codes and does not ask you to create an Unfiled password.
        </p>

        <h3>Content and organization data</h3>
        <p>
          We handle the captures, notes, revisions, lists, logs, spaces, tags, links, routing rules,
          corrections, review decisions, and generated suggestions that you choose to create. We
          also handle metadata needed for sync, conflict resolution, encryption, search, export,
          deletion, and abuse prevention.
        </p>

        <h3>Settings and provider credentials</h3>
        <p>
          We handle your AI preferences and budget settings. If you choose bring-your-own-key mode,
          your OpenAI API key is validated in bounded server memory and stored in Supabase Vault.
          Clients can read status metadata, such as the last four characters and validation time,
          but cannot retrieve the stored key.
        </p>

        <h3>Service diagnostics</h3>
        <p>
          We handle limited technical records such as timestamps, request outcomes, job state,
          performance measurements, security events, coarse device or browser information, and IP
          addresses when infrastructure providers make them available. Product logs are designed to
          exclude note text, search text, credentials, authentication codes, and encryption keys.
        </p>
      </PublicSection>

      <PublicSection id="use" title="How data is used">
        <p>We use data only as reasonably needed to:</p>
        <ul>
          <li>authenticate you and keep sessions synchronized;</li>
          <li>store, retrieve, organize, search, edit, export, and delete your notes;</li>
          <li>show what changed, preserve revision history, and support undo and review;</li>
          <li>secure the service, prevent abuse, diagnose failures, and restore availability;</li>
          <li>honor your AI, privacy, routing, and provider settings; and</li>
          <li>improve reliability using content-free operational measurements.</li>
        </ul>
        <p>
          We do not sell your personal information or use note content for advertising. The beta
          does not use note content to train an Unfiled model.
        </p>
      </PublicSection>

      <PublicSection id="ai" title="AI-assisted features are explicit">
        <p>
          AI-assisted captures and notes may send the minimum needed plaintext to the configured AI
          provider to classify a capture, select or create a destination, propose an expansion, or
          run semantic search. Candidate context is owner-scoped and checked again before a result
          is written. Model output is treated as untrusted data and cannot authorize a write by
          itself.
        </p>
        <p>
          Unfiled currently supports an app-managed OpenAI configuration and an optional OpenAI key
          that you provide. Provider requests are configured with storage disabled where the API
          supports that option. OpenAI may still retain limited abuse-monitoring data under the data
          controls that apply to the relevant OpenAI project. Unfiled will record the exact
          production provider retention setting before enabling an external beta.
        </p>
        <p>
          Choose <strong>Private manual</strong> when you do not want a note or capture sent to an
          AI provider. Private manual content can still be encrypted, synced, edited, searched
          lexically within Unfiled, exported, and deleted.
        </p>
      </PublicSection>

      <PublicSection id="security" title="Security model">
        <p>
          The production design uses TLS in transit and application encryption at rest for note
          content. It uses authenticated encrypted envelopes, owner-scoped intermediate keys, and a
          root key held outside the application database. Native local data uses an encrypted
          SQLCipher database, iOS file protection, and a device-generated Keychain key that is
          available only while the device is unlocked.
        </p>
        <p>
          Encryption reduces the impact of storage disclosure, but no service can promise absolute
          security. Unfiled services retain narrowly scoped decryption authority needed to deliver
          the selected features. See the <Link href="/security">security page</Link> for the current
          model and reporting path.
        </p>
      </PublicSection>

      <PublicSection id="sharing" title="Service providers">
        <p>
          Unfiled uses specialized infrastructure providers to operate the beta. The production
          release plan includes Vercel for application hosting, Supabase for authentication and the
          database, Amazon Web Services for managed encryption keys and security audit records,
          OpenAI for explicitly AI-assisted operations, and Apple for iPhone distribution and
          platform services.
        </p>
        <p>
          Each provider receives only the data and authority needed for its role. We may also
          disclose information when required by law, to protect users or the service, or as part of
          a business transfer with appropriate notice. Unfiled does not disclose note content for an
          unrelated commercial purpose.
        </p>
      </PublicSection>

      <PublicSection id="retention" title="Retention and deletion">
        <p>
          We keep account and note data while your account is active or as needed to provide the
          beta. A deleted note remains recoverable during its documented recovery window. Rejected
          generated suggestions are eligible for permanent deletion after 7 days.
        </p>
        <p>
          Account deletion removes live account data and revokes sessions immediately after the
          server confirms the request. Encrypted copies can remain in provider backups until the
          documented 30-day backup window expires. Security, fraud-prevention, and deletion-receipt
          records may be kept longer when they no longer contain note content and are reasonably
          needed to protect the service or establish that a request was completed.
        </p>
      </PublicSection>

      <PublicSection id="choices" title="Your choices">
        <ul>
          <li>Choose AI-assisted or Private manual handling for supported captures and notes.</li>
          <li>Select app-managed AI or your own eligible OpenAI key.</li>
          <li>Review and correct organization decisions, or undo supported changes.</li>
          <li>Download a readable account archive from Settings.</li>
          <li>
            Delete your account in the product by following the{" "}
            <Link href="/account-deletion">account deletion instructions</Link>.
          </li>
        </ul>
        <p>
          Privacy rights vary by location. You may use the support path to request access,
          correction, deletion, or another applicable privacy right. We will verify account
          ownership before acting on an account request.
        </p>
      </PublicSection>

      <PublicSection id="contact" title="Contact and changes">
        <p>
          For a privacy or account request, open a{" "}
          <a href={supportRequestUrl}>private-data-safe support request</a>. Do not paste note text,
          API keys, sign-in codes, export files, or other secrets into a public GitHub issue. Use
          the dedicated <Link href="/security">security reporting path</Link> for a vulnerability.
        </p>
        <p>
          Material changes to this policy will be dated here before they apply. If a change
          materially affects how note content is processed, the release plan requires a clear
          product notice before the change is enabled.
        </p>
      </PublicSection>
    </PublicDocument>
  );
}
