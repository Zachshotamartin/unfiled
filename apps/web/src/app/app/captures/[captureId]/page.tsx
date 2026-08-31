import { ArrowLeftIcon } from "@phosphor-icons/react/ssr";
import { entityIdSchema } from "@unfiled/contracts";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { CaptureDetailView } from "@/components/product/capture-detail-view";

export const metadata: Metadata = { title: "Capture receipt" };

export default async function CapturePage({
  params
}: Readonly<{ params: Promise<{ captureId: string }> }>) {
  const parsed = entityIdSchema("cap").safeParse((await params).captureId);
  if (!parsed.success) notFound();
  return (
    <main id="main-content" className="capture-detail-page">
      <div className="capture-detail-column">
        <Link href="/app" className="capture-detail-back">
          <ArrowLeftIcon size={15} aria-hidden="true" /> Today
        </Link>
        <CaptureDetailView captureId={parsed.data} />
      </div>
    </main>
  );
}
