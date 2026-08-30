import type { Metadata } from "next";

import { DesktopAppNavigation, MobileAppNavigation } from "@/components/product/app-navigation";
import { CaptureComposer } from "@/components/product/capture-composer";
import { ReceiptRow } from "@/components/product/receipt-row";
import { SourceDetail } from "@/components/product/source-detail";
import { receiptFixtures } from "@/lib/app-fixtures";

export const metadata: Metadata = {
  title: "Today",
  description: "Your Unfiled capture ledger and notes."
};

export default function TodayPage() {
  return (
    <div className="min-h-[100dvh] bg-page md:grid md:grid-cols-[76px_minmax(0,1fr)] xl:grid-cols-[220px_minmax(0,1fr)_380px]">
      <DesktopAppNavigation />

      <main
        id="main-content"
        className="min-w-0 px-4 pt-8 pb-28 sm:px-7 md:px-9 md:pt-12 md:pb-14 lg:px-12 xl:px-14"
      >
        <div className="mx-auto max-w-[760px]">
          <header>
            <h1 className="text-5xl leading-none font-semibold tracking-[-0.055em] sm:text-6xl">
              Today
            </h1>
            <time dateTime="2026-08-30" className="mt-4 block font-mono text-sm text-muted-content">
              Sunday, August 30
            </time>
          </header>

          <section aria-label="Quick capture" className="mt-10">
            <CaptureComposer />
          </section>

          <section aria-label="Today receipts" className="mt-5 border-t border-outline">
            {receiptFixtures.map((receipt) => (
              <ReceiptRow key={receipt.id} receipt={receipt} />
            ))}
          </section>

          <details className="mt-8 rounded-frame border border-outline bg-panel p-5 xl:hidden">
            <summary className="cursor-pointer text-sm font-semibold text-content">
              View selected source
            </summary>
            <div className="mt-6">
              <SourceDetail />
            </div>
          </details>
        </div>
      </main>

      <aside
        aria-label="Selected receipt details"
        className="sticky top-0 hidden h-[100dvh] overflow-y-auto border-l border-outline bg-panel px-8 py-14 xl:block"
      >
        <SourceDetail />
      </aside>

      <MobileAppNavigation />
    </div>
  );
}
