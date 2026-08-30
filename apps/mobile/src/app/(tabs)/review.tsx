import { router } from "expo-router";
import type { ReviewType } from "@unfiled/contracts";
import type { ReactElement } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";

import { Rule } from "../../components/Rule";
import { Screen } from "../../components/Screen";
import { useReviewItems } from "../../features/notes/useNotesApi";
import { nativeTheme } from "../../theme/nativeTheme";

const reviewLabels: Record<ReviewType, { title: string; detail: string }> = {
  duplicate_suggestion: {
    title: "Possible duplicate",
    detail: "Unfiled found notes that may cover the same idea. Nothing was merged."
  },
  failed_job: {
    title: "Organization needs another try",
    detail: "The original capture is safe while this waits."
  },
  low_confidence: {
    title: "Choose a destination",
    detail: "These suggestions were too close to decide automatically."
  },
  pending_expansion: {
    title: "Expansion waiting",
    detail: "Generated words stay separate until you accept them."
  },
  revision_conflict: {
    title: "A manual edit won",
    detail: "Unfiled stopped after a second revision conflict instead of overwriting your note."
  },
  structure_conflict: {
    title: "Structured note needs review",
    detail: "The edit was ambiguous, so the note was left unchanged."
  }
};

export default function ReviewScreen(): ReactElement {
  const items = useReviewItems();
  return (
    <Screen eyebrow={`${items.value.length} waiting`} title="Review">
      {items.loading ? (
        <ActivityIndicator accessibilityLabel="Loading Review" color={nativeTheme.color.accent} />
      ) : null}
      <Text accessibilityLiveRegion="polite" style={styles.error}>
        {items.error}
      </Text>
      {!items.loading && items.value.length === 0 ? (
        <View style={styles.empty}>
          <View style={styles.slip} />
          <Text style={styles.title}>You’re all caught up.</Text>
          <Text style={styles.body}>
            If Unfiled is unsure later, the original capture stays safe in Inbox while its decision
            waits here.
          </Text>
        </View>
      ) : null}
      {items.value.map((item) => {
        const copy = reviewLabels[item.type];
        return (
          <View key={item.id}>
            <Pressable
              accessibilityRole={item.noteId === null ? "summary" : "button"}
              disabled={item.noteId === null}
              onPress={() =>
                item.noteId === null
                  ? undefined
                  : router.push({ pathname: "/notes/[noteId]", params: { noteId: item.noteId } })
              }
              style={styles.row}
            >
              <View style={styles.rowAccent} />
              <View style={styles.rowBody}>
                <Text style={styles.rowTitle}>{copy.title}</Text>
                <Text style={styles.rowDetail}>{copy.detail}</Text>
                <Text style={styles.rowDate}>{new Date(item.createdAt).toLocaleString()}</Text>
              </View>
              {item.noteId === null ? null : <Text style={styles.open}>Open note</Text>}
            </Pressable>
            <Rule />
          </View>
        );
      })}
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: {
    color: nativeTheme.color.textSecondary,
    fontSize: 15,
    lineHeight: 24,
    marginTop: 9,
    maxWidth: 320
  },
  empty: { paddingTop: 72 },
  error: { color: nativeTheme.color.danger, fontSize: 13, minHeight: 24 },
  open: { color: nativeTheme.color.accent, fontSize: 12, fontWeight: "700", marginLeft: 10 },
  row: { alignItems: "center", flexDirection: "row", minHeight: 112, paddingVertical: 16 },
  rowAccent: {
    backgroundColor: nativeTheme.color.accent,
    height: 28,
    marginRight: 14,
    transform: [{ rotate: "13deg" }],
    width: 8
  },
  rowBody: { flex: 1 },
  rowDate: {
    color: nativeTheme.color.textSecondary,
    fontFamily: nativeTheme.fontFamily.mono,
    fontSize: 10,
    marginTop: 8
  },
  rowDetail: { color: nativeTheme.color.textSecondary, fontSize: 13, lineHeight: 19, marginTop: 5 },
  rowTitle: { color: nativeTheme.color.textPrimary, fontSize: 16, fontWeight: "700" },
  slip: {
    backgroundColor: nativeTheme.color.accent,
    height: 28,
    marginBottom: 24,
    transform: [{ rotate: "13deg" }],
    width: 9
  },
  title: { color: nativeTheme.color.textPrimary, fontSize: 22, fontWeight: "600" }
});
