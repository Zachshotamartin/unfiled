import { PlusIcon } from "@phosphor-icons/react/ssr";
import type { Metadata } from "next";
import Link from "next/link";

import { NoteLibrary } from "@/components/product/note-library";
import { PageHeading } from "@/components/product/page-heading";

export const metadata: Metadata = { title: "Notes" };

export default function NotesPage() {
  return (
    <main id="main-content" className="product-page">
      <div className="content-column">
        <PageHeading
          eyebrow="Your library"
          title="Notes"
          action={
            <Link href="/app/notes/new" className="button-primary">
              <PlusIcon size={17} weight="bold" aria-hidden="true" /> New note
            </Link>
          }
        />
        <section aria-label="Notes" className="mt-12">
          <NoteLibrary />
        </section>
      </div>
    </main>
  );
}
