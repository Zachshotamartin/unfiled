import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentRef,
  type ReactElement
} from "react";
import {
  Alert,
  AppState,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { BrandMark } from "../../components/BrandMark";
import { useSession } from "../../auth/AuthProvider";
import { nativeTheme } from "../../theme/nativeTheme";
import {
  commitCaptureToOutbox,
  defaultCapturePreferences,
  discardCaptureDraft,
  loadCaptureDraft,
  pendingCaptureCount,
  saveCaptureDraft,
  type CapturePreferences
} from "./captureDraftRepository";
import { requestCaptureOutboxDrain } from "./captureOutboxSignals";
import { captureSourceLabel, type NativeCaptureSource } from "./captureSource";
import { submitCapture } from "./captureSubmission";
import { scheduleWidgetPendingCount } from "./lockScreenCapture";
import { useNoteList } from "../notes/useNotesApi";

const DRAFT_DEBOUNCE_MS = 250;

interface CaptureComposerProps {
  source: NativeCaptureSource;
}

export function CaptureComposer({ source }: CaptureComposerProps): ReactElement {
  const { lastProfileId, session } = useSession();
  const profileId = session?.user.id ?? lastProfileId;
  const insets = useSafeAreaInsets();
  const inputRef = useRef<ComponentRef<typeof TextInput>>(null);
  const bodyRef = useRef("");
  const preferencesRef = useRef<CapturePreferences>({ ...defaultCapturePreferences });
  const draftTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(true);
  const [body, setBody] = useState("");
  const [preferences, setPreferences] = useState<CapturePreferences>({
    ...defaultCapturePreferences
  });
  const [committing, setCommitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [restored, setRestored] = useState(false);
  const notes = useNoteList();
  const destinationNotes = notes.value.slice(0, 3);

  const flushDraft = useCallback(async (): Promise<void> => {
    if (profileId === null) return;
    if (draftTimer.current !== undefined) clearTimeout(draftTimer.current);
    draftTimer.current = undefined;
    const currentBody = bodyRef.current;
    if (currentBody.length === 0) {
      await discardCaptureDraft(profileId, source);
    } else {
      await saveCaptureDraft(profileId, source, currentBody, preferencesRef.current);
    }
  }, [profileId, source]);

  useEffect(() => {
    mounted.current = true;
    if (profileId === null) return undefined;
    void loadCaptureDraft(profileId, source).then((draft) => {
      if (!mounted.current || draft === null) return;
      bodyRef.current = draft.body;
      preferencesRef.current = {
        expansionDisabled: draft.expansionDisabled,
        explicitDestinationNoteId: draft.explicitDestinationNoteId,
        privacy: draft.privacy
      };
      setBody(draft.body);
      setPreferences(preferencesRef.current);
      setRestored(true);
    });
    return () => {
      mounted.current = false;
      if (draftTimer.current !== undefined) clearTimeout(draftTimer.current);
      void flushDraft();
    };
  }, [flushDraft, profileId, source]);

  useEffect(() => {
    const focusInput = (): (() => void) => {
      let firstFrame = 0;
      let secondFrame = 0;
      let retry: ReturnType<typeof setTimeout> | undefined;
      firstFrame = requestAnimationFrame(() => {
        secondFrame = requestAnimationFrame(() => {
          inputRef.current?.focus();
          retry = setTimeout(() => {
            if (!inputRef.current?.isFocused()) inputRef.current?.focus();
          }, 180);
        });
      });
      return () => {
        cancelAnimationFrame(firstFrame);
        cancelAnimationFrame(secondFrame);
        if (retry !== undefined) clearTimeout(retry);
      };
    };

    let cancelFocus = AppState.currentState === "active" ? focusInput() : undefined;
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        cancelFocus?.();
        cancelFocus = focusInput();
      } else {
        void flushDraft();
      }
    });
    return () => {
      cancelFocus?.();
      subscription.remove();
    };
  }, [flushDraft]);

  const updateBody = useCallback(
    (nextBody: string): void => {
      bodyRef.current = nextBody;
      setBody(nextBody);
      setMessage(null);
      setRestored(false);
      if (draftTimer.current !== undefined) clearTimeout(draftTimer.current);
      draftTimer.current = setTimeout(() => {
        if (profileId !== null) {
          void saveCaptureDraft(profileId, source, bodyRef.current, preferencesRef.current);
        }
      }, DRAFT_DEBOUNCE_MS);
    },
    [profileId, source]
  );

  const updatePreferences = useCallback(
    (update: (current: CapturePreferences) => CapturePreferences): void => {
      const next = update(preferencesRef.current);
      preferencesRef.current = next;
      setPreferences(next);
      setMessage(null);
      if (profileId !== null && bodyRef.current.length > 0) {
        void saveCaptureDraft(profileId, source, bodyRef.current, next);
      }
    },
    [profileId, source]
  );

  const close = useCallback((): void => {
    if (bodyRef.current.trim().length === 0) {
      router.back();
      return;
    }
    Alert.alert("Keep this draft?", "You can return to it from the same capture entry point.", [
      { text: "Keep draft", onPress: () => router.back() },
      {
        text: "Discard",
        style: "destructive",
        onPress: () => {
          bodyRef.current = "";
          if (profileId === null) {
            router.back();
          } else {
            void discardCaptureDraft(profileId, source).then(() => router.back());
          }
        }
      },
      { text: "Continue writing", style: "cancel" }
    ]);
  }, [profileId, source]);

  const submit = useCallback(async (): Promise<void> => {
    const rawContent = bodyRef.current;
    if (rawContent.trim().length === 0 || committing || profileId === null) return;
    setCommitting(true);
    setMessage(null);
    const result = await submitCapture({
      persist: () =>
        commitCaptureToOutbox({
          preferences: preferencesRef.current,
          profileId,
          rawContent,
          sessionAvailable: session !== null,
          source
        }),
      sideEffects: [
        async () => {
          const count = await pendingCaptureCount(profileId);
          scheduleWidgetPendingCount(count);
        },
        () => Promise.resolve(requestCaptureOutboxDrain()),
        () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
      ]
    });

    if (result.status === "commit_failed") {
      setMessage("Couldn't save on this device. Your text is still here.");
      if (mounted.current) setCommitting(false);
      return;
    }

    bodyRef.current = "";
    setBody("");
    preferencesRef.current = { ...defaultCapturePreferences };
    setPreferences(preferencesRef.current);
    setRestored(false);
    setMessage(
      session === null
        ? "Saved on this device. Waiting for the same account to sign in."
        : "Saved on this device"
    );
    if (mounted.current) setCommitting(false);
    void result.effects;
    router.replace(
      `/(tabs)?captureSaved=${session === null ? "waiting" : "ready"}&captureId=${result.value.clientCaptureId}`
    );
  }, [committing, profileId, session, source]);

  const canSubmit = body.trim().length > 0 && !committing;

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={styles.screen}
    >
      <View style={[styles.topBar, { paddingTop: Math.max(insets.top, 16) }]}>
        <Pressable
          accessibilityLabel="Close capture"
          accessibilityRole="button"
          hitSlop={8}
          onPress={close}
          style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
        >
          <Ionicons color={nativeTheme.color.textPrimary} name="close" size={26} />
        </Pressable>
        <View style={styles.sourceRow}>
          <BrandMark size={20} />
          <Text style={styles.sourceText}>{captureSourceLabel(source)}</Text>
        </View>
        <Pressable
          accessibilityLabel={optionsOpen ? "Hide capture options" : "Show capture options"}
          accessibilityRole="button"
          accessibilityState={{ expanded: optionsOpen }}
          hitSlop={8}
          onPress={() => setOptionsOpen((open) => !open)}
          style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
        >
          <Ionicons
            color={optionsOpen ? nativeTheme.color.accent : nativeTheme.color.textPrimary}
            name="options-outline"
            size={23}
          />
        </Pressable>
      </View>

      <View style={styles.composer}>
        {restored ? <Text style={styles.draftLabel}>Unsaved draft</Text> : null}
        {optionsOpen ? (
          <View accessibilityLabel="Capture options" style={styles.optionsPanel}>
            <View style={styles.optionGroup}>
              <Text style={styles.optionLabel}>Processing</Text>
              <View style={styles.optionChoices}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected: preferences.privacy === "ai_assisted" }}
                  onPress={() =>
                    updatePreferences((current) => ({ ...current, privacy: "ai_assisted" }))
                  }
                  style={[
                    styles.optionButton,
                    preferences.privacy === "ai_assisted" && styles.optionButtonSelected
                  ]}
                >
                  <Text
                    style={[
                      styles.optionButtonText,
                      preferences.privacy === "ai_assisted" && styles.optionButtonTextSelected
                    ]}
                  >
                    Organize
                  </Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected: preferences.privacy === "private_manual" }}
                  onPress={() =>
                    updatePreferences((current) => ({
                      ...current,
                      expansionDisabled: true,
                      privacy: "private_manual"
                    }))
                  }
                  style={[
                    styles.optionButton,
                    preferences.privacy === "private_manual" && styles.optionButtonSelected
                  ]}
                >
                  <Text
                    style={[
                      styles.optionButtonText,
                      preferences.privacy === "private_manual" && styles.optionButtonTextSelected
                    ]}
                  >
                    Private
                  </Text>
                </Pressable>
              </View>
            </View>

            <View style={styles.optionGroup}>
              <Text style={styles.optionLabel}>Destination</Text>
              <View style={styles.destinationChoices}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected: preferences.explicitDestinationNoteId === null }}
                  onPress={() =>
                    updatePreferences((current) => ({
                      ...current,
                      explicitDestinationNoteId: null
                    }))
                  }
                  style={[
                    styles.destinationButton,
                    preferences.explicitDestinationNoteId === null &&
                      styles.destinationButtonSelected
                  ]}
                >
                  <Text style={styles.destinationText}>Automatic</Text>
                </Pressable>
                {destinationNotes.map((note) => (
                  <Pressable
                    accessibilityLabel={`Send to ${note.title}`}
                    accessibilityRole="button"
                    accessibilityState={{
                      selected: preferences.explicitDestinationNoteId === note.id
                    }}
                    key={note.id}
                    onPress={() =>
                      updatePreferences((current) => ({
                        ...current,
                        explicitDestinationNoteId: note.id
                      }))
                    }
                    style={[
                      styles.destinationButton,
                      preferences.explicitDestinationNoteId === note.id &&
                        styles.destinationButtonSelected
                    ]}
                  >
                    <Text style={styles.destinationText}>{note.title}</Text>
                  </Pressable>
                ))}
              </View>
            </View>

            <Pressable
              accessibilityRole="switch"
              accessibilityState={{
                checked: !preferences.expansionDisabled,
                disabled: preferences.privacy === "private_manual"
              }}
              disabled={preferences.privacy === "private_manual"}
              onPress={() =>
                updatePreferences((current) => ({
                  ...current,
                  expansionDisabled: !current.expansionDisabled
                }))
              }
              style={styles.expansionRow}
            >
              <View style={styles.expansionCopy}>
                <Text style={styles.expansionTitle}>Helpful expansion</Text>
                <Text style={styles.expansionDetail}>
                  {preferences.privacy === "private_manual"
                    ? "Off for private captures"
                    : preferences.expansionDisabled
                      ? "Off"
                      : "On"}
                </Text>
              </View>
              <Ionicons
                color={
                  preferences.expansionDisabled
                    ? nativeTheme.color.textDisabled
                    : nativeTheme.color.accent
                }
                name={preferences.expansionDisabled ? "toggle-outline" : "toggle"}
                size={31}
              />
            </Pressable>
          </View>
        ) : null}
        <TextInput
          ref={inputRef}
          accessibilityLabel="Capture text"
          autoCapitalize="sentences"
          keyboardAppearance="dark"
          multiline
          maxLength={10_000}
          onChangeText={updateBody}
          placeholder="Write something"
          placeholderTextColor={nativeTheme.color.textDisabled}
          returnKeyType="default"
          submitBehavior="newline"
          selectionColor={nativeTheme.color.accent}
          style={styles.input}
          textAlignVertical="top"
          value={body}
        />
        {body.length >= 9_000 ? (
          <Text accessibilityLiveRegion="polite" style={styles.characterCount}>
            {10_000 - body.length} characters left
          </Text>
        ) : null}
        <View style={styles.composerFooter}>
          <Text accessibilityLiveRegion="polite" style={styles.message}>
            {message ??
              (session === null
                ? "This stays on this device for your signed-out account."
                : "Saved here first. Organized after.")}
          </Text>
          <Pressable
            accessibilityLabel={committing ? "Saving capture" : "Save capture"}
            accessibilityRole="button"
            accessibilityState={{ disabled: !canSubmit }}
            disabled={!canSubmit}
            onPress={() => void submit()}
            style={({ pressed }) => [
              styles.sendButton,
              !canSubmit && styles.sendButtonDisabled,
              pressed && canSubmit && styles.sendButtonPressed
            ]}
          >
            <Ionicons color={nativeTheme.color.accentContrast} name="arrow-up" size={24} />
          </Pressable>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  characterCount: {
    alignSelf: "flex-end",
    color: nativeTheme.color.textSecondary,
    fontFamily: nativeTheme.fontFamily.mono,
    fontSize: 11,
    marginBottom: 8
  },
  composer: {
    backgroundColor: nativeTheme.color.surface,
    borderColor: nativeTheme.color.border,
    borderRadius: nativeTheme.radius.sheet,
    borderWidth: StyleSheet.hairlineWidth,
    flex: 1,
    marginBottom: 12,
    marginHorizontal: 12,
    padding: 20
  },
  composerFooter: {
    alignItems: "center",
    flexDirection: "row",
    gap: 16,
    justifyContent: "space-between"
  },
  draftLabel: {
    color: nativeTheme.color.accent,
    fontFamily: nativeTheme.fontFamily.mono,
    fontSize: 12,
    fontWeight: "600",
    letterSpacing: 0.5,
    marginBottom: 12,
    textTransform: "uppercase"
  },
  destinationButton: {
    borderColor: nativeTheme.color.border,
    borderRadius: nativeTheme.radius.input,
    borderWidth: StyleSheet.hairlineWidth,
    maxWidth: "100%",
    minHeight: 44,
    paddingHorizontal: 11,
    paddingVertical: 8
  },
  destinationButtonSelected: {
    backgroundColor: nativeTheme.color.surfaceRaised,
    borderColor: nativeTheme.color.accent
  },
  destinationChoices: { flexDirection: "row", flexWrap: "wrap", gap: 7 },
  destinationText: {
    color: nativeTheme.color.textPrimary,
    flexShrink: 1,
    fontSize: 12,
    fontWeight: "600"
  },
  expansionCopy: { flex: 1, paddingRight: 12 },
  expansionDetail: { color: nativeTheme.color.textSecondary, fontSize: 11, marginTop: 2 },
  expansionRow: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    minHeight: 44
  },
  expansionTitle: { color: nativeTheme.color.textPrimary, fontSize: 13, fontWeight: "600" },
  iconButton: {
    alignItems: "center",
    height: 44,
    justifyContent: "center",
    width: 44
  },
  input: {
    color: nativeTheme.color.textPrimary,
    flex: 1,
    fontFamily: nativeTheme.fontFamily.sans,
    fontSize: 24,
    fontWeight: "500",
    lineHeight: 32,
    padding: 0
  },
  message: {
    color: nativeTheme.color.textSecondary,
    flex: 1,
    fontFamily: nativeTheme.fontFamily.sans,
    fontSize: 13,
    lineHeight: 18
  },
  optionButton: {
    alignItems: "center",
    borderColor: nativeTheme.color.border,
    borderRadius: nativeTheme.radius.input,
    borderWidth: StyleSheet.hairlineWidth,
    flex: 1,
    minHeight: 44,
    paddingHorizontal: 12,
    paddingVertical: 9
  },
  optionButtonSelected: {
    backgroundColor: nativeTheme.color.accent,
    borderColor: nativeTheme.color.accent
  },
  optionButtonText: { color: nativeTheme.color.textSecondary, fontSize: 12, fontWeight: "700" },
  optionButtonTextSelected: { color: nativeTheme.color.accentContrast },
  optionChoices: { flexDirection: "row", gap: 8 },
  optionGroup: { gap: 7 },
  optionLabel: {
    color: nativeTheme.color.textSecondary,
    fontFamily: nativeTheme.fontFamily.mono,
    fontSize: 10,
    fontWeight: "600",
    letterSpacing: 0.5,
    textTransform: "uppercase"
  },
  optionsPanel: {
    borderBottomColor: nativeTheme.color.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 14,
    marginBottom: 16,
    paddingBottom: 16
  },
  pressed: { opacity: 0.55 },
  screen: { backgroundColor: nativeTheme.color.canvas, flex: 1 },
  sendButton: {
    alignItems: "center",
    backgroundColor: nativeTheme.color.accent,
    borderRadius: 22,
    height: 44,
    justifyContent: "center",
    width: 44
  },
  sendButtonDisabled: { opacity: 0.35 },
  sendButtonPressed: { opacity: 0.74, transform: [{ scale: 0.96 }] },
  sourceRow: { alignItems: "center", flexDirection: "row", gap: 8 },
  sourceText: {
    color: nativeTheme.color.textSecondary,
    fontFamily: nativeTheme.fontFamily.mono,
    fontSize: 12,
    fontWeight: "500"
  },
  topBar: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    paddingBottom: 12,
    paddingHorizontal: 8
  }
});
