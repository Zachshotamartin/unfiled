import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState, type ReactElement } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";

import { useSession } from "../../auth/AuthProvider";
import { BrandMark } from "../../components/BrandMark";
import { Rule } from "../../components/Rule";
import { Screen } from "../../components/Screen";
import {
  type CaptureActivityState,
  useCaptureActivity
} from "../../features/capture/useCaptureActivity";
import { noteTypeLabel, relativeUpdatedAt } from "../../features/notes/mobileNotesApi";
import { useNoteList } from "../../features/notes/useNotesApi";
import { nativeTheme } from "../../theme/nativeTheme";

const todayLabel = new Intl.DateTimeFormat("en", {
  day: "numeric",
  month: "long",
  weekday: "long"
}).format(new Date());

function captureStateLabel(state: CaptureActivityState): string {
  const labels: Record<CaptureActivityState, string> = {
    done: "Done",
    failed: "Failed",
    inbox: "Inbox",
    needs_review: "Needs review",
    permanent_failure: "Needs retry",
    processing: "Processing",
    queued: "Queued",
    retry_wait: "Waiting to retry",
    syncing: "Syncing",
    waiting_for_sign_in: "Waiting for sign-in"
  };
  return labels[state];
}

export default function TodayScreen(): ReactElement {
  const notes = useNoteList();
  const captures = useCaptureActivity();
  const parameters = useLocalSearchParams<{ captureId?: string; captureSaved?: string }>();
  const { signOut } = useSession();
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const recent = notes.value.slice(0, 5);
  const recentCaptures = captures.items.slice(0, 4);
  const providerUnavailable = captures.items.some(
    ({ lastErrorCode }) => lastErrorCode === "provider_unavailable"
  );

  useEffect(() => {
    if (parameters.captureId === undefined || parameters.captureSaved === undefined) return;
    setSavedMessage(
      parameters.captureSaved === "waiting"
        ? "Saved encrypted on this device. Waiting for sign-in."
        : "Saved encrypted on this device."
    );
    const timer = setTimeout(() => setSavedMessage(null), 4_000);
    return () => clearTimeout(timer);
  }, [parameters.captureId, parameters.captureSaved]);

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

      {savedMessage === null ? null : (
        <View accessibilityLiveRegion="polite" style={styles.savedNotice}>
          <Ionicons color={nativeTheme.color.accent} name="shield-checkmark-outline" size={18} />
          <Text style={styles.savedNoticeText}>{savedMessage}</Text>
        </View>
      )}

      {providerUnavailable ? (
        <View accessibilityLiveRegion="polite" style={styles.outageNotice}>
          <Ionicons color={nativeTheme.color.warning} name="cloud-offline-outline" size={18} />
          <Text style={styles.outageNoticeText}>
            The organizer is temporarily unavailable. Your encrypted captures are safe, and any item
            needing you will show Retry.
          </Text>
        </View>
      ) : null}

      {recentCaptures.length > 0 ? (
        <View style={styles.captureActivity}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Capture activity</Text>
            <Text style={styles.sectionCount}>{recentCaptures.length} RECENT</Text>
          </View>
          <Rule />
          {captures.error === null ? null : (
            <Text style={styles.captureError}>{captures.error}</Text>
          )}
          {recentCaptures.map((capture) => {
            const retryable = capture.state === "failed" || capture.state === "permanent_failure";
            return (
              <View key={capture.id}>
                <View style={styles.captureRow}>
                  <Pressable
                    accessibilityHint={
                      capture.receiptAvailable ? "Opens the capture receipt" : undefined
                    }
                    accessibilityRole={capture.receiptAvailable ? "button" : undefined}
                    disabled={!capture.receiptAvailable}
                    onPress={() =>
                      router.push({
                        pathname: "/captures/[captureId]",
                        params: { captureId: capture.id }
                      })
                    }
                    style={({ pressed }) => [
                      styles.captureMain,
                      pressed && capture.receiptAvailable && styles.rowPressed
                    ]}
                  >
                    <View style={styles.captureCopy}>
                      <Text numberOfLines={2} style={styles.capturePreview}>
                        {capture.rawContentPreview}
                      </Text>
                      <Text style={styles.captureMeta}>
                        {capture.privacy === "private_manual" ? "Private" : "Organize"}
                      </Text>
                    </View>
                  </Pressable>
                  <View style={styles.captureStatusBlock}>
                    <Text
                      style={[
                        styles.captureStatus,
                        retryable && styles.captureStatusFailed,
                        capture.state === "done" && styles.captureStatusDone
                      ]}
                    >
                      {captureStateLabel(capture.state)}
                    </Text>
                    {retryable ? (
                      <Pressable
                        accessibilityLabel="Retry capture"
                        accessibilityRole="button"
                        onPress={() => void captures.retry(capture.id)}
                        style={({ pressed }) => [styles.retryButton, pressed && styles.rowPressed]}
                      >
                        <Ionicons color={nativeTheme.color.textPrimary} name="refresh" size={15} />
                        <Text style={styles.retryText}>Retry</Text>
                      </Pressable>
                    ) : capture.receiptAvailable ? (
                      <Ionicons
                        color={nativeTheme.color.textSecondary}
                        name="chevron-forward"
                        size={17}
                      />
                    ) : null}
                  </View>
                </View>
                <Rule />
              </View>
            );
          })}
        </View>
      ) : null}

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
  captureActivity: { marginBottom: 38 },
  captureCopy: { flex: 1, paddingRight: 14 },
  captureError: {
    color: nativeTheme.color.warning,
    fontSize: 12,
    lineHeight: 18,
    paddingTop: 12
  },
  captureMain: { flex: 1, justifyContent: "center", minHeight: 48 },
  captureMeta: {
    color: nativeTheme.color.textSecondary,
    fontFamily: nativeTheme.fontFamily.mono,
    fontSize: 10,
    marginTop: 6,
    textTransform: "uppercase"
  },
  capturePreview: {
    color: nativeTheme.color.textPrimary,
    fontSize: 14,
    lineHeight: 20
  },
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
  captureRow: {
    alignItems: "center",
    flexDirection: "row",
    minHeight: 76,
    paddingVertical: 14
  },
  captureStatus: {
    color: nativeTheme.color.warning,
    fontFamily: nativeTheme.fontFamily.mono,
    fontSize: 10,
    fontWeight: "700",
    textAlign: "right",
    textTransform: "uppercase"
  },
  captureStatusBlock: { alignItems: "flex-end", gap: 9 },
  captureStatusDone: { color: nativeTheme.color.accent },
  captureStatusFailed: { color: nativeTheme.color.danger },
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
  outageNotice: {
    alignItems: "flex-start",
    backgroundColor: nativeTheme.color.surface,
    borderColor: nativeTheme.color.warning,
    borderRadius: nativeTheme.radius.input,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 9,
    marginBottom: 28,
    paddingHorizontal: 14,
    paddingVertical: 12
  },
  outageNoticeText: {
    color: nativeTheme.color.textPrimary,
    flex: 1,
    fontSize: 13,
    lineHeight: 19
  },
  revision: {
    color: nativeTheme.color.accent,
    fontFamily: nativeTheme.fontFamily.mono,
    fontSize: 10,
    fontWeight: "700"
  },
  rowPressed: { opacity: 0.62 },
  retryButton: { alignItems: "center", flexDirection: "row", gap: 5, minHeight: 44 },
  retryText: { color: nativeTheme.color.textPrimary, fontSize: 12, fontWeight: "700" },
  savedNotice: {
    alignItems: "center",
    backgroundColor: nativeTheme.color.surface,
    borderColor: nativeTheme.color.border,
    borderRadius: nativeTheme.radius.input,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 9,
    marginBottom: 28,
    marginTop: -20,
    paddingHorizontal: 14,
    paddingVertical: 12
  },
  savedNoticeText: { color: nativeTheme.color.textPrimary, flex: 1, fontSize: 13 },
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
