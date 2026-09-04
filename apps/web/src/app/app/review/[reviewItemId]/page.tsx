import { entityIdSchema } from "@unfiled/contracts";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { PageHeading } from "@/components/product/page-heading";
import { ReviewView } from "@/components/product/review-view";
import { UnfiledGlyph } from "@/components/product/unfiled-glyph";

export const metadata: Metadata = { title: "Review" };

/**
 * One review item's own page (ADR-0019, decision 6), reached from a capture's receipt through
 * "Open Review" and carrying the same decision the Inbox card carries. Review is not a
 * destination: the list of open decisions lives in the Inbox.
 */
export default async function ReviewItemPage({
  params
}: Readonly<{ params: Promise<{ reviewItemId: string }> }>) {
  const parsed = entityIdSchema("rvw").safeParse((await params).reviewItemId);
  if (!parsed.success) notFound();
  return (
    <main id="main-content" className="product-page">
      <div className="content-column">
        <Link href="/app" className="capture-detail-back">
          <UnfiledGlyph glyph="back" size={15} weight={2} /> Inbox
        </Link>
        <PageHeading title="Review" />
        <div className="mt-8">
          <ReviewView focusReviewItemId={parsed.data} />
        </div>
      </div>
    </main>
  );
}
