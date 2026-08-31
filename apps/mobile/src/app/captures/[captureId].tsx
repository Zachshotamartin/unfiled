import { Ionicons } from "@expo/vector-icons";
import { createApiClient } from "@unfiled/api-client";
import type { CaptureDetail, CaptureReceiptAction } from "@unfiled/contracts";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  Pressable,
  StyleSheet,
  Text,
  View
} from "react-native";

import { useSession } from "../../auth/AuthProvider";
import { Rule } from "../../components/Rule";
import { Screen } from "../../components/Screen";
import { executeCaptureDeleteIntent } from "../../features/capture/captureActionCoordinator";
import { captureUndoSignature } from "../../features/capture/captureActionIntents";
import {
  beginCaptureDeleteIntent,
  captureActionIntentSucceeded,
  getOrCreateCaptureRetryIntent,
  getOrCreateCaptureUndoIntent,
  markCaptureActionIntentSucceeded,
  removeCaptureActionIntent
} from "../../features/capture/captureDraftRepository";
import { sqliteCaptureDeleteIntentStore } from "../../features/capture/sqliteCaptureOutboxStore";
import { nativeTheme } from "../../theme/nativeTheme";

const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL ?? "http://localhost:3000";
const REFRESH_INTERVAL_MS = 4_000;

function readableReason(reason: string): string {
  return reason.replaceAll("_", " ");
}

function stateLabel(state: CaptureDetail["status"]): string {
  const labels: Record<CaptureDetail["status"], string> = {
    done: "Done",
    failed: "Failed",
    inbox: "Inbox",
    needs_review: "Needs review",
    processing: "Processing",
    queued: "Queued"
  };
  return labels[state];
}

