import type { PropsWithChildren, ReactElement, ReactNode } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { nativeTheme } from "../theme/nativeTheme";

type ScreenProps = PropsWithChildren<{
  eyebrow?: string;
  rightAccessory?: ReactNode;
  scroll?: boolean;
  title: string;
}>;

export function Screen({
  children,
  eyebrow,
  rightAccessory,
  scroll = true,
  title
}: ScreenProps): ReactElement {
  const content = (
    <>
      <View style={styles.header}>
        <View style={styles.headingBlock}>
          {eyebrow === undefined ? null : <Text style={styles.eyebrow}>{eyebrow}</Text>}
          <Text accessibilityRole="header" style={styles.title}>
            {title}
          </Text>
        </View>
        {rightAccessory}
      </View>
      {children}
    </>
  );

  return (
    <SafeAreaView edges={["top"]} style={styles.safeArea}>
      {scroll ? (
        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          {content}
        </ScrollView>
      ) : (
        <View style={styles.content}>{content}</View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  content: { flexGrow: 1, paddingBottom: 120, paddingHorizontal: 20, paddingTop: 18 },
  eyebrow: {
    color: nativeTheme.color.accent,
    fontFamily: nativeTheme.fontFamily.mono,
    fontSize: 12,
    fontWeight: "600",
    letterSpacing: 0.8,
    marginBottom: 4,
    textTransform: "uppercase"
  },
  header: {
    alignItems: "flex-start",
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 30
  },
  headingBlock: { flex: 1 },
  safeArea: { backgroundColor: nativeTheme.color.canvas, flex: 1 },
  title: {
    color: nativeTheme.color.textPrimary,
    fontFamily: nativeTheme.fontFamily.sans,
    fontSize: 32,
    fontWeight: "600",
    letterSpacing: -1.2,
    lineHeight: 38
  }
});
