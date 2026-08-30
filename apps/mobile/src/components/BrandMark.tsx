import type { ReactElement } from "react";
import { StyleSheet, View } from "react-native";

import { nativeTheme } from "../theme/nativeTheme";

interface BrandMarkProps {
  monochrome?: boolean;
  size?: number;
}

export function BrandMark({ monochrome = false, size = 28 }: BrandMarkProps): ReactElement {
  const stroke = Math.max(2, Math.round(size * 0.12));
  const slipColor = monochrome ? nativeTheme.color.textPrimary : nativeTheme.color.accent;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ height: size, width: size }}
    >
      <View
        style={[
          styles.tray,
          {
            borderBottomWidth: stroke,
            borderLeftWidth: stroke,
            borderRightWidth: stroke,
            borderColor: nativeTheme.color.textPrimary,
            borderRadius: size * 0.22,
            bottom: size * 0.07,
            height: size * 0.58,
            left: size * 0.1,
            width: size * 0.8
          }
        ]}
      />
      <View
        style={[
          styles.slip,
          {
            backgroundColor: slipColor,
            height: size * 0.44,
            left: size * 0.46,
            top: size * 0.01,
            width: size * 0.2
          }
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  slip: { borderRadius: 1, position: "absolute", transform: [{ rotate: "14deg" }] },
  tray: { borderTopWidth: 0, position: "absolute" }
});