export default function CaptureDetailScreen(): ReactElement {
  const parameters = useLocalSearchParams<{ captureId?: string | string[] }>();
  const captureId = Array.isArray(parameters.captureId) ? undefined : parameters.captureId;
  const { getAccessToken, session } = useSession();
  const profileId = session?.user.id ?? null;
  const api = useMemo(
    () => createApiClient({ baseUrl: API_BASE_URL, getAccessToken }),
    [getAccessToken]
  );
  const [capture, setCapture] = useState<CaptureDetail | null>(null);
  const [consumedUndoMutations, setConsumedUndoMutations] = useState<ReadonlySet<string>>(
    new Set()
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    if (captureId === undefined) {
      setError("This capture link is invalid.");
      return;
    }
    try {
      const detail = (await api.getCapture(captureId)).capture;
      setCapture(detail);
      const undoActions =
        detail.receipt?.actions.filter(
          (action): action is Extract<CaptureReceiptAction, { type: "undo" }> =>
            action.type === "undo"
        ) ?? [];
      if (profileId !== null && undoActions.length > 0) {
        const consumed = await Promise.all(
          undoActions.map(async (action) => ({
            consumed: await captureActionIntentSucceeded(
              profileId,
              captureUndoSignature(action.mutationId, action.expectedRevision)
            ),
            mutationId: action.mutationId
          }))
        );
        setConsumedUndoMutations(
          new Set(
            consumed.filter(({ consumed: value }) => value).map(({ mutationId }) => mutationId)
          )
        );
      } else {
        setConsumedUndoMutations(new Set());
      }
      setError(null);
    } catch {
      setError("Couldn't refresh this receipt. Try again when you are online.");
    }
  }, [api, captureId, profileId]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void refresh();
    });
    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, [refresh]);

  const retry = useCallback(async (): Promise<void> => {
    if (captureId === undefined || capture === null || profileId === null || busy) return;
    setBusy(true);
    try {
      const intent = await getOrCreateCaptureRetryIntent(
        profileId,
        captureId as `cap_${string}`,
        capture.receipt?.createdAt ?? capture.receivedAt
      );
      await api.retryCapture(captureId, intent.request);
      await removeCaptureActionIntent(profileId, intent.actionSignature);
      await refresh();
    } catch {
      setError("Couldn't retry this capture yet.");
    } finally {
      setBusy(false);
    }
  }, [api, busy, capture, captureId, profileId, refresh]);

  const undo = useCallback(
    async (action: Extract<CaptureReceiptAction, { type: "undo" }>): Promise<void> => {
      if (busy || profileId === null || consumedUndoMutations.has(action.mutationId)) return;
      setBusy(true);
      try {
        const intent = await getOrCreateCaptureUndoIntent(
          profileId,
          action.mutationId,
          action.expectedRevision
        );
        await api.undoMutation(action.mutationId, intent.request);
        await markCaptureActionIntentSucceeded(profileId, intent.actionSignature);
        setConsumedUndoMutations((current) => new Set([...current, action.mutationId]));
        setError("The inserted content was undone.");
      } catch {
        setError("This change could not be undone. Open the note to review its latest version.");
      } finally {
        setBusy(false);
      }
    },
    [api, busy, consumedUndoMutations, profileId]
  );

  const remove = useCallback(
    (removeInsertedContent: boolean): void => {
      if (captureId === undefined || capture === null || busy) return;
      const undoAction = capture.receipt?.actions.find(
        (action): action is Extract<CaptureReceiptAction, { type: "undo" }> =>
          action.type === "undo"
      );
      const destination = capture.receipt?.destination;
      if (
        removeInsertedContent &&
        (undoAction === undefined || destination === null || destination === undefined)
      ) {
        setError("Inserted content cannot be removed safely from this receipt.");
        return;
      }
      if (profileId === null) return;
      setBusy(true);
      void (async () => {
        const intent = await beginCaptureDeleteIntent(profileId, captureId as `cap_${string}`, {
          expectedNoteRevisions:
            removeInsertedContent &&
            undoAction !== undefined &&
            destination !== null &&
            destination !== undefined
              ? [{ expectedRevision: undoAction.expectedRevision, noteId: destination.noteId }]
              : [],
          removeInsertedContent
        });
        const result = await executeCaptureDeleteIntent({
          intent,
          send: (id, request) => api.deleteCapture(id, request),
          store: sqliteCaptureDeleteIntentStore
        });
        if (result === "completed") {
          router.back();
        } else if (result === "cancelled") {
          setError("This capture changed before it could be removed. Refresh and review it first.");
        } else if (result === "waiting_for_sign_in") {
          setError("Sign in again to finish removing this capture.");
        } else {
          setError("Couldn't remove this capture safely. It will retry when you are online.");
        }
      })()
        .catch(() => setError("Couldn't remove this capture safely."))
        .finally(() => setBusy(false));
    },
    [api, busy, capture, captureId, profileId]
  );

  const confirmRemove = useCallback((): void => {
    const canRemoveContent = capture?.receipt?.actions.some(({ type }) => type === "undo") ?? false;
    Alert.alert(
      "Remove capture?",
      "The routed note keeps a source-removed marker so its history stays trustworthy.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Remove capture", style: "destructive", onPress: () => remove(false) },
        ...(canRemoveContent
          ? [
              {
                text: "Remove capture and inserted content",
                style: "destructive" as const,
                onPress: () => remove(true)
              }
            ]
          : [])
      ]
    );
  }, [capture, remove]);

  if (capture === null) {
    return (
      <Screen
        rightAccessory={
          <Pressable
            accessibilityLabel="Go back"
            accessibilityRole="button"
            onPress={() => router.back()}
            style={styles.iconButton}
          >
            <Ionicons color={nativeTheme.color.textPrimary} name="close" size={24} />
          </Pressable>
        }
        title="Capture"
      >
        {error === null ? (
          <ActivityIndicator color={nativeTheme.color.accent} />
        ) : (
          <Text style={styles.error}>{error}</Text>
        )}
      </Screen>
    );
  }

  const receipt = capture.receipt;
  return (
    <Screen
      eyebrow={stateLabel(capture.status)}
      rightAccessory={
        <Pressable
          accessibilityLabel="Go back"
          accessibilityRole="button"
          onPress={() => router.back()}
          style={styles.iconButton}
        >
          <Ionicons color={nativeTheme.color.textPrimary} name="close" size={24} />
        </Pressable>
      }
      title={receipt?.headline ?? "Processing capture"}
    >
      <View style={styles.original}>
        <Text style={styles.label}>Original</Text>
        <Text selectable style={styles.originalText}>
          {capture.rawContent}
        </Text>
      </View>

      {error === null ? null : (
        <Text accessibilityLiveRegion="polite" style={styles.error}>
          {error}
        </Text>
      )}

      {receipt === null ? (
        <View style={styles.processing}>
          <ActivityIndicator color={nativeTheme.color.accent} size="small" />
          <Text style={styles.processingText}>
            Unfiled is organizing this. This page updates automatically.
          </Text>
        </View>
      ) : (
        <View style={styles.receipt}>
          {receipt.destination === null ? null : (
            <Pressable
              accessibilityRole="button"
              onPress={() =>
                router.push({
                  pathname: "/notes/[noteId]",
                  params: { noteId: receipt.destination?.noteId ?? "" }
                })
              }
              style={({ pressed }) => [styles.destination, pressed && styles.pressed]}
            >
              <View style={styles.destinationCopy}>
                <Text style={styles.label}>Filed in</Text>
                <Text style={styles.destinationTitle}>{receipt.destination.title}</Text>
              </View>
              <Ionicons color={nativeTheme.color.textSecondary} name="arrow-forward" size={19} />
            </Pressable>
          )}

          {receipt.insertedContent.length > 0 ? (
            <View style={styles.inserted}>
              <Text style={styles.sectionTitle}>What changed</Text>
              <Rule />
              {receipt.insertedContent.map((content, index) => (
                <View
                  key={
                    content.type === "ai_generated" ? content.blockId : `${content.itemId}-${index}`
                  }
                >
                  <View style={styles.contentRow}>
                    <Text style={styles.contentType}>
                      {content.type === "ai_generated" ? "AI suggestion" : "Your words"}
                    </Text>
                    <Text style={styles.contentText}>{content.content}</Text>
                  </View>
                  <Rule />
                </View>
              ))}
            </View>
          ) : null}

          {receipt.reasonCodes.length > 0 ? (
            <Text style={styles.reasons}>{receipt.reasonCodes.map(readableReason).join(", ")}</Text>
          ) : null}

          <View style={styles.actions}>
            {receipt.actions.map((action) => {
              if (action.type === "open") {
                return (
                  <Pressable
                    accessibilityRole="button"
                    key={action.type}
                    onPress={() =>
                      router.push({
                        pathname: "/notes/[noteId]",
                        params: { noteId: action.noteId }
                      })
                    }
                    style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed]}
                  >
                    <Text style={styles.primaryButtonText}>Open note</Text>
                  </Pressable>
                );
              }
              if (action.type === "undo") {
                const consumed = consumedUndoMutations.has(action.mutationId);
                return (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ disabled: busy || consumed }}
                    disabled={busy || consumed}
                    key={action.type}
                    onPress={() => void undo(action)}
                    style={({ pressed }) => [
                      styles.secondaryButton,
                      consumed && styles.consumedButton,
                      pressed && styles.pressed
                    ]}
                  >
                    <Text style={styles.secondaryButtonText}>
                      {consumed ? "Insertion undone" : "Undo insertion"}
                    </Text>
                  </Pressable>
                );
              }
              return null;
            })}
          </View>
        </View>
      )}

      {capture.status === "failed" ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: busy }}
          disabled={busy}
          onPress={() => void retry()}
          style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed]}
        >
          <Text style={styles.primaryButtonText}>Retry capture</Text>
        </Pressable>
      ) : null}

      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: busy }}
        disabled={busy}
        onPress={confirmRemove}
        style={styles.removeButton}
      >
        <Text style={styles.removeText}>Remove capture</Text>
      </Pressable>
    </Screen>
  );
}

