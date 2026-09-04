/**
 * The mark, drawn from the same geometry as the phone's `UnfiledMark`
 * (apps/ios/Shared/BrandMark.swift): an intake tray in ink with square-capped strokes, and a
 * card tilted 14° dropping into it in the one accent. The colors follow the ground: the tray
 * takes `currentColor`, the card takes the accent token, so the mark sits on any Paper surface
 * without a second asset. Decorative wherever it appears; the wordmark or link label carries
 * the name.
 */
export function BrandMark({
  size = 32,
  className
}: Readonly<{ size?: number; className?: string }>) {
  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <path
        d="M13 34V74.6Q13 92 50 92Q87 92 87 74.6V34"
        fill="none"
        stroke="currentColor"
        strokeWidth="16"
        strokeLinecap="square"
        strokeLinejoin="round"
      />
      <rect
        x="50.5"
        y="9"
        width="19"
        height="42"
        rx="2.5"
        fill="var(--color-accent)"
        transform="rotate(14 60 30)"
      />
    </svg>
  );
}
