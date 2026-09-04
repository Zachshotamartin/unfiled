import { CardSkeleton } from "@/components/product/resource-states";

/** A review's shape while it loads: the way back, then the card. */
export default function ReviewLoading() {
  return (
    <main
      id="main-content"
      aria-busy="true"
      aria-label="Loading the review"
      className="product-page"
    >
      <div className="content-column" aria-hidden="true">
        <div className="skeleton-block h-5 w-20" />
        <div className="mt-8">
          <CardSkeleton cards={1} />
        </div>
      </div>
    </main>
  );
}
