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
import { nativeTheme } from "../../theme/nativeTheme";
import {
  commitCaptureToOutbox,
  discardCaptureDraft,
  loadCaptureDraft,
  pendingCaptureCount,
  saveCaptureDraft
} from "./captureDraftRepository";
import { captureSourceLabel, type NativeCaptureSource } from "./captureSource";
import { submitCapture } from "./captureSubmission";
import { scheduleWidgetPendingCount } from "./lockScreenCapture";

const LOCAL_PROFILE_ID = "local-device-profile";
const DRAFT_DEBOUNCE_MS = 250;

interface CaptureComposerProps {
  source: NativeCaptureSource;
}

export function CaptureComposer({ source }: CaptureComposerProps): ReactElement {
  const insets = useSafeAreaInsets();
  const inputRef = useRef<ComponentRef<typeof TextInput>>(null);
  const bodyRef = useRef("");
  const draftTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(true);
  const [body, setBody] = useState("");
  const [committing, setCommitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [restored, setRestored] = useState(false);

  const flushDraft = useCallback(async (): Promise<void> => {
    if (draftTimer.current !== undefined) clearTimeout(draftTimer.current);
    draftTimer.current = undefined;
    const currentBody = bodyRef.current;
    if (currentBody.length === 0) {
      await discardCaptureDraft(LOCAL_PROFILE_ID, source);
    } else {
      await saveCaptureDraft(LOCAL_PROFILE_ID, source, currentBody);
    }
  }, [source]);

  useEffect(() => {
    mounted.current = true;
    void loadCaptureDraft(LOCAL_PROFILE_ID, source).then((draft) => {
      if (!mounted.current || draft === null) return;
      bodyRef.current = draft.body;
      setBody(draft.body);
      setRestored(true);
    });
    return () => {
      mounted.current = false;
      if (draftTimer.current !== undefined) clearTimeout(draftTimer.current);
      void flushDraft();
    };
  }, [flushDraft, source]);

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
        void saveCaptureDraft(LOCAL_PROFILE_ID, source, bodyRef.current);
      }, DRAFT_DEBOUNCE_MS);
    },
    [source]
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
          void discardCaptureDraft(LOCAL_PROFILE_ID, source).then(() => router.back());
        }
      },
      { text: "Continue writing", style: "cancel" }
    ]);
  }, [source]);

  const submit = useCallback(async (): Promise<void> => {
    const rawContent = bodyRef.current;
    if (rawContent.trim().length === 0 || committing) return;
    setCommitting(true);
    setMessage(null);
    const result = await submitCapture({
      persist: () => commitCaptureToOutbox(LOCAL_PROFILE_ID, source, rawContent, true),
      sideEffects: [
        async () => {
          const count = await pendingCaptureCount(LOCAL_PROFILE_ID);
          scheduleWidgetPendingCount(count);
        },
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
    setRestored(false);
    setMessage("Saved");
    if (mounted.current) setCommitting(false);
    void result.effects;
  }, [committing, source]);

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
        <View style={styles.topBarSpacer} />
      </View>

      <View style={styles.composer}>
        {restored ? <Text style={styles.draftLabel}>Unsaved draft</Text> : null}
        <TextInput
          ref={inputRef}
          accessibilityLabel="Capture text"
          autoCapitalize="sentences"
          keyboardAppearance="dark"
          multiline
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
        <View style={styles.composerFooter}>
          <Text accessibilityLiveRegion="polite" style={styles.message}>
            {message ?? "Saved here first. Organized after."}
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
  },
  topBarSpacer: { width: 44 }
});
