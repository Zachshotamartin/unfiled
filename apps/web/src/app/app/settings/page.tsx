import type { Metadata } from "next";
import { PageHeading } from "@/components/product/page-heading";
import { SettingsView } from "@/components/product/settings-view";
export const metadata: Metadata = { title: "Settings" };
export default function SettingsPage() {
  return (
    <main id="main-content" className="product-page">
      <div className="content-column">
        <PageHeading eyebrow="Account and privacy" title="Settings" />
        <section className="mt-12">
          <SettingsView />
        </section>
      </div>
    </main>
  );
}
