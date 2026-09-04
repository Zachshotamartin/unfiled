import { PageHeading } from "@/components/product/page-heading";
import { ResourceSkeleton } from "@/components/product/resource-states";

/** The archive's shape while it loads: heading, then its two lists. */
export default function ArchiveLoading() {
  return (
    <main
      id="main-content"
      aria-busy="true"
      aria-label="Loading the archive"
      className="product-page"
    >
      <div className="content-column">
        <PageHeading eyebrow="Kept out of the way" title="Archive" />
        <section className="mt-12" aria-hidden="true">
          <div className="skeleton-block h-3 w-16" />
          <div className="mt-4">
            <ResourceSkeleton rows={3} />
          </div>
        </section>
        <section className="mt-16" aria-hidden="true">
          <div className="skeleton-block h-3 w-28" />
          <div className="skeleton-block mt-3 h-4 w-80 max-w-full" />
          <div className="mt-4">
            <ResourceSkeleton rows={2} />
          </div>
        </section>
      </div>
    </main>
  );
}
