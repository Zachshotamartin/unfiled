import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import type { ReactElement } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";

import { Rule } from "../../components/Rule";
import { Screen } from "../../components/Screen";
import { noteTypeLabel, relativeUpdatedAt } from "../../features/notes/mobileNotesApi";
import { useNoteList } from "../../features/notes/useNotesApi";
import { nativeTheme } from "../../theme/nativeTheme";

export default function NotesScreen(): ReactElement {
  const notes = useNoteList();
  return (
    <Screen
      eyebrow="Your library"
      rightAccessory={
        <Pressable
          accessibilityLabel="Create a note"
          accessibilityRole="button"
          onPress={() => router.push("/notes/new")}
          style={({ pressed }) => [styles.addButton, pressed && styles.pressed]}
        >
          <Ionicons color={nativeTheme.color.accentContrast} name="add" size={24} />
        </Pressable>
      }
      title="Notes"
    >
      <View style={styles.utilityRow}>
        <Pressable
          accessibilityRole="button"
          onPress={() => router.push("/spaces")}
          style={styles.utility}
        >
          <Ionicons color={nativeTheme.color.textSecondary} name="folder-outline" size={18} />
          <Text style={styles.utilityText}>Spaces</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={() => router.push("/notes/archive")}
          style={styles.utility}
        >
          <Ionicons color={nativeTheme.color.textSecondary} name="archive-outline" size={18} />
          <Text style={styles.utilityText}>Archive</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={() => router.push("/notes/deleted")}
          style={styles.utility}
        >
          <Ionicons color={nativeTheme.color.textSecondary} name="trash-outline" size={18} />
          <Text style={styles.utilityText}>Deleted</Text>
        </Pressable>
      </View>
      <Rule />

      {notes.loading ? (
        <View accessibilityLabel="Loading notes" style={styles.state}>
          <ActivityIndicator color={nativeTheme.color.accent} />
        </View>
      ) : null}
      {notes.error === null ? null : (
        <View style={styles.state}>
          <Text accessibilityLiveRegion="polite" style={styles.stateTitle}>
            Notes are unavailable
          </Text>
          <Text style={styles.stateBody}>{notes.error}</Text>
          <Pressable accessibilityRole="button" onPress={() => void notes.refresh()}>
            <Text style={styles.retry}>Try again</Text>
          </Pressable>
        </View>
      )}
      {!notes.loading && notes.error === null && notes.value.length === 0 ? (
        <View style={styles.state}>
          <View style={styles.accentRule} />
          <Text style={styles.stateTitle}>Nothing to organize yet.</Text>
          <Text style={styles.stateBody}>
            Write a note yourself, or capture a thought and let Unfiled place it later.
          </Text>
          <Pressable accessibilityRole="button" onPress={() => router.push("/notes/new")}>
            <Text style={styles.retry}>Create your first note</Text>
          </Pressable>
        </View>
      ) : null}

      {notes.value.map((note) => (
        <View key={note.id}>
          <Pressable
            accessibilityHint={`Updated ${relativeUpdatedAt(note.updatedAt)} ago`}
            accessibilityLabel={`${note.title}, ${noteTypeLabel(note.type)} note`}
            accessibilityRole="button"
            onPress={() =>
              router.push({ pathname: "/notes/[noteId]", params: { noteId: note.id } })
            }
            style={({ pressed }) => [styles.noteRow, pressed && styles.pressed]}
          >
            <View style={styles.noteType}>
              <Text style={styles.noteTypeText}>{noteTypeLabel(note.type).slice(0, 1)}</Text>
            </View>
            <View style={styles.noteBody}>
              <Text numberOfLines={1} style={styles.noteTitle}>
                {note.title.length === 0 ? "Untitled" : note.title}
              </Text>
              <Text numberOfLines={2} style={styles.noteDetail}>
                {noteTypeLabel(note.type)} ·{" "}
                {note.privacy === "private_manual" ? "Private" : "AI-assisted"}
              </Text>
              <Text style={styles.notePath}>
                {note.spaceId === null ? "Unfiled" : "Filed in a space"} · r{note.currentRevision}
              </Text>
            </View>
            <Text style={styles.updated}>{relativeUpdatedAt(note.updatedAt)}</Text>
          </Pressable>
          <Rule />
        </View>
      ))}
    </Screen>
  );
}

const styles = StyleSheet.create({
  accentRule: {
    backgroundColor: nativeTheme.color.accent,
    height: 4,
    marginBottom: 20,
    transform: [{ rotate: "-4deg" }],
    width: 34
  },
  addButton: {
    alignItems: "center",
    backgroundColor: nativeTheme.color.accent,
    borderRadius: 22,
    height: 44,
    justifyContent: "center",
    width: 44
  },
  noteBody: { flex: 1 },
  noteDetail: {
    color: nativeTheme.color.textSecondary,
    fontSize: 14,
    lineHeight: 20,
    marginTop: 3
  },
  notePath: {
    color: nativeTheme.color.textSecondary,
    fontFamily: nativeTheme.fontFamily.mono,
    fontSize: 10,
    marginTop: 8
  },
  noteRow: { alignItems: "flex-start", flexDirection: "row", minHeight: 105, paddingVertical: 18 },
  noteTitle: { color: nativeTheme.color.textPrimary, fontSize: 17, fontWeight: "600" },
  noteType: {
    alignItems: "center",
    backgroundColor: nativeTheme.color.surfaceRaised,
    borderRadius: 10,
    height: 44,
    justifyContent: "center",
    marginRight: 14,
    width: 44
  },
  noteTypeText: {
    color: nativeTheme.color.textPrimary,
    fontFamily: nativeTheme.fontFamily.mono,
    fontSize: 16,
    fontWeight: "700"
  },
  pressed: { opacity: 0.62 },
  retry: { color: nativeTheme.color.accent, fontSize: 14, fontWeight: "700", paddingVertical: 16 },
  state: { minHeight: 250, paddingTop: 62 },
  stateBody: {
    color: nativeTheme.color.textSecondary,
    fontSize: 15,
    lineHeight: 23,
    marginTop: 8,
    maxWidth: 310
  },
  stateTitle: { color: nativeTheme.color.textPrimary, fontSize: 20, fontWeight: "600" },
  updated: {
    color: nativeTheme.color.textSecondary,
    fontFamily: nativeTheme.fontFamily.mono,
    fontSize: 10,
    marginLeft: 8,
    marginTop: 3
  },
  utility: { alignItems: "center", flexDirection: "row", gap: 7, minHeight: 44 },
  utilityRow: { flexDirection: "row", flexWrap: "wrap", gap: 22 },
  utilityText: { color: nativeTheme.color.textSecondary, fontSize: 14, fontWeight: "600" }
});
