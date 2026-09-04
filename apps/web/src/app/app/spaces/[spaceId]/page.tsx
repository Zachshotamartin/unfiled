import { entityIdSchema } from "@unfiled/contracts";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { SpaceView } from "@/components/product/space-view";
import { UnfiledGlyph } from "@/components/product/unfiled-glyph";

export const metadata: Metadata = { title: "Space" };

/** A space pushes its own page (ADR-0019, decision 6), reached from the Library's grid. */
export default async function SpacePage({
  params
}: Readonly<{ params: Promise<{ spaceId: string }> }>) {
  const parsed = entityIdSchema("spc").safeParse((await params).spaceId);
  if (!parsed.success) notFound();
  return (
    <main id="main-content" className="product-page">
      <div className="content-column">
        <Link href="/app/library" className="capture-detail-back">
          <UnfiledGlyph glyph="back" size={15} weight={2} /> Library
        </Link>
        <SpaceView spaceId={parsed.data} />
      </div>
    </main>
  );
}
