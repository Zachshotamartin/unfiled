import { router, useLocalSearchParams } from "expo-router";
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
import { nativeTheme } from "../../theme/nativeTheme";

export default function VerifyScreen(): ReactElement {
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ email?: string; retryAfterSeconds?: string }>();
  const email = params.email ?? "";
  const { requestCode, verifyCode } = useSession();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [resendAfter, setResendAfter] = useState(() => {
    const seconds = Number(params.retryAfterSeconds);
    return Number.isInteger(seconds) && seconds > 0 ? seconds : 0;
  });
  const valid = /^\d{6}$/.test(code);

  useEffect(() => {
    if (resendAfter < 1) return undefined;
    const timer = setInterval(() => setResendAfter((value) => Math.max(0, value - 1)), 1_000);
    return () => clearInterval(timer);
  }, [resendAfter]);

  const verify = async (): Promise<void> => {
    if (!valid || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      await verifyCode(email, code);
      router.replace("/(tabs)");
    } catch (cause) {
      setMessage(
        cause instanceof MobileAuthError
          ? cause.message
          : "That code couldn’t be verified. Request a new one and try again."
      );
    } finally {
      setBusy(false);
    }
  };

  const resend = async (): Promise<void> => {
    if (busy || resendAfter > 0) return;
    setBusy(true);
    try {
      const retryAfterSeconds = await requestCode(email);
      setResendAfter(retryAfterSeconds);
      setMessage("A new six-digit code was sent.");
    } catch (cause) {
      if (cause instanceof MobileAuthError) {
        if (cause.retryAfterSeconds !== undefined) setResendAfter(cause.retryAfterSeconds);
        setMessage(mobileAuthErrorMessage(cause));
      } else {
        setMessage("Couldn't send a new code.");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={[styles.screen, { paddingTop: Math.max(insets.top, 28) }]}
    >
      <Pressable accessibilityRole="button" onPress={() => router.back()} style={styles.back}>
        <Text style={styles.backText}>Back</Text>
      </Pressable>
      <View style={styles.content}>
        <Text style={styles.eyebrow}>CHECK YOUR EMAIL</Text>
        <Text style={styles.title}>Enter the code</Text>
        <Text style={styles.body}>We sent a six-digit code to {email}.</Text>
        <TextInput
          accessibilityLabel="Six-digit sign-in code"
          autoFocus
          keyboardAppearance="dark"
          keyboardType="number-pad"
          maxLength={6}
          onChangeText={(value) => setCode(value.replace(/\D/g, ""))}
          onSubmitEditing={() => void verify()}
          selectionColor={nativeTheme.color.accent}
          style={styles.code}
          textContentType="oneTimeCode"
          value={code}
        />
        <Text accessibilityLiveRegion="polite" style={styles.message}>
          {message}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: busy || resendAfter > 0 }}
          disabled={busy || resendAfter > 0}
          onPress={() => void resend()}
        >
          <Text style={[styles.resend, (busy || resendAfter > 0) && styles.resendDisabled]}>
            {resendAfter > 0 ? `Send another code in ${resendAfter}s` : "Send another code"}
          </Text>
        </Pressable>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: !valid || busy }}
        disabled={!valid || busy}
        onPress={() => void verify()}
        style={[styles.button, (!valid || busy) && styles.disabled]}
      >
        {busy ? (
          <ActivityIndicator color={nativeTheme.color.accentContrast} />
        ) : (
          <Text style={styles.buttonText}>Continue</Text>
        )}
      </Pressable>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  back: { alignSelf: "flex-start", minHeight: 44, paddingHorizontal: 24, paddingVertical: 12 },
  backText: { color: nativeTheme.color.textSecondary, fontSize: 15 },
  body: {
    color: nativeTheme.color.textSecondary,
    fontSize: 16,
    lineHeight: 24,
    marginBottom: 34,
    marginTop: 12
  },
  button: {
    alignItems: "center",
    backgroundColor: nativeTheme.color.accent,
    borderRadius: nativeTheme.radius.input,
    justifyContent: "center",
    margin: 24,
    minHeight: 54
  },
  buttonText: { color: nativeTheme.color.accentContrast, fontSize: 16, fontWeight: "700" },
  code: {
    backgroundColor: nativeTheme.color.surface,
    borderColor: nativeTheme.color.border,
    borderRadius: nativeTheme.radius.input,
    borderWidth: StyleSheet.hairlineWidth,
    color: nativeTheme.color.textPrimary,
    fontFamily: nativeTheme.fontFamily.mono,
    fontSize: 30,
    letterSpacing: 12,
    minHeight: 68,
    paddingLeft: 22,
    textAlign: "center"
  },
  content: { flex: 1, paddingHorizontal: 24, paddingTop: 44 },
  disabled: { opacity: 0.38 },
  eyebrow: {
    color: nativeTheme.color.accent,
    fontFamily: nativeTheme.fontFamily.mono,
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 1.5
  },
  message: { color: nativeTheme.color.textSecondary, fontSize: 13, minHeight: 38, paddingTop: 12 },
  resend: { color: nativeTheme.color.accent, fontSize: 14, fontWeight: "600", paddingVertical: 12 },
  resendDisabled: { color: nativeTheme.color.textDisabled },
  screen: { backgroundColor: nativeTheme.color.canvas, flex: 1 },
  title: {
    color: nativeTheme.color.textPrimary,
    fontSize: 32,
    fontWeight: "600",
    letterSpacing: -0.7,
    marginTop: 18
  }
});
