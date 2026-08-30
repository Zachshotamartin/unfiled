import { createEntityId } from "@unfiled/contracts";
import { router, useLocalSearchParams } from "expo-router";
import { useRef, useState, type ReactElement } from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ChecklistSurface } from "../../features/notes/ChecklistSurface";
import { checklistItemsFromNote } from "../../features/notes/checklists";
import { MobileNotesError } from "../../features/notes/mobileNotesApi";
import {
  NoteEditor,
  resolvedEditorTitle,
  type NoteEditorSaveResult,
  type NoteEditorValue
} from "../../features/notes/NoteEditor";
import {
  useMobileNotesApi,
  useNoteDetail,
  useNoteList,
  useSpaces,
  useTags
} from "../../features/notes/useNotesApi";
import { nativeTheme } from "../../theme/nativeTheme";

interface UndoState {
  mutationId: string;
  revision: number;
}

export default function NoteDetailScreen(): ReactElement {
  const params = useLocalSearchParams<{ noteId?: string }>();
  const noteId = params.noteId ?? "";
  const resource = useNoteDetail(noteId);
  const api = useMobileNotesApi();
  const notes = useNoteList();
  const spaces = useSpaces();
  const tags = useTags();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [undo, setUndo] = useState<UndoState | null>(null);
  const saveAttempt = useRef<{
    saveKey: string;
    signature: string;
  } | null>(null);
  const note = resource.value;

  if (resource.loading && note === null) {
    return (
      <SafeAreaView style={styles.state}>
        <ActivityIndicator accessibilityLabel="Loading note" color={nativeTheme.color.accent} />
      </SafeAreaView>
    );
  }
  if (note === null) {
    return (
      <SafeAreaView style={styles.state}>
        <Text style={styles.stateTitle}>This note isn’t available.</Text>
        <Text style={styles.stateBody}>{resource.error ?? "It may have been deleted."}</Text>
        <Pressable accessibilityRole="button" onPress={() => router.back()}>
          <Text style={styles.actionText}>Back to notes</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  const handleError = (cause: unknown, fallback: string): void => {
    if (cause instanceof MobileNotesError && cause.code === "stale_revision") {
      setError("A newer revision exists. Your draft is still here; reload before saving again.");
    } else {
      setError(cause instanceof MobileNotesError ? cause.message : fallback);
    }
  };

  const save = async (
    value: NoteEditorValue,
    baseline: NoteEditorValue,
    expectedRevision: number
  ): Promise<NoteEditorSaveResult | null> => {
    if (api === null || busy) return null;
    setBusy(true);
    setError(null);
    try {
      const normalized = { ...value, title: resolvedEditorTitle(value) };
      const normalizedBaseline = { ...baseline, title: resolvedEditorTitle(baseline) };
      const signature = JSON.stringify({ revision: expectedRevision, value: normalized });
      if (saveAttempt.current?.signature !== signature) {
        saveAttempt.current = {
          saveKey: createEntityId("key"),
          signature
        };
      }
      const saved = await api.updateNote(note.id, {
        expectedRevision,
        idempotencyKey: saveAttempt.current.saveKey,
        ...(normalized.bodyMarkdown === normalizedBaseline.bodyMarkdown
          ? {}
          : { bodyMarkdown: normalized.bodyMarkdown }),
        ...(JSON.stringify(normalized.links) === JSON.stringify(normalizedBaseline.links)
          ? {}
          : { links: normalized.links }),
        ...(normalized.privacy === normalizedBaseline.privacy
          ? {}
          : { privacy: normalized.privacy }),
        ...(normalized.spaceId === normalizedBaseline.spaceId
          ? {}
          : { spaceId: normalized.spaceId }),
        ...(JSON.stringify(normalized.tagIds) === JSON.stringify(normalizedBaseline.tagIds)
          ? {}
          : { tagIds: normalized.tagIds }),
        ...(normalized.title === normalizedBaseline.title ? {} : { title: normalized.title })
      });
      saveAttempt.current = null;
      setUndo(null);
      await resource.refresh();
      return {
        revision: saved.currentRevision,
        value: {
          bodyMarkdown: saved.bodyMarkdown,
          links: saved.links,
          privacy: saved.privacy,
          spaceId: saved.spaceId,
          tagIds: saved.tagIds,
          title: saved.title,
          type: saved.type
        }
      };
    } catch (cause) {
      handleError(cause, "Couldn't save this note.");
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

  const toggle = async (itemId: string, checked: boolean): Promise<void> => {
    if (api === null) throw new MobileNotesError("offline", "Connect to update this note.", 0);
    try {
      const result = await api.toggleChecklistItem(
        note.id,
        itemId,
        checked,
        note.currentRevision,
        createEntityId("key")
      );
      setUndo({ mutationId: result.mutationId, revision: result.note.currentRevision });
    } finally {
      // A failed optimistic toggle may be a stale write. Always reconcile the
      // editor with the canonical server projection before the next action.
      await resource.refresh();
    }
  };

  const undoLast = async (): Promise<void> => {
    if (api === null || undo === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.undoMutation(undo.mutationId, undo.revision, createEntityId("key"));
      setUndo(null);
      await resource.refresh();
    } catch (cause) {
      handleError(cause, "Couldn't undo that update.");
    } finally {
      setBusy(false);
    }
  };

  const archive = async (): Promise<void> => {
    if (api === null || busy) return;
    setBusy(true);
    try {
      await api.archiveNote(
        note.id,
        note.currentRevision,
        createEntityId("key"),
        note.archivedAt !== null ? false : true
      );
      router.back();
    } catch (cause) {
      handleError(cause, "Couldn't archive this note.");
      setBusy(false);
    }
  };

  const remove = (): void => {
    Alert.alert("Move note to Recently Deleted?", "You can restore it for 30 days.", [
      { style: "cancel", text: "Cancel" },
      {
        onPress: () => {
          if (api === null) return;
          setBusy(true);
          void api
            .deleteNote(note.id, note.currentRevision, createEntityId("key"))
            .then(() => router.back())
            .catch((cause: unknown) => {
              handleError(cause, "Couldn't delete this note.");
              setBusy(false);
            });
        },
        style: "destructive",
        text: "Delete"
      }
    ]);
  };

  const checklist = checklistItemsFromNote(note);
  return (
    <NoteEditor
      busy={busy}
      currentNoteId={note.id}
      error={error}
      initialValue={{
        bodyMarkdown: note.bodyMarkdown,
        links: note.links,
        privacy: note.privacy,
        spaceId: note.spaceId,
        tagIds: note.tagIds,
        title: note.title,
        type: note.type
      }}
      interactiveContent={
        checklist.length === 0 ? null : <ChecklistSurface items={checklist} onToggle={toggle} />
      }
      linkCandidates={notes.value}
      mode="edit"
      onCreateTag={createTag}
      onReload={() => resource.refresh()}
      onSave={save}
      revision={note.currentRevision}
      secondaryActions={
        <View style={styles.actions}>
          {undo === null ? null : (
            <Pressable
              accessibilityRole="button"
              onPress={() => void undoLast()}
              style={styles.action}
            >
              <Text style={styles.actionText}>Undo checklist update</Text>
            </Pressable>
          )}
          <Pressable
            accessibilityRole="button"
            onPress={() => router.push({ pathname: "/notes/history", params: { noteId: note.id } })}
            style={styles.action}
          >
            <Text style={styles.secondaryText}>Revision history</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={() => void archive()}
            style={styles.action}
          >
            <Text style={styles.secondaryText}>
              {note.archivedAt === null ? "Archive note" : "Return note to library"}
            </Text>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={remove} style={styles.action}>
            <Text style={styles.dangerText}>Delete note</Text>
          </Pressable>
        </View>
      }
      spaces={spaces.value}
      tags={tags.value}
    />
  );
}

const styles = StyleSheet.create({
  action: { justifyContent: "center", minHeight: 46 },
  actionText: { color: nativeTheme.color.accent, fontSize: 14, fontWeight: "700" },
  actions: {
    borderTopColor: nativeTheme.color.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    marginTop: 12,
    paddingVertical: 10
  },
  dangerText: { color: nativeTheme.color.danger, fontSize: 14, fontWeight: "600" },
  secondaryText: { color: nativeTheme.color.textSecondary, fontSize: 14, fontWeight: "600" },
  state: {
    alignItems: "center",
    backgroundColor: nativeTheme.color.canvas,
    flex: 1,
    justifyContent: "center",
    padding: 28
  },
  stateBody: {
    color: nativeTheme.color.textSecondary,
    fontSize: 15,
    lineHeight: 22,
    marginBottom: 18,
    marginTop: 8,
    textAlign: "center"
  },
  stateTitle: { color: nativeTheme.color.textPrimary, fontSize: 20, fontWeight: "600" }
});
