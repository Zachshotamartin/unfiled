import type { Metadata } from "next";
import { PageHeading } from "@/components/product/page-heading";
import { SpacesView } from "@/components/product/spaces-view";
export const metadata: Metadata = { title: "Spaces" };
export default function SpacesPage() {
  return (
    <main id="main-content" className="product-page">
      <div className="content-column">
        <PageHeading eyebrow="Light structure" title="Spaces" />
        <p className="mt-5 max-w-xl leading-7 text-muted-content">
          Keep the hierarchy shallow: one parent and one child. A note can always live without a
          space.
        </p>
        <section className="mt-10" aria-label="Manage spaces">
          <SpacesView />
        </section>
      </div>
    </main>
  );
}
