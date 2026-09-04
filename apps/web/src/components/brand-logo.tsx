import Link from "next/link";

import { BrandMark } from "./brand-mark";

interface BrandLogoProps {
  compact?: boolean;
  href?: string;
}

export function BrandLogo({ compact = false, href = "/" }: BrandLogoProps) {
  return (
    <Link
      href={href}
      aria-label="Unfiled home"
      className="inline-flex min-h-11 items-center gap-2.5 rounded-control font-semibold text-content"
    >
      <BrandMark size={32} />
      {compact ? null : <span className="text-xl tracking-[-0.04em]">unfiled</span>}
    </Link>
  );
}
