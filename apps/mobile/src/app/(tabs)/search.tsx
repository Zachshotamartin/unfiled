import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useEffect, useState, type ReactElement } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { Rule } from "../../components/Rule";
import { Screen } from "../../components/Screen";
import { noteTypeLabel } from "../../features/notes/mobileNotesApi";
import { useSearchResults } from "../../features/notes/useNotesApi";
import { nativeTheme } from "../../theme/nativeTheme";

export default function SearchScreen(): ReactElement {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [includeArchived, setIncludeArchived] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), 250);
    return () => clearTimeout(timer);
  }, [query]);
  const results = useSearchResults(debouncedQuery, includeArchived);

  return (
    <Screen eyebrow="Everything you've kept" title="Search">
      <View style={styles.searchField}>
        <Ionicons color={nativeTheme.color.textSecondary} name="search" size={21} />
        <TextInput
          accessibilityLabel="Search all notes"
          autoFocus
          keyboardAppearance="dark"
          onChangeText={setQuery}
          placeholder="Search notes"
          placeholderTextColor={nativeTheme.color.textDisabled}
          selectionColor={nativeTheme.color.accent}
          style={styles.input}
          value={query}
        />
        {query.length > 0 ? (
          <Pressable accessibilityLabel="Clear search" onPress={() => setQuery("")}>
            <Ionicons color={nativeTheme.color.textSecondary} name="close-circle" size={20} />
          </Pressable>
        ) : null}
      </View>
      <Pressable
        accessibilityRole="switch"
        accessibilityState={{ checked: includeArchived }}
        onPress={() => setIncludeArchived((value) => !value)}
        style={styles.archiveToggle}
      >
        <Text style={styles.archiveLabel}>Include archived notes</Text>
        <Ionicons
          color={includeArchived ? nativeTheme.color.accent : nativeTheme.color.textSecondary}
          name={includeArchived ? "toggle" : "toggle-outline"}
          size={30}
        />
      </Pressable>
      <Rule />

      {results.loading && debouncedQuery.trim().length > 0 ? (
        <ActivityIndicator color={nativeTheme.color.accent} style={styles.spinner} />
      ) : null}
      <Text accessibilityLiveRegion="polite" style={styles.error}>
        {results.error}
      </Text>
      {query.trim().length === 0 ? (
        <View style={styles.emptyState}>
          <View style={styles.line} />
          <Text style={styles.emptyTitle}>Start with any word you remember.</Text>
          <Text style={styles.emptyBody}>
            Search checks note titles and Markdown without sending private content to a model.
          </Text>
        </View>
      ) : null}
      {!results.loading && debouncedQuery.trim().length > 0 && results.value.length === 0 ? (
        <View style={styles.emptyState}>
          <Text style={styles.emptyTitle}>No matching notes.</Text>
          <Text style={styles.emptyBody}>Try a shorter phrase or include the archive.</Text>
        </View>
      ) : null}
      {results.value.map((note) => (
        <View key={note.noteId}>
          <Pressable
            accessibilityRole="button"
            onPress={() =>
              router.push({ pathname: "/notes/[noteId]", params: { noteId: note.noteId } })
            }
            style={styles.result}
          >
            <View style={styles.resultBody}>
              <Text style={styles.resultTitle}>{note.title}</Text>
              <Text numberOfLines={2} style={styles.resultSnippet}>
                {note.snippet}
              </Text>
              <Text style={styles.resultPath}>
                {note.spacePath.length === 0 ? "Unfiled" : note.spacePath.join(" / ")} ·{" "}
                {noteTypeLabel(note.type)} · {new Date(note.updatedAt).toLocaleDateString()}
              </Text>
            </View>
            <Ionicons color={nativeTheme.color.textSecondary} name="chevron-forward" size={17} />
          </Pressable>
          <Rule />
        </View>
      ))}
    </Screen>
  );
}

const styles = StyleSheet.create({
  archiveLabel: { color: nativeTheme.color.textSecondary, fontSize: 13 },
  archiveToggle: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    minHeight: 52
  },
  emptyBody: {
    color: nativeTheme.color.textSecondary,
    fontSize: 15,
    lineHeight: 23,
    marginTop: 8,
    maxWidth: 310
  },
  emptyState: { paddingTop: 66 },
  emptyTitle: {
    color: nativeTheme.color.textPrimary,
    fontSize: 20,
    fontWeight: "600",
    lineHeight: 27,
    maxWidth: 280
  },
  error: { color: nativeTheme.color.danger, fontSize: 13, minHeight: 20 },
  input: { color: nativeTheme.color.textPrimary, flex: 1, fontSize: 17, paddingVertical: 0 },
  line: {
    backgroundColor: nativeTheme.color.accent,
    height: 4,
    marginBottom: 22,
    transform: [{ rotate: "-4deg" }],
    width: 36
  },
  result: { alignItems: "center", flexDirection: "row", minHeight: 96, paddingVertical: 16 },
  resultBody: { flex: 1, paddingRight: 12 },
  resultPath: {
    color: nativeTheme.color.textSecondary,
    fontFamily: nativeTheme.fontFamily.mono,
    fontSize: 10,
    marginTop: 7
  },
  resultSnippet: {
    color: nativeTheme.color.textSecondary,
    fontSize: 14,
    lineHeight: 20,
    marginTop: 4
  },
  resultTitle: { color: nativeTheme.color.textPrimary, fontSize: 16, fontWeight: "600" },
  searchField: {
    alignItems: "center",
    backgroundColor: nativeTheme.color.surface,
    borderColor: nativeTheme.color.border,
    borderRadius: nativeTheme.radius.input,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 11,
    minHeight: 52,
    paddingHorizontal: 15
  },
  spinner: { marginTop: 36 }
});
