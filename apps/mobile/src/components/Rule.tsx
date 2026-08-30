import type { ReactElement } from "react";
import { StyleSheet, View } from "react-native";

import { nativeTheme } from "../theme/nativeTheme";

export function Rule(): ReactElement {
  return <View style={styles.rule} />;
}

const styles = StyleSheet.create({
  rule: { backgroundColor: nativeTheme.color.border, height: StyleSheet.hairlineWidth }
});
