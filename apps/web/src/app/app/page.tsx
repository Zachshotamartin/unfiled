import { PlusIcon } from "@phosphor-icons/react/ssr";
import type { Metadata } from "next";
import Link from "next/link";

import { NoteLibrary } from "@/components/product/note-library";
import { PageHeading } from "@/components/product/page-heading";

export const metadata: Metadata = {
  title: "Today",
  description: "Recent notes in your Unfiled library."
};

export default function TodayPage() {
  const date = new Intl.DateTimeFormat("en-US", {
    dateStyle: "full",
    timeZone: "America/Los_Angeles"
  }).format(new Date());

  return (
    <main id="main-content" className="product-page">
      <div className="content-column">
        <PageHeading
          eyebrow={date}
          title="Today"
          action={
            <Link href="/app/notes/new" className="button-primary">
              <PlusIcon size={17} weight="bold" aria-hidden="true" /> New note
            </Link>
          }
        />
        <section aria-labelledby="recent-heading" className="mt-12">
          <div className="mb-4 flex items-end justify-between gap-4">
            <h2
              id="recent-heading"
              className="text-sm font-semibold tracking-wide text-muted-content uppercase"
            >
              Recently touched
            </h2>
            <Link href="/app/notes" className="text-sm text-muted-content hover:text-content">
              All notes
            </Link>
          </div>
          <NoteLibrary query="/api/v1/notes?limit=8" />
        </section>
      </div>
    </main>
  );
}
