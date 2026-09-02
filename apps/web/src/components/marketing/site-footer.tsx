import Link from "next/link";

import { BrandLogo } from "@/components/brand-logo";

const productLinks = [
  { href: "/#product", label: "Product" },
  { href: "/#principles", label: "Principles" },
  { href: "/app", label: "Open app" }
] as const;

const trustLinks = [
  { href: "/privacy", label: "Privacy" },
  { href: "/terms", label: "Terms" },
  { href: "/security", label: "Security" },
  { href: "/account-deletion", label: "Delete account" }
] as const;

export function SiteFooter() {
  return (
    <footer className="border-t border-outline">
      <div className="mx-auto grid max-w-[1440px] gap-10 px-4 py-10 sm:px-6 md:grid-cols-[1fr_auto_auto] md:items-start lg:px-10">
        <div>
          <BrandLogo />
          <p className="mt-3 max-w-xs text-sm leading-6 text-muted-content">
            Unfiled is the selected launch candidate for this independent portfolio beta.
          </p>
        </div>

        <nav aria-label="Product links" className="grid content-start gap-2 text-sm">
          <p className="section-label mb-1">Product</p>
          {productLinks.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="rounded-control py-1.5 text-muted-content hover:text-content"
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <nav aria-label="Trust and support links" className="grid content-start gap-2 text-sm">
          <p className="section-label mb-1">Trust</p>
          {trustLinks.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="rounded-control py-1.5 text-muted-content hover:text-content"
            >
              {item.label}
            </Link>
          ))}
          <Link
            href="/support"
            className="rounded-control py-1.5 text-muted-content hover:text-content"
          >
            Support
          </Link>
        </nav>
      </div>
      <div className="border-t border-outline">
        <div className="mx-auto flex max-w-[1440px] flex-col gap-2 px-4 py-5 text-xs leading-5 text-muted-content sm:px-6 md:flex-row md:items-center md:justify-between lg:px-10">
          <p>© 2026 Unfiled.</p>
          <p>Write without deciding where it belongs.</p>
        </div>
      </div>
    </footer>
  );
}
