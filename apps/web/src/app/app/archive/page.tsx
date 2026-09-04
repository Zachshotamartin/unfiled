import type { Metadata } from "next";
import { NoteLibrary } from "@/components/product/note-library";
import { PageHeading } from "@/components/product/page-heading";
export const metadata: Metadata = { title: "Archive" };
export default function ArchivePage() {
  return (
    <main id="main-content" className="product-page">
      <div className="content-column">
        <PageHeading eyebrow="Kept out of the way" title="Archive" />
        <section className="mt-12" aria-labelledby="archived-heading">
          <h2 id="archived-heading" className="section-label">
            Archived
          </h2>
          <div className="mt-4">
            <NoteLibrary
              query="/api/v1/notes?archive=only&deleted=exclude&limit=50"
              emptyTitle="The archive is empty."
              emptyBody="Archived notes stay searchable and can be restored at any time."
            />
          </div>
        </section>
        <section className="mt-16" aria-labelledby="deleted-heading" id="recently-deleted">
          <h2 id="deleted-heading" className="section-label">
            Recently deleted
          </h2>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-content">
            Deleted notes stay recoverable for 30 days. After that, Unfiled permanently removes the
            note and its revision history.
          </p>
          <div className="mt-4">
            <NoteLibrary
              query="/api/v1/notes?archive=include&deleted=only&limit=50"
              emptyTitle="Nothing waiting for recovery."
              emptyBody="Deleted notes appear here during the recovery window."
            />
          </div>
        </section>
      </div>
    </main>
  );
}
