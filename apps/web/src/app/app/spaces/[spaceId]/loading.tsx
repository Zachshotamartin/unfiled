import { ResourceSkeleton } from "@/components/product/resource-states";

/** A space's shape while it loads: its name, then its notes. */
export default function SpaceLoading() {
  return (
    <main
      id="main-content"
      aria-busy="true"
      aria-label="Loading the space"
      className="product-page"
    >
      <div className="content-column" aria-hidden="true">
        <div className="skeleton-block h-5 w-20" />
        <div className="skeleton-block mt-6 h-12 w-64 max-w-full rounded-control" />
        <div className="mt-10">
          <ResourceSkeleton rows={4} />
        </div>
      </div>
    </main>
  );
}
