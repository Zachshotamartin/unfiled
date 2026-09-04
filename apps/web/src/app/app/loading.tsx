import { PageHeading } from "@/components/product/page-heading";
import { CardSkeleton } from "@/components/product/resource-states";

/** The Inbox's shape while it loads: heading, the composer, then "Needs you". */
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
        <section className="capture-composer mt-10" aria-hidden="true">
          <div className="capture-composer-intro">
            <div className="skeleton-block h-7 w-56 max-w-full rounded-control" />
            <div className="skeleton-block h-4 w-52 max-w-full rounded-control" />
          </div>
          <div className="capture-form">
            <div className="skeleton-block h-24 w-full rounded-control" />
            <div className="capture-submit-row">
              <div className="skeleton-block h-11 w-32 rounded-control" />
              <div className="skeleton-block h-11 w-24 rounded-control" />
            </div>
          </div>
        </section>
        <section className="capture-activity mt-12" aria-hidden="true">
          <div className="capture-section-heading">
            <div className="skeleton-block h-3 w-20" />
          </div>
          <div className="mt-4">
            <CardSkeleton cards={1} />
          </div>
        </section>
      </div>
    </main>
  );
}
