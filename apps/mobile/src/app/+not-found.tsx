import { Link } from "expo-router";
import type { ReactElement } from "react";
import { StyleSheet, Text, View } from "react-native";

import { nativeTheme } from "../theme/nativeTheme";

export default function NotFoundScreen(): ReactElement {
  return (
    <View style={styles.screen}>
      <Text accessibilityRole="header" style={styles.title}>
        That page isn't here.
      </Text>
      <Text style={styles.body}>Your notes are safe. Return to Today to keep working.</Text>
      <Link accessibilityRole="link" href="/" style={styles.link}>
        Back to Today
      </Link>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { color: nativeTheme.color.textSecondary, fontSize: 16, lineHeight: 24, marginTop: 8 },
  link: { color: nativeTheme.color.accent, fontSize: 16, fontWeight: "600", marginTop: 24 },
  screen: {
    backgroundColor: nativeTheme.color.canvas,
    flex: 1,
    justifyContent: "center",
    padding: 32
  },
  title: { color: nativeTheme.color.textPrimary, fontSize: 28, fontWeight: "600" }
});
