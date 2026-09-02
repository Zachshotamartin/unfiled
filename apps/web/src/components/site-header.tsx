import { ArrowRightIcon, ListIcon } from "@phosphor-icons/react/ssr";
import Link from "next/link";

import { BrandLogo } from "@/components/brand-logo";

const waitlistHref = "mailto:hello@unfiled.app?subject=Unfiled%20waitlist";

const navigation = [
  { href: "/#product", label: "Product" },
  { href: "/#principles", label: "Principles" }
] as const;

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-20 border-b border-outline bg-page">
      <div className="mx-auto flex h-[72px] max-w-[1440px] items-center justify-between px-4 sm:px-6 lg:px-10">
        <BrandLogo />

        <nav aria-label="Primary navigation" className="hidden items-center gap-8 md:flex">
          {navigation.map((item) => (
            <a
              key={item.href}
              href={item.href}
              className="rounded-control px-1 py-3 text-sm font-medium text-muted-content transition-colors hover:text-content"
            >
              {item.label}
            </a>
          ))}
          <Link
            href="/app"
            className="rounded-control px-1 py-3 text-sm font-medium text-muted-content transition-colors hover:text-content"
          >
            Open app
          </Link>
          <a href={waitlistHref} className="button-primary text-sm">
            Join the waitlist
            <ArrowRightIcon size={17} weight="bold" aria-hidden="true" />
          </a>
        </nav>

        <details className="relative md:hidden">
          <summary className="flex size-11 cursor-pointer items-center justify-center rounded-control border border-outline text-content">
            <ListIcon size={23} aria-hidden="true" />
            <span className="sr-only">Open navigation</span>
          </summary>
          <nav
            aria-label="Mobile navigation"
            className="absolute top-13 right-0 grid min-w-56 gap-1 rounded-frame border border-outline bg-panel p-2 shadow-[0_24px_70px_rgba(11,12,14,0.55)]"
          >
            {navigation.map((item) => (
              <a
                key={item.href}
                href={item.href}
                className="rounded-control px-4 py-3 text-sm text-content hover:bg-panel-raised"
              >
                {item.label}
              </a>
            ))}
            <Link
              href="/app"
              className="rounded-control px-4 py-3 text-sm text-content hover:bg-panel-raised"
            >
              Open app
            </Link>
            <a href={waitlistHref} className="button-primary mt-1 text-sm">
              Join the waitlist
            </a>
          </nav>
        </details>
      </div>
    </header>
  );
}
