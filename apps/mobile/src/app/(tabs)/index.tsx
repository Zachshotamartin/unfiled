import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import type { ReactElement } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { BrandMark } from "../../components/BrandMark";
import { Rule } from "../../components/Rule";
import { Screen } from "../../components/Screen";
import { nativeTheme } from "../../theme/nativeTheme";

const receipts = [
  { destination: "Shopping", outcome: "Added bananas", time: "10:42", type: "LIST" },
  { destination: "Push Workout", outcome: "Updated today's workout", time: "08:16", type: "LOG" },
  {
    destination: "Mindset / Principles",
    outcome: "Added a principle",
    time: "Yesterday",
    type: "NOTE"
  }
] as const;

export default function TodayScreen(): ReactElement {
  return (
    <Screen eyebrow="Sunday · August 30" rightAccessory={<BrandMark size={30} />} title="Today">
      <Pressable
        accessibilityHint="Opens a blank capture"
        accessibilityRole="button"
        onPress={() => router.push("/capture?source=mobile")}
        style={({ pressed }) => [styles.capturePrompt, pressed && styles.capturePromptPressed]}
      >
        <Text style={styles.captureText}>Write something</Text>
        <Ionicons color={nativeTheme.color.accentContrast} name="arrow-forward" size={21} />
      </Pressable>

      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>Latest changes</Text>
        <Text style={styles.sectionCount}>{receipts.length} RECEIPTS</Text>
      </View>
      <Rule />
      {receipts.map((receipt) => (
        <View key={`${receipt.destination}-${receipt.time}`}>
          <Pressable
            accessibilityRole="button"
            style={({ pressed }) => [styles.receipt, pressed && styles.rowPressed]}
          >
            <View style={styles.slip} />
            <View style={styles.receiptBody}>
              <Text style={styles.outcome}>{receipt.outcome}</Text>
              <Text style={styles.destination}>{receipt.destination}</Text>
            </View>
            <View style={styles.receiptMeta}>
              <Text style={styles.type}>{receipt.type}</Text>
              <Text style={styles.time}>{receipt.time}</Text>
            </View>
          </Pressable>
          <Rule />
        </View>
      ))}
    </Screen>
  );
}

const styles = StyleSheet.create({
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
  captureText: { color: nativeTheme.color.accentContrast, fontSize: 17, fontWeight: "600" },
  destination: {
    color: nativeTheme.color.textSecondary,
    fontSize: 14,
    lineHeight: 20,
    marginTop: 3
  },
  outcome: {
    color: nativeTheme.color.textPrimary,
    fontSize: 16,
    fontWeight: "600",
    lineHeight: 22
  },
  receipt: { alignItems: "flex-start", flexDirection: "row", minHeight: 88, paddingVertical: 18 },
  receiptBody: { flex: 1, paddingRight: 12 },
  receiptMeta: { alignItems: "flex-end", gap: 5 },
  rowPressed: { opacity: 0.62 },
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
  },
  type: {
    color: nativeTheme.color.accent,
    fontFamily: nativeTheme.fontFamily.mono,
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.6
  }
});
