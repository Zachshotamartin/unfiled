import { createEntityId } from "@unfiled/contracts";
import { router } from "expo-router";
import { useRef, useState, type ReactElement } from "react";

import { MobileNotesError } from "../../features/notes/mobileNotesApi";
import {
  NoteEditor,
  resolvedEditorTitle,
  type NoteEditorSaveResult,
  type NoteEditorValue
} from "../../features/notes/NoteEditor";
import {
  useMobileNotesApi,
  useNoteList,
  useSpaces,
  useTags
} from "../../features/notes/useNotesApi";

const initialValue: NoteEditorValue = {
  bodyMarkdown: "",
  links: [],
  privacy: "ai_assisted",
  spaceId: null,
  tagIds: [],
  title: "",
  type: "generic"
};

export default function NewNoteScreen(): ReactElement {
  const api = useMobileNotesApi();
  const notes = useNoteList();
  const spaces = useSpaces();
  const tags = useTags();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saveAttempt = useRef<{ key: string; signature: string } | null>(null);

  const save = async (value: NoteEditorValue): Promise<NoteEditorSaveResult | null> => {
    if (api === null || busy) return null;
    setBusy(true);
    setError(null);
    try {
      const normalized = { ...value, title: resolvedEditorTitle(value) };
      const signature = JSON.stringify(normalized);
      if (saveAttempt.current?.signature !== signature) {
        saveAttempt.current = { key: createEntityId("key"), signature };
      }
      const note = await api.createNote({
        ...normalized,
        idempotencyKey: saveAttempt.current.key
      });
      saveAttempt.current = null;
      router.replace({ pathname: "/notes/[noteId]", params: { noteId: note.id } });
      return {
        revision: note.currentRevision,
        value: {
          bodyMarkdown: note.bodyMarkdown,
          links: note.links,
          privacy: note.privacy,
          spaceId: note.spaceId,
          tagIds: note.tagIds,
          title: note.title,
          type: note.type
        }
      };
    } catch (cause) {
      setError(cause instanceof MobileNotesError ? cause.message : "Couldn't create this note.");
      return null;
    } finally {
      setBusy(false);
    }
  };

  const createTag = async (name: string) => {
    if (api === null) throw new MobileNotesError("offline", "Connect to create a tag.", 0);
    const tag = await api.createTag(name, createEntityId("key"));
    await tags.refresh();
    return tag;
  };

  return (
    <NoteEditor
      busy={busy}
      error={error}
      initialValue={initialValue}
      linkCandidates={notes.value}
      mode="create"
      onCreateTag={createTag}
      onSave={save}
      spaces={spaces.value}
      tags={tags.value}
    />
  );
}
