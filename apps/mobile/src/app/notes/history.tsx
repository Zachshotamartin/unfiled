import { createEntityId } from "@unfiled/contracts";
import { router, useLocalSearchParams } from "expo-router";
import { useState, type ReactElement } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";

import { Rule } from "../../components/Rule";
import { Screen } from "../../components/Screen";
import { MarkdownPreview } from "../../features/notes/MarkdownPreview";
import { MobileNotesError } from "../../features/notes/mobileNotesApi";
import { useMobileNotesApi, useNoteDetail } from "../../features/notes/useNotesApi";
import { nativeTheme } from "../../theme/nativeTheme";

export default function RevisionHistoryScreen(): ReactElement {
  const params = useLocalSearchParams<{ noteId?: string }>();
  const noteId = params.noteId ?? "";
  const resource = useNoteDetail(noteId);
  const api = useMobileNotesApi();
  const [busyRevision, setBusyRevision] = useState<number | null>(null);
  const [expandedRevision, setExpandedRevision] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const note = resource.value;

  const restore = async (revisionId: string, revisionNumber: number): Promise<void> => {
    if (api === null || note === null || busyRevision !== null) return;
    setBusyRevision(revisionNumber);
    setMessage(null);
    try {
      await api.restoreRevision(note.id, revisionId, note.currentRevision, createEntityId("key"));
      router.back();
    } catch (cause) {
      setMessage(
        cause instanceof MobileNotesError ? cause.message : "Couldn't restore this revision."
      );
    } finally {
      setBusyRevision(null);
    }
  };

  return (
    <Screen eyebrow={note?.title ?? "Note"} title="Revision history">
      {resource.loading ? <ActivityIndicator color={nativeTheme.color.accent} /> : null}
      <Text accessibilityLiveRegion="polite" style={styles.message}>
        {message ?? resource.error}
      </Text>
      {note?.revisions.map((revision) => (
        <View key={revision.revision}>
          <View style={styles.row}>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: expandedRevision === revision.revision }}
              onPress={() =>
                setExpandedRevision((current) =>
                  current === revision.revision ? null : revision.revision
                )
              }
              style={styles.body}
            >
              <Text style={styles.title}>Revision {revision.revision}</Text>
              <Text style={styles.detail}>
                {revision.source} · {new Date(revision.createdAt).toLocaleString()}
              </Text>
            </Pressable>
            {revision.revision === note.currentRevision ? (
              <Text style={styles.current}>Current</Text>
            ) : (
              <Pressable
                accessibilityRole="button"
                disabled={busyRevision !== null}
                onPress={() => void restore(revision.id, revision.revision)}
                style={styles.restore}
              >
                <Text style={styles.restoreText}>
                  {busyRevision === revision.revision ? "Restoring…" : "Restore"}
                </Text>
              </Pressable>
            )}
          </View>
          {expandedRevision === revision.revision ? (
            <View style={styles.snapshot}>
              <Text style={styles.snapshotTitle}>{revision.title}</Text>
              <Text style={styles.snapshotMeta}>
                {revision.type} ·{" "}
                {revision.privacy === "private_manual" ? "Private" : "AI-assisted"}
              </Text>
              <MarkdownPreview markdown={revision.bodyMarkdown} />
            </View>
          ) : null}
          <Rule />
        </View>
      ))}
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { flex: 1 },
  current: { color: nativeTheme.color.textSecondary, fontSize: 12, fontWeight: "700" },
  detail: { color: nativeTheme.color.textSecondary, fontSize: 13, marginTop: 5 },
  message: { color: nativeTheme.color.danger, fontSize: 13, minHeight: 28 },
  restore: { justifyContent: "center", minHeight: 44, paddingLeft: 16 },
  restoreText: { color: nativeTheme.color.accent, fontSize: 13, fontWeight: "700" },
  row: { alignItems: "center", flexDirection: "row", minHeight: 76, paddingVertical: 12 },
  snapshot: {
    backgroundColor: nativeTheme.color.surface,
    borderRadius: 14,
    marginBottom: 14,
    padding: 16
  },
  snapshotMeta: { color: nativeTheme.color.textSecondary, fontSize: 12, marginTop: 5 },
  snapshotTitle: { color: nativeTheme.color.textPrimary, fontSize: 18, fontWeight: "700" },
  title: { color: nativeTheme.color.textPrimary, fontSize: 16, fontWeight: "600" }
});
