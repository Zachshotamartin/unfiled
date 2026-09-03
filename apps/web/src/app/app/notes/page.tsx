import type { Metadata } from "next";

import { NoteLibrary } from "@/components/product/note-library";
import { PageHeading } from "@/components/product/page-heading";

export const metadata: Metadata = { title: "Notes" };

export default function NotesPage() {
  return (
    <main id="main-content" className="product-page">
      <div className="content-column">
        <PageHeading eyebrow="Your library" title="Notes" />
        <section aria-label="Notes" className="mt-12">
          <NoteLibrary />
        </section>
      </div>
    </main>
  );
}
