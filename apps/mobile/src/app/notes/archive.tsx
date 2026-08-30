import { createEntityId } from "@unfiled/contracts";
import { router } from "expo-router";
import { useState, type ReactElement } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";

import { Rule } from "../../components/Rule";
import { Screen } from "../../components/Screen";
import { MobileNotesError, relativeUpdatedAt } from "../../features/notes/mobileNotesApi";
import { useMobileNotesApi, useNoteList } from "../../features/notes/useNotesApi";
import { nativeTheme } from "../../theme/nativeTheme";

export default function ArchiveScreen(): ReactElement {
  const api = useMobileNotesApi();
  const notes = useNoteList({ archived: true });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const unarchive = async (noteId: string, revision: number): Promise<void> => {
    if (api === null || busyId !== null) return;
    setBusyId(noteId);
    setMessage(null);
    try {
      await api.archiveNote(noteId, revision, createEntityId("key"), false);
      await notes.refresh();
    } catch (cause) {
      setMessage(cause instanceof MobileNotesError ? cause.message : "Couldn't return this note.");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Screen eyebrow="Kept out of the way" title="Archive">
      {notes.loading ? <ActivityIndicator color={nativeTheme.color.accent} /> : null}
      {message === null && notes.error === null ? null : (
        <Text style={styles.message}>{message ?? notes.error}</Text>
      )}
      {!notes.loading && notes.value.length === 0 ? (
        <Text style={styles.message}>Archived notes will appear here.</Text>
      ) : null}
      {notes.value.map((note) => (
        <View key={note.id}>
          <View style={styles.row}>
            <Pressable
              accessibilityRole="button"
              onPress={() =>
                router.push({ pathname: "/notes/[noteId]", params: { noteId: note.id } })
              }
              style={styles.open}
            >
              <View style={styles.body}>
                <Text style={styles.title}>{note.title}</Text>
                <Text numberOfLines={1} style={styles.detail}>
                  Archived {relativeUpdatedAt(note.updatedAt)} ago
                </Text>
              </View>
              <Text style={styles.date}>{relativeUpdatedAt(note.updatedAt)}</Text>
            </Pressable>
            <Pressable
              accessibilityLabel={`Return ${note.title} to notes`}
              accessibilityRole="button"
              disabled={busyId !== null}
              onPress={() => void unarchive(note.id, note.currentRevision)}
              style={styles.restore}
            >
              <Text style={styles.restoreText}>{busyId === note.id ? "Returning…" : "Return"}</Text>
            </Pressable>
          </View>
          <Rule />
        </View>
      ))}
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { flex: 1 },
  date: {
    color: nativeTheme.color.textSecondary,
    fontFamily: nativeTheme.fontFamily.mono,
    fontSize: 10
  },
  detail: { color: nativeTheme.color.textSecondary, fontSize: 14, marginTop: 6 },
  message: { color: nativeTheme.color.textSecondary, fontSize: 15, lineHeight: 23 },
  open: {
    alignItems: "flex-start",
    flex: 1,
    flexDirection: "row",
    minHeight: 82,
    paddingVertical: 18
  },
  restore: { justifyContent: "center", minHeight: 44, paddingLeft: 14 },
  restoreText: { color: nativeTheme.color.accent, fontSize: 12, fontWeight: "700" },
  row: { alignItems: "center", flexDirection: "row", minHeight: 82 },
  title: { color: nativeTheme.color.textPrimary, fontSize: 17, fontWeight: "600" }
});
