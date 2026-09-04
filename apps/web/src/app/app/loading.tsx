import { PageHeading } from "@/components/product/page-heading";
import { ResourceSkeleton } from "@/components/product/resource-states";

/** The Inbox's shape while it loads: its heading, the composer's card, then rows. */
export default function AppLoading() {
  return (
    <main
      id="main-content"
      aria-busy="true"
      aria-label="Loading your Inbox"
      className="product-page"
    >
      <div className="content-column">
        <PageHeading title="Inbox" />
        <div className="capture-composer mt-10" aria-hidden="true">
          <div>
            <div className="skeleton-block h-8 w-56 max-w-full rounded-control" />
            <div className="skeleton-block mt-3 h-4 w-64 max-w-full rounded-control" />
          </div>
          <div className="skeleton-block h-56 w-full rounded-frame" />
        </div>
        <div className="mt-12">
          <ResourceSkeleton rows={3} />
        </div>
      </div>
    </main>
  );
}
