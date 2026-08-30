import { color, motion, radius, spacing, typography } from "@unfiled/design-tokens";

export const nativeTheme = {
  color,
  motion,
  radius,
  spacing,
  typography,
  fontFamily: {
    mono: "ui-monospace",
    sans: "System"
  }
} as const;

export type NativeTheme = typeof nativeTheme;
