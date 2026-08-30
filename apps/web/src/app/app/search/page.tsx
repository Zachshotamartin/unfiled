import type { Metadata } from "next";
import { PageHeading } from "@/components/product/page-heading";
import { SearchView } from "@/components/product/search-view";
export const metadata: Metadata = { title: "Search" };
export default function SearchPage() {
  return (
    <main id="main-content" className="product-page">
      <div className="content-column">
        <PageHeading eyebrow="Across your library" title="Search" />
        <section className="mt-10">
          <SearchView />
        </section>
      </div>
    </main>
  );
}
