import type { NoteSummary } from "@unfiled/contracts";

export type NoteDayGroup = Readonly<{
  notes: readonly NoteSummary[];
  title: string;
}>;

function isSameDay(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

function daysBefore(reference: Date, days: number): Date {
  const shifted = new Date(reference.getTime());
  shifted.setDate(shifted.getDate() - days);
  return shifted;
}

/**
 * Notes grouped by when they last changed (ADR-0019, decision 6), the same five groups and the
 * same order the iPhone app's `NoteLibraryGrouping` produces, so a library reads the same on
 * both surfaces. A note the owner pinned leads, whenever it changed; a timestamp that cannot be
 * read falls to "Earlier" rather than being dropped.
 */
export function groupNotesByDay(
  notes: readonly NoteSummary[],
  now: Date = new Date()
): readonly NoteDayGroup[] {
  const pinned: NoteSummary[] = [];
  const today: NoteSummary[] = [];
  const yesterday: NoteSummary[] = [];
  const week: NoteSummary[] = [];
  const earlier: NoteSummary[] = [];

  for (const note of notes) {
    if (note.pinnedAt !== null) {
      pinned.push(note);
      continue;
    }
    const updatedAt = new Date(note.updatedAt);
    if (Number.isNaN(updatedAt.getTime())) {
      earlier.push(note);
    } else if (isSameDay(updatedAt, now)) {
      today.push(note);
    } else if (isSameDay(updatedAt, daysBefore(now, 1))) {
      yesterday.push(note);
    } else if (updatedAt.getTime() > daysBefore(now, 7).getTime()) {
      week.push(note);
    } else {
      earlier.push(note);
    }
  }

  return [
    { notes: pinned, title: "Pinned" },
    { notes: today, title: "Today" },
    { notes: yesterday, title: "Yesterday" },
    { notes: week, title: "This week" },
    { notes: earlier, title: "Earlier" }
  ].filter((group) => group.notes.length > 0);
}
