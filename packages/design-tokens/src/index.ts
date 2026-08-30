export const color = {
  canvas: "#0B0C0E",
  surface: "#181B1F",
  surfaceRaised: "#22262A",
  border: "rgba(242, 239, 232, 0.14)",
  textPrimary: "#F2EFE8",
  textSecondary: "#9DA3A6",
  textDisabled: "rgba(157, 163, 166, 0.55)",
  accent: "#EE6F55",
  accentContrast: "#0B0C0E",
  danger: "#D96868",
  warning: "#D6A15C",
  generatedSurface: "#2B2020"
} as const;

export const spacing = [0, 4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80] as const;

export const radius = {
  input: 10,
  button: 10,
  container: 12,
  sheet: 16,
  circular: 999
} as const;

export const typography = {
  display: { fontSize: 28, lineHeight: 34, fontWeight: 600 },
  title: { fontSize: 22, lineHeight: 28, fontWeight: 600 },
  heading: { fontSize: 17, lineHeight: 24, fontWeight: 600 },
  body: { fontSize: 16, lineHeight: 24, fontWeight: 400 },
  secondary: { fontSize: 14, lineHeight: 20, fontWeight: 400 },
  caption: { fontSize: 12, lineHeight: 16, fontWeight: 500 }
} as const;

export const motion = {
  duration: {
    immediate: 0,
    press: 150,
    layout: 200,
    receipt: 250,
    maximum: 300
  },
  easing: {
    standard: [0.16, 1, 0.3, 1] as const
  }
} as const;

export const zIndex = {
  base: 0,
  rail: 10,
  sticky: 20,
  sheet: 30,
  dialog: 40,
  toast: 50
} as const;

function linearChannel(channel: number): number {
  const normalized = channel / 255;
  return normalized <= 0.04045 ? normalized / 12.92 : Math.pow((normalized + 0.055) / 1.055, 2.4);
}

function luminance(hex: string): number {
  const value = hex.replace("#", "");
  if (!/^[0-9A-F]{6}$/iu.test(value)) throw new TypeError("Expected a six-digit hex color");
  const channels = [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16));
  const red = linearChannel(channels[0] ?? 0);
  const green = linearChannel(channels[1] ?? 0);
  const blue = linearChannel(channels[2] ?? 0);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

export function contrastRatio(foreground: string, background: string): number {
  const first = luminance(foreground);
  const second = luminance(background);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

export const designTokens = { color, motion, radius, spacing, typography, zIndex } as const;
