import { PageHeading } from "@/components/product/page-heading";
import { ResourceSkeleton } from "@/components/product/resource-states";

/** The Library's shape while it loads: heading, the search field, spaces, then notes by day. */
export default function LibraryLoading() {
  return (
    <main
      id="main-content"
      aria-busy="true"
      aria-label="Loading your Library"
      className="product-page"
    >
      <div className="content-column">
        <PageHeading title="Library" />
        <div className="library-search mt-8" aria-hidden="true">
          <div className="skeleton-block h-4 w-40" />
        </div>
        <section className="mt-8" aria-hidden="true">
          <div className="skeleton-block h-3 w-16" />
          <div className="space-grid mt-4">
            {[0, 1, 2].map((card) => (
              <div key={card} className="space-card">
                <div className="skeleton-block h-5 w-5 rounded-control" />
                <div>
                  <div className="skeleton-block h-4 w-24" />
                  <div className="skeleton-block mt-2 h-3 w-14" />
                </div>
              </div>
            ))}
          </div>
        </section>
        <section className="mt-8" aria-hidden="true">
          <div className="skeleton-block mb-3.5 h-3 w-12" />
          <ResourceSkeleton rows={4} />
        </section>
      </div>
    </main>
  );
}