const styles = StyleSheet.create({
  actions: { gap: 10, marginTop: 24 },
  contentRow: { gap: 7, paddingVertical: 16 },
  contentText: { color: nativeTheme.color.textPrimary, fontSize: 14, lineHeight: 21 },
  contentType: {
    color: nativeTheme.color.accent,
    fontFamily: nativeTheme.fontFamily.mono,
    fontSize: 10,
    fontWeight: "700",
    textTransform: "uppercase"
  },
  consumedButton: { opacity: 0.55 },
  destination: {
    alignItems: "center",
    backgroundColor: nativeTheme.color.surfaceRaised,
    borderRadius: nativeTheme.radius.container,
    flexDirection: "row",
    justifyContent: "space-between",
    padding: 16
  },
  destinationCopy: { flex: 1, paddingRight: 12 },
  destinationTitle: {
    color: nativeTheme.color.textPrimary,
    fontSize: 17,
    fontWeight: "700",
    marginTop: 4
  },
  error: { color: nativeTheme.color.warning, fontSize: 13, lineHeight: 19, marginBottom: 18 },
  iconButton: { alignItems: "center", height: 44, justifyContent: "center", width: 44 },
  inserted: { marginTop: 30 },
  label: {
    color: nativeTheme.color.textSecondary,
    fontFamily: nativeTheme.fontFamily.mono,
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.6,
    textTransform: "uppercase"
  },
  original: {
    borderBottomColor: nativeTheme.color.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    marginBottom: 24,
    paddingBottom: 24
  },
  originalText: {
    color: nativeTheme.color.textPrimary,
    fontSize: 17,
    lineHeight: 25,
    marginTop: 10
  },
  pressed: { opacity: 0.68 },
  primaryButton: {
    alignItems: "center",
    backgroundColor: nativeTheme.color.accent,
    borderRadius: nativeTheme.radius.button,
    justifyContent: "center",
    minHeight: 50,
    paddingHorizontal: 18
  },
  primaryButtonText: { color: nativeTheme.color.accentContrast, fontSize: 14, fontWeight: "800" },
  processing: { alignItems: "center", flexDirection: "row", gap: 12, paddingVertical: 24 },
  processingText: { color: nativeTheme.color.textSecondary, flex: 1, fontSize: 13, lineHeight: 19 },
  reasons: { color: nativeTheme.color.textSecondary, fontSize: 12, lineHeight: 18, marginTop: 18 },
  receipt: { marginBottom: 30 },
  removeButton: { alignItems: "center", minHeight: 48, padding: 14 },
  removeText: { color: nativeTheme.color.danger, fontSize: 13, fontWeight: "700" },
  secondaryButton: {
    alignItems: "center",
    borderColor: nativeTheme.color.border,
    borderRadius: nativeTheme.radius.button,
    borderWidth: StyleSheet.hairlineWidth,
    justifyContent: "center",
    minHeight: 50,
    paddingHorizontal: 18
  },
  secondaryButtonText: { color: nativeTheme.color.textPrimary, fontSize: 14, fontWeight: "700" },
  sectionTitle: {
    color: nativeTheme.color.textPrimary,
    fontSize: 17,
    fontWeight: "700",
    marginBottom: 12
  }
});
