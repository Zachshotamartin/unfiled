import { Ionicons } from "@expo/vector-icons";
import type { ReactElement } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { Rule } from "../../components/Rule";
import { Screen } from "../../components/Screen";
import { nativeTheme } from "../../theme/nativeTheme";

const notes = [
  {
    detail: "5 open items",
    icon: "cart-outline",
    path: "Personal / Lists",
    title: "Shopping",
    updated: "10:42"
  },
  {
    detail: "Bench, incline dumbbell",
    icon: "barbell-outline",
    path: "Health / Logs",
    title: "Push Workout",
    updated: "08:16"
  },
  {
    detail: "12 principles",
    icon: "compass-outline",
    path: "Personal / Mindset",
    title: "Principles",
    updated: "Yesterday"
  },
  {
    detail: "4 active projects",
    icon: "hammer-outline",
    path: "Work / Projects",
    title: "Projects",
    updated: "Friday"
  }
] as const;

export default function NotesScreen(): ReactElement {
  return (
    <Screen eyebrow="Manual navigation" title="Notes">
      <View style={styles.searchField}>
        <Ionicons color={nativeTheme.color.textSecondary} name="search" size={19} />
        <TextInput
          accessibilityLabel="Search notes"
          keyboardAppearance="dark"
          placeholder="Find a note"
          placeholderTextColor={nativeTheme.color.textDisabled}
          selectionColor={nativeTheme.color.accent}
          style={styles.searchInput}
        />
      </View>

      <View accessibilityRole="tablist" style={styles.tabs}>
        <Pressable
          accessibilityRole="tab"
          accessibilityState={{ selected: true }}
          style={styles.activeTab}
        >
          <Text style={styles.activeTabText}>All</Text>
        </Pressable>
        <Pressable
          accessibilityRole="tab"
          accessibilityState={{ selected: false }}
          style={styles.tab}
        >
          <Text style={styles.tabText}>Spaces</Text>
        </Pressable>
      </View>
      <Rule />

      {notes.map((note) => (
        <View key={note.title}>
          <Pressable
            accessibilityRole="button"
            style={({ pressed }) => [styles.noteRow, pressed && styles.pressed]}
          >
            <View style={styles.noteIcon}>
              <Ionicons color={nativeTheme.color.textPrimary} name={note.icon} size={20} />
            </View>
            <View style={styles.noteBody}>
              <Text style={styles.noteTitle}>{note.title}</Text>
              <Text style={styles.noteDetail}>{note.detail}</Text>
              <Text style={styles.notePath}>{note.path}</Text>
            </View>
            <Text style={styles.updated}>{note.updated}</Text>
          </Pressable>
          <Rule />
        </View>
      ))}
    </Screen>
  );
}

const styles = StyleSheet.create({
  activeTab: {
    borderBottomColor: nativeTheme.color.accent,
    borderBottomWidth: 2,
    paddingBottom: 10,
    paddingHorizontal: 4
  },
  activeTabText: { color: nativeTheme.color.textPrimary, fontSize: 14, fontWeight: "600" },
  noteBody: { flex: 1 },
  noteDetail: {
    color: nativeTheme.color.textSecondary,
    fontSize: 14,
    lineHeight: 20,
    marginTop: 2
  },
  noteIcon: {
    alignItems: "center",
    backgroundColor: nativeTheme.color.surfaceRaised,
    borderRadius: 10,
    height: 44,
    justifyContent: "center",
    marginRight: 14,
    width: 44
  },
  notePath: {
    color: nativeTheme.color.textSecondary,
    fontFamily: nativeTheme.fontFamily.mono,
    fontSize: 10,
    marginTop: 7
  },
  noteRow: { alignItems: "flex-start", flexDirection: "row", minHeight: 102, paddingVertical: 18 },
  noteTitle: { color: nativeTheme.color.textPrimary, fontSize: 17, fontWeight: "600" },
  pressed: { opacity: 0.62 },
  searchField: {
    alignItems: "center",
    backgroundColor: nativeTheme.color.surface,
    borderColor: nativeTheme.color.border,
    borderRadius: nativeTheme.radius.input,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 10,
    marginBottom: 24,
    minHeight: 48,
    paddingHorizontal: 14
  },
  searchInput: { color: nativeTheme.color.textPrimary, flex: 1, fontSize: 16, paddingVertical: 0 },
  tab: { paddingBottom: 10, paddingHorizontal: 4 },
  tabText: { color: nativeTheme.color.textSecondary, fontSize: 14, fontWeight: "600" },
  tabs: { flexDirection: "row", gap: 28 },
  updated: {
    color: nativeTheme.color.textSecondary,
    fontFamily: nativeTheme.fontFamily.mono,
    fontSize: 10,
    marginLeft: 8,
    marginTop: 3
  }
});
