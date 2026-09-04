import type { Metadata } from "next";

import { DeskLibraryMenu } from "@/components/product/desk-menu";
import { LibraryView } from "@/components/product/library-view";
import { PageHeading } from "@/components/product/page-heading";

export const metadata: Metadata = {
  title: "Library",
  description: "Everything Unfiled has filed, with one search across it."
};

/**
 * The Library (ADR-0019, decision 6): where filed things live. One search field, spaces as a
 * grid of cards, then notes grouped by day. Search is no longer a destination of its own.
 */
export default function LibraryPage() {
  return (
    <main id="main-content" className="product-page">
      <div className="content-column">
        <PageHeading title="Library" action={<DeskLibraryMenu />} />
        <div className="mt-8">
          <LibraryView />
        </div>
      </div>
    </main>
  );
}
