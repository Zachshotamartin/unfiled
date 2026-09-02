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
          AI-generated blocks, possible duplicates, and conflicting edits wait here for you.
          Suggestions stay separate and every review action preserves your saved note unless the
          action says otherwise.
        </p>
        <section className="mt-12" aria-labelledby="review-items">
          <h2 id="review-items" className="section-label">
            Open decisions
          </h2>
          <div className="mt-4">
            <ReviewView />
          </div>
        </section>
      </div>
    </main>
  );
}
