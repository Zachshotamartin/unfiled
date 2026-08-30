import type { Metadata } from "next";

import { NewNoteForm } from "@/components/product/new-note-form";

export const metadata: Metadata = { title: "New note" };

export default function NewNotePage() {
  return (
    <main id="main-content" className="editor-page">
      <NewNoteForm />
    </main>
  );
}
