import { createEntityId } from "@unfiled/contracts";
import { useState, type ReactElement } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";

import { Rule } from "../../components/Rule";
import { Screen } from "../../components/Screen";
import { MobileNotesError, relativeUpdatedAt } from "../../features/notes/mobileNotesApi";
import { useMobileNotesApi, useNoteList } from "../../features/notes/useNotesApi";
import { nativeTheme } from "../../theme/nativeTheme";

export default function DeletedNotesScreen(): ReactElement {
  const api = useMobileNotesApi();
  const notes = useNoteList({ deleted: true });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const restore = async (noteId: string, revision: number): Promise<void> => {
    if (api === null || busyId !== null) return;
    setBusyId(noteId);
    setMessage(null);
    try {
      await api.restoreDeletedNote(noteId, revision, createEntityId("key"));
      await notes.refresh();
    } catch (cause) {
      setMessage(cause instanceof MobileNotesError ? cause.message : "Couldn't restore this note.");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Screen eyebrow="Recovery" title="Recently deleted">
      <Text style={styles.explainer}>
        Deleted notes remain recoverable here for 30 days. After that, Unfiled permanently removes
        the note and its revision history.
      </Text>
      <Text accessibilityLiveRegion="polite" style={styles.message}>
        {message ?? notes.error}
      </Text>
      {notes.loading ? <ActivityIndicator color={nativeTheme.color.accent} /> : null}
      {!notes.loading && notes.value.length === 0 ? (
        <Text style={styles.empty}>No deleted notes.</Text>
      ) : null}
      {notes.value.map((note) => (
        <View key={note.id}>
          <View style={styles.row}>
            <View style={styles.body}>
              <Text style={styles.title}>{note.title}</Text>
              <Text style={styles.detail}>
                Deleted {relativeUpdatedAt(note.updatedAt)} ago · 30-day recovery window
              </Text>
            </View>
            <Pressable
              accessibilityLabel={`Restore ${note.title}`}
              accessibilityRole="button"
              disabled={busyId !== null}
              onPress={() => void restore(note.id, note.currentRevision)}
              style={styles.restore}
            >
              <Text style={styles.restoreText}>
                {busyId === note.id ? "Restoring…" : "Restore"}
              </Text>
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
  detail: { color: nativeTheme.color.textSecondary, fontSize: 13, marginTop: 6 },
  empty: { color: nativeTheme.color.textSecondary, fontSize: 15, paddingTop: 42 },
  explainer: { color: nativeTheme.color.textSecondary, fontSize: 14, lineHeight: 22 },
  message: { color: nativeTheme.color.danger, fontSize: 13, minHeight: 30, paddingTop: 8 },
  restore: { justifyContent: "center", minHeight: 44, paddingLeft: 16 },
  restoreText: { color: nativeTheme.color.accent, fontSize: 13, fontWeight: "700" },
  row: { alignItems: "center", flexDirection: "row", minHeight: 78, paddingVertical: 12 },
  title: { color: nativeTheme.color.textPrimary, fontSize: 16, fontWeight: "600" }
});
