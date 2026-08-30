import type { MobileNoteDetail } from "./mobileNotesApi";

export interface ChecklistItemView {
  checked: boolean;
  id: string;
  ordinal: number;
  text: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function checklistItemsFromNote(note: MobileNoteDetail): ChecklistItemView[] {
  const structured = note.structuredData as Record<string, unknown>;
  const raw = structured.checklistItems ?? structured.items;
  if (!Array.isArray(raw)) return [];
  return raw
    .flatMap((value, index) => {
      if (!isRecord(value)) return [];
      if (typeof value.id !== "string" || typeof value.text !== "string") return [];
      return [
        {
          checked: value.checked === true,
          id: value.id,
          ordinal: typeof value.ordinal === "number" ? value.ordinal : index,
          text: value.text
        }
      ];
    })
    .sort((first, second) => first.ordinal - second.ordinal);
}

export function toggleChecklistItemLocally(
  items: ChecklistItemView[],
  itemId: string,
  checked: boolean
): ChecklistItemView[] {
  return items.map((item) => (item.id === itemId ? { ...item, checked } : item));
}
