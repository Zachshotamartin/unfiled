import {
  ListStructuredDataSchema,
  LogStructuredDataSchema,
  PlainStructuredDataSchema,
  ProjectStructuredDataSchema,
  type NoteStructuredData,
  type NoteType
} from "@unfiled/contracts";

export function defaultStructuredData(type: NoteType): NoteStructuredData {
  switch (type) {
    case "list":
      return ListStructuredDataSchema.parse({ schemaVersion: 1, items: [] });
    case "log":
      return LogStructuredDataSchema.parse({ schemaVersion: 1, entries: [] });
    case "project":
      return ProjectStructuredDataSchema.parse({ schemaVersion: 1, checklistItems: [] });
    case "generic":
    case "principle":
      return PlainStructuredDataSchema.parse({ schemaVersion: 1 });
  }
}

export function structuredDataForType(type: NoteType, value: unknown): NoteStructuredData {
  switch (type) {
    case "list":
      return ListStructuredDataSchema.parse(value);
    case "log":
      return LogStructuredDataSchema.parse(value);
    case "project":
      return ProjectStructuredDataSchema.parse(value);
    case "generic":
    case "principle":
      return PlainStructuredDataSchema.parse(value);
  }
}

export function openStateForStructuredNote(
  type: NoteType,
  value: NoteStructuredData,
  fallback: boolean
): boolean {
  switch (type) {
    case "list": {
      const { items } = ListStructuredDataSchema.parse(value);
      return items.length === 0 || items.some(({ checked }) => !checked);
    }
    case "project": {
      const { checklistItems } = ProjectStructuredDataSchema.parse(value);
      return checklistItems.length === 0 || checklistItems.some(({ checked }) => !checked);
    }
    case "generic":
    case "log":
    case "principle":
      return fallback;
  }
}
