import { Ionicons } from "@expo/vector-icons";
import type { ReactElement } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";

import { Screen } from "../../components/Screen";
import { nativeTheme } from "../../theme/nativeTheme";

export default function SearchScreen(): ReactElement {
  return (
    <Screen eyebrow="Everything you've kept" title="Search">
      <View style={styles.searchField}>
        <Ionicons color={nativeTheme.color.textSecondary} name="search" size={21} />
        <TextInput
          accessibilityLabel="Search all notes and captures"
          autoFocus
          keyboardAppearance="dark"
          placeholder="Search notes and captures"
          placeholderTextColor={nativeTheme.color.textDisabled}
          selectionColor={nativeTheme.color.accent}
          style={styles.input}
        />
      </View>
      <View style={styles.emptyState}>
        <View style={styles.line} />
        <Text style={styles.emptyTitle}>Start with any word you remember.</Text>
        <Text style={styles.emptyBody}>
          Search checks original captures, note titles, and the content they became.
        </Text>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  emptyBody: {
    color: nativeTheme.color.textSecondary,
    fontSize: 15,
    lineHeight: 23,
    marginTop: 8,
    maxWidth: 290
  },
  emptyState: { paddingTop: 76 },
  emptyTitle: {
    color: nativeTheme.color.textPrimary,
    fontSize: 20,
    fontWeight: "600",
    lineHeight: 27,
    maxWidth: 280
  },
  input: { color: nativeTheme.color.textPrimary, flex: 1, fontSize: 17, paddingVertical: 0 },
  line: {
    backgroundColor: nativeTheme.color.accent,
    height: 4,
    marginBottom: 22,
    transform: [{ rotate: "-4deg" }],
    width: 36
  },
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
  }
});
