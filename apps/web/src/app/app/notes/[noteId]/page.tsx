import { entityIdSchema } from "@unfiled/contracts";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { NoteEditor } from "@/components/product/note-editor";

export const metadata: Metadata = { title: "Edit note" };

export default async function NotePage({
  params
}: Readonly<{ params: Promise<{ noteId: string }> }>) {
  const parsed = entityIdSchema("note").safeParse((await params).noteId);
  if (!parsed.success) notFound();
  return <NoteEditor noteId={parsed.data} />;
}
