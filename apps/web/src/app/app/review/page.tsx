import type { Metadata } from "next";
import { PageHeading } from "@/components/product/page-heading";
import { ReviewView } from "@/components/product/review-view";
export const metadata: Metadata = { title: "Review" };
export default function ReviewPage() {
  return (
    <main id="main-content" className="product-page">
      <div className="content-column">
        <PageHeading eyebrow="Changes held safely" title="Review" />
        <p className="mt-5 max-w-xl leading-7 text-muted-content">
          When delayed organization targets an older revision or structured Markdown cannot be
          reconciled safely, Unfiled leaves the saved note unchanged and puts the decision here. A
          stale manual save stays in its editor so you can reconcile it there.
        </p>
        <section className="mt-12" aria-labelledby="review-items">
          <h2 id="review-items" className="section-label">
            Open conflicts
          </h2>
          <div className="mt-4">
            <ReviewView />
          </div>
        </section>
      </div>
    </main>
  );
}
