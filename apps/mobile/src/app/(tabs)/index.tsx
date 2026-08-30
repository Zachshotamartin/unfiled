import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import type { ReactElement } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";

import { useSession } from "../../auth/AuthProvider";
import { BrandMark } from "../../components/BrandMark";
import { Rule } from "../../components/Rule";
import { Screen } from "../../components/Screen";
import { noteTypeLabel, relativeUpdatedAt } from "../../features/notes/mobileNotesApi";
import { useNoteList } from "../../features/notes/useNotesApi";
import { nativeTheme } from "../../theme/nativeTheme";

const todayLabel = new Intl.DateTimeFormat("en", {
  day: "numeric",
  month: "long",
  weekday: "long"
}).format(new Date());

export default function TodayScreen(): ReactElement {
  const notes = useNoteList();
  const { signOut } = useSession();
  const recent = notes.value.slice(0, 5);
  return (
    <Screen
      eyebrow={todayLabel}
      rightAccessory={
        <View style={styles.headerActions}>
          <BrandMark size={27} />
          <Pressable
            accessibilityLabel="Sign out"
            accessibilityRole="button"
            onPress={() => {
              void signOut().catch(() => {
                Alert.alert(
                  "Signed out on this device",
                  "Unfiled could not revoke other server sessions. Sign in and try again when you are online."
                );
              });
            }}
            style={styles.signOut}
          >
            <Ionicons color={nativeTheme.color.textSecondary} name="log-out-outline" size={21} />
          </Pressable>
        </View>
      }
      title="Today"
    >
      <Pressable
        accessibilityHint="Opens a blank capture"
        accessibilityRole="button"
        onPress={() => router.push("/capture?source=mobile")}
        style={({ pressed }) => [styles.capturePrompt, pressed && styles.capturePromptPressed]}
      >
        <Text style={styles.captureText}>Write something</Text>
        <Ionicons color={nativeTheme.color.accentContrast} name="arrow-forward" size={21} />
      </Pressable>

      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>Recent notes</Text>
        <Text style={styles.sectionCount}>{recent.length} UPDATED</Text>
      </View>
      <Rule />
      {notes.error === null ? null : <Text style={styles.message}>{notes.error}</Text>}
      {!notes.loading && recent.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>A quiet start.</Text>
          <Text style={styles.emptyBody}>
            Capture a thought or make a note. Both begin right here.
          </Text>
        </View>
      ) : null}
      {recent.map((note) => (
        <View key={note.id}>
          <Pressable
            accessibilityRole="button"
            onPress={() =>
              router.push({ pathname: "/notes/[noteId]", params: { noteId: note.id } })
            }
            style={({ pressed }) => [styles.noteRow, pressed && styles.rowPressed]}
          >
            <View style={styles.slip} />
            <View style={styles.noteBody}>
              <Text style={styles.noteTitle}>{note.title}</Text>
              <Text style={styles.noteDetail}>
                {noteTypeLabel(note.type)} · {note.spaceId === null ? "Unfiled" : "Filed"}
              </Text>
            </View>
            <View style={styles.noteMeta}>
              <Text style={styles.revision}>R{note.currentRevision}</Text>
              <Text style={styles.time}>{relativeUpdatedAt(note.updatedAt)}</Text>
            </View>
          </Pressable>
          <Rule />
        </View>
      ))}
    </Screen>
  );
}

const styles = StyleSheet.create({
  capturePrompt: {
    alignItems: "center",
    backgroundColor: nativeTheme.color.accent,
    borderRadius: nativeTheme.radius.container,
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 40,
    minHeight: 64,
    paddingHorizontal: 20
  },
  capturePromptPressed: { opacity: 0.78, transform: [{ scale: 0.99 }] },
  captureText: { color: nativeTheme.color.accentContrast, fontSize: 17, fontWeight: "600" },
  empty: { paddingTop: 54 },
  emptyBody: {
    color: nativeTheme.color.textSecondary,
    fontSize: 15,
    lineHeight: 23,
    marginTop: 8,
    maxWidth: 290
  },
  emptyTitle: { color: nativeTheme.color.textPrimary, fontSize: 20, fontWeight: "600" },
  headerActions: { alignItems: "center", flexDirection: "row", gap: 10 },
  message: { color: nativeTheme.color.danger, fontSize: 13, paddingTop: 16 },
  noteBody: { flex: 1, paddingRight: 12 },
  noteDetail: {
    color: nativeTheme.color.textSecondary,
    fontSize: 14,
    lineHeight: 20,
    marginTop: 3
  },
  noteMeta: { alignItems: "flex-end", gap: 5 },
  noteRow: { alignItems: "flex-start", flexDirection: "row", minHeight: 88, paddingVertical: 18 },
  noteTitle: {
    color: nativeTheme.color.textPrimary,
    fontSize: 16,
    fontWeight: "600",
    lineHeight: 22
  },
  revision: {
    color: nativeTheme.color.accent,
    fontFamily: nativeTheme.fontFamily.mono,
    fontSize: 10,
    fontWeight: "700"
  },
  rowPressed: { opacity: 0.62 },
  sectionCount: {
    color: nativeTheme.color.textSecondary,
    fontFamily: nativeTheme.fontFamily.mono,
    fontSize: 10,
    letterSpacing: 0.6
  },
  sectionHeader: {
    alignItems: "baseline",
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 13
  },
  sectionTitle: { color: nativeTheme.color.textPrimary, fontSize: 17, fontWeight: "600" },
  signOut: { alignItems: "center", height: 44, justifyContent: "center", width: 40 },
  slip: {
    backgroundColor: nativeTheme.color.accent,
    height: 21,
    marginRight: 13,
    marginTop: 2,
    transform: [{ rotate: "13deg" }],
    width: 8
  },
  time: {
    color: nativeTheme.color.textSecondary,
    fontFamily: nativeTheme.fontFamily.mono,
    fontSize: 11
  }
});
