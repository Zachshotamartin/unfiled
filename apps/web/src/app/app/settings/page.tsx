import type { Metadata } from "next";
import { PageHeading } from "@/components/product/page-heading";
import { SettingsView } from "@/components/product/settings-view";
import { isManagedFallbackAvailable } from "@/server/ai-settings/managed-fallback-capability";
export const metadata: Metadata = { title: "Settings" };
export default function SettingsPage() {
  const managedFallbackAvailable = isManagedFallbackAvailable();
  return (
    <main id="main-content" className="product-page">
      <div className="content-column">
        <PageHeading eyebrow="Account and privacy" title="Settings" />
        <section className="mt-12">
          <SettingsView managedFallbackAvailable={managedFallbackAvailable} />
        </section>
      </div>
    </main>
  );
}
