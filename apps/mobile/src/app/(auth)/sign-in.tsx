import { router } from "expo-router";
import { useEffect, useState, type ReactElement } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useSession } from "../../auth/AuthProvider";
import { MobileAuthError, mobileAuthErrorMessage } from "../../auth/authApi";
import { normalizeEmail } from "../../auth/session";
import { BrandMark } from "../../components/BrandMark";
import { pendingCaptureCount } from "../../features/capture/captureDraftRepository";
import { nativeTheme } from "../../theme/nativeTheme";

export default function SignInScreen(): ReactElement {
  const insets = useSafeAreaInsets();
  const { lastProfileEmail, lastProfileId, requestCode } = useSession();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
  const normalizedEmail = normalizeEmail(email);
  const valid = /^\S+@\S+\.\S+$/.test(normalizedEmail);

  useEffect(() => {
    let active = true;
    if (lastProfileId === null) return undefined;
    void pendingCaptureCount(lastProfileId).then((count) => {
      if (active) setPendingCount(count);
    });
    return () => {
      active = false;
    };
  }, [lastProfileId]);

  const submit = async (): Promise<void> => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const retryAfterSeconds = await requestCode(normalizedEmail);
      router.push({
        pathname: "/(auth)/verify",
        params: { email: normalizedEmail, retryAfterSeconds: String(retryAfterSeconds) }
      });
    } catch (cause) {
      setError(
        cause instanceof MobileAuthError
          ? mobileAuthErrorMessage(cause)
          : "Couldn't request a code. Try again."
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={[styles.screen, { paddingBottom: Math.max(insets.bottom, 24) }]}
    >
      <View style={[styles.content, { paddingTop: Math.max(insets.top, 36) }]}>
        <BrandMark size={34} />
        <Text style={styles.eyebrow}>UNFILED</Text>
        <Text style={styles.title}>Your notes can find their place after you write them.</Text>
        <Text style={styles.body}>Enter your email. We’ll send a six-digit sign-in code.</Text>

        {pendingCount > 0 && lastProfileEmail !== null ? (
          <View accessibilityRole="summary" style={styles.pendingNotice}>
            <Text style={styles.pendingTitle}>
              {pendingCount} {pendingCount === 1 ? "capture is" : "captures are"} waiting
            </Text>
            <Text style={styles.pendingBody}>
              Saved on this device for {lastProfileEmail}. They will sync only after that same
              account signs back in.
            </Text>
          </View>
        ) : null}

        <Text style={styles.label}>Email address</Text>
        <TextInput
          accessibilityLabel="Email address"
          autoCapitalize="none"
          autoComplete="email"
          autoCorrect={false}
          keyboardAppearance="dark"
          keyboardType="email-address"
          onChangeText={setEmail}
          onSubmitEditing={() => void submit()}
          placeholder="you@example.com"
          placeholderTextColor={nativeTheme.color.textDisabled}
          returnKeyType="next"
          selectionColor={nativeTheme.color.accent}
          style={styles.input}
          value={email}
        />
        <Text accessibilityLiveRegion="polite" style={styles.error}>
          {error}
        </Text>
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: !valid || busy }}
        disabled={!valid || busy}
        onPress={() => void submit()}
        style={({ pressed }) => [
          styles.button,
          (!valid || busy) && styles.disabled,
          pressed && styles.pressed
        ]}
      >
        {busy ? (
          <ActivityIndicator color={nativeTheme.color.accentContrast} />
        ) : (
          <Text style={styles.buttonText}>Send code</Text>
        )}
      </Pressable>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  body: {
    color: nativeTheme.color.textSecondary,
    fontSize: 16,
    lineHeight: 24,
    marginBottom: 42,
    marginTop: 16,
    maxWidth: 330
  },
  button: {
    alignItems: "center",
    backgroundColor: nativeTheme.color.accent,
    borderRadius: nativeTheme.radius.input,
    justifyContent: "center",
    marginHorizontal: 24,
    minHeight: 54
  },
  buttonText: { color: nativeTheme.color.accentContrast, fontSize: 16, fontWeight: "700" },
  content: { flex: 1, paddingHorizontal: 24 },
  disabled: { opacity: 0.38 },
  error: { color: nativeTheme.color.danger, fontSize: 13, lineHeight: 19, marginTop: 12 },
  eyebrow: {
    color: nativeTheme.color.accent,
    fontFamily: nativeTheme.fontFamily.mono,
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 1.8,
    marginTop: 18
  },
  input: {
    backgroundColor: nativeTheme.color.surface,
    borderColor: nativeTheme.color.border,
    borderRadius: nativeTheme.radius.input,
    borderWidth: StyleSheet.hairlineWidth,
    color: nativeTheme.color.textPrimary,
    fontSize: 17,
    minHeight: 54,
    paddingHorizontal: 16
  },
  label: { color: nativeTheme.color.textSecondary, fontSize: 13, marginBottom: 9 },
  pendingBody: {
    color: nativeTheme.color.textSecondary,
    fontSize: 13,
    lineHeight: 19,
    marginTop: 4
  },
  pendingNotice: {
    borderColor: nativeTheme.color.border,
    borderRadius: nativeTheme.radius.input,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: 24,
    padding: 14
  },
  pendingTitle: { color: nativeTheme.color.textPrimary, fontSize: 14, fontWeight: "700" },
  pressed: { opacity: 0.75 },
  screen: { backgroundColor: nativeTheme.color.canvas, flex: 1 },
  title: {
    color: nativeTheme.color.textPrimary,
    fontSize: 31,
    fontWeight: "600",
    letterSpacing: -0.8,
    lineHeight: 38,
    marginTop: 20,
    maxWidth: 350
  }
});
