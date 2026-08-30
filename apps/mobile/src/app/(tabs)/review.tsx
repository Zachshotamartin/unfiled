import type { ReactElement } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { Screen } from "../../components/Screen";
import { nativeTheme } from "../../theme/nativeTheme";

export default function ReviewScreen(): ReactElement {
  return (
    <Screen eyebrow="1 needs your input" title="Review">
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <View style={styles.slip} />
          <Text style={styles.meta}>CAPTURE · 11:08</Text>
        </View>
        <Text style={styles.capture}>
          Roosevelt method: tell people you can do it, then figure out how to do it later
        </Text>

        <View style={styles.proposal}>
          <Text style={styles.proposalLabel}>PROPOSED DESTINATION</Text>
          <Text style={styles.destination}>Mindset / Principles</Text>
          <Text style={styles.reason}>Similar to principles you've saved before.</Text>
        </View>

        <Pressable
          accessibilityRole="button"
          style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed]}
        >
          <Text style={styles.primaryText}>Accept</Text>
        </Pressable>
        <View style={styles.secondaryActions}>
          <Pressable
            accessibilityRole="button"
            style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
          >
            <Text style={styles.secondaryText}>Move</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
          >
            <Text style={styles.secondaryText}>Keep in Inbox</Text>
          </Pressable>
        </View>
        <Text style={styles.trust}>Original preserved · Undo available</Text>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  capture: {
    color: nativeTheme.color.textPrimary,
    fontSize: 21,
    fontWeight: "500",
    letterSpacing: -0.35,
    lineHeight: 30,
    marginBottom: 28
  },
  card: {
    backgroundColor: nativeTheme.color.surface,
    borderColor: nativeTheme.color.border,
    borderRadius: nativeTheme.radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 20
  },
  cardHeader: { alignItems: "center", flexDirection: "row", gap: 10, marginBottom: 19 },
  destination: {
    color: nativeTheme.color.textPrimary,
    fontSize: 17,
    fontWeight: "600",
    marginBottom: 5
  },
  meta: {
    color: nativeTheme.color.textSecondary,
    fontFamily: nativeTheme.fontFamily.mono,
    fontSize: 10,
    letterSpacing: 0.6
  },
  pressed: { opacity: 0.7 },
  primaryButton: {
    alignItems: "center",
    backgroundColor: nativeTheme.color.accent,
    borderRadius: nativeTheme.radius.button,
    justifyContent: "center",
    minHeight: 48
  },
  primaryText: { color: nativeTheme.color.accentContrast, fontSize: 16, fontWeight: "700" },
  proposal: {
    borderBottomColor: nativeTheme.color.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderTopColor: nativeTheme.color.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    marginBottom: 20,
    paddingVertical: 18
  },
  proposalLabel: {
    color: nativeTheme.color.accent,
    fontFamily: nativeTheme.fontFamily.mono,
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.6,
    marginBottom: 10
  },
  reason: { color: nativeTheme.color.textSecondary, fontSize: 13, lineHeight: 19 },
  secondaryActions: { flexDirection: "row", gap: 10, marginTop: 10 },
  secondaryButton: {
    alignItems: "center",
    borderColor: nativeTheme.color.border,
    borderRadius: nativeTheme.radius.button,
    borderWidth: StyleSheet.hairlineWidth,
    flex: 1,
    justifyContent: "center",
    minHeight: 46,
    paddingHorizontal: 8
  },
  secondaryText: { color: nativeTheme.color.textPrimary, fontSize: 13, fontWeight: "600" },
  slip: {
    backgroundColor: nativeTheme.color.accent,
    height: 19,
    transform: [{ rotate: "13deg" }],
    width: 7
  },
  trust: {
    color: nativeTheme.color.textSecondary,
    fontFamily: nativeTheme.fontFamily.mono,
    fontSize: 10,
    marginTop: 18,
    textAlign: "center"
  }
});
