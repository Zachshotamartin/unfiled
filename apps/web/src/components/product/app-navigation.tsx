import {
  ArrowsClockwiseIcon,
  MagnifyingGlassIcon,
  NoteIcon,
  SquaresFourIcon,
  TrayIcon
} from "@phosphor-icons/react/ssr";
import Link from "next/link";
import type { ReactNode } from "react";

import { BrandLogo } from "@/components/brand-logo";

interface NavItemProps {
  active?: boolean;
  icon: ReactNode;
  label: string;
}

function DisabledNavItem({ active = false, icon, label }: NavItemProps) {
  const content = (
    <>
      {active ? (
        <span
          className="absolute top-2 bottom-2 -left-3 w-1 bg-action xl:-left-4"
          aria-hidden="true"
        />
      ) : null}
      <span className="shrink-0" aria-hidden="true">
        {icon}
      </span>
      <span className="hidden xl:inline">{label}</span>
      <span className="sr-only xl:hidden">{label}</span>
    </>
  );

  if (active) {
    return (
      <Link
        href="/app"
        aria-current="page"
        className="relative flex min-h-12 w-full items-center gap-3 rounded-control bg-panel-raised px-3 text-left text-sm text-content transition-colors xl:px-4"
      >
        {content}
      </Link>
    );
  }

  return (
    <button
      type="button"
      disabled
      className="relative flex min-h-12 w-full items-center gap-3 rounded-control px-3 text-left text-sm text-muted-content transition-colors disabled:cursor-not-allowed xl:px-4"
    >
      {content}
    </button>
  );
}

export function DesktopAppNavigation() {
  return (
    <aside className="sticky top-0 hidden h-[100dvh] flex-col border-r border-outline bg-page px-3 py-5 md:flex xl:px-4">
      <div className="hidden xl:block">
        <BrandLogo />
      </div>
      <div className="mx-auto xl:hidden">
        <BrandLogo compact />
      </div>
      <nav aria-label="App navigation" className="mt-14 grid gap-2">
        <DisabledNavItem active label="Today" icon={<TrayIcon size={21} weight="regular" />} />
        <DisabledNavItem label="Notes" icon={<NoteIcon size={21} weight="regular" />} />
        <DisabledNavItem label="Spaces" icon={<SquaresFourIcon size={21} weight="regular" />} />
        <DisabledNavItem label="Review" icon={<ArrowsClockwiseIcon size={21} weight="regular" />} />
        <DisabledNavItem label="Search" icon={<MagnifyingGlassIcon size={21} weight="regular" />} />
      </nav>
      <Link
        href="/"
        className="mt-auto flex min-h-12 items-center gap-3 rounded-control border border-outline px-3 text-sm text-muted-content hover:text-content xl:px-4"
      >
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-panel-raised font-semibold text-content">
          Z
        </span>
        <span className="hidden xl:inline">Zach</span>
        <span className="sr-only xl:hidden">Back to Unfiled home</span>
      </Link>
    </aside>
  );
}

export function MobileAppNavigation() {
  return (
    <nav
      aria-label="Mobile app navigation"
      className="fixed right-0 bottom-0 left-0 z-20 grid grid-cols-5 border-t border-outline bg-page px-1 pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      <Link
        href="/app"
        aria-current="page"
        className="flex min-h-16 flex-col items-center justify-center gap-1 text-[11px] text-content"
      >
        <TrayIcon size={20} weight="bold" aria-hidden="true" />
        Today
      </Link>
      <button
        type="button"
        disabled
        className="flex min-h-16 flex-col items-center justify-center gap-1 text-[11px] text-muted-content"
      >
        <NoteIcon size={20} aria-hidden="true" />
        Notes
      </button>
      <button
        type="button"
        disabled
        className="flex min-h-16 flex-col items-center justify-center gap-1 text-[11px] text-muted-content"
      >
        <SquaresFourIcon size={20} aria-hidden="true" />
        Spaces
      </button>
      <button
        type="button"
        disabled
        className="flex min-h-16 flex-col items-center justify-center gap-1 text-[11px] text-muted-content"
      >
        <ArrowsClockwiseIcon size={20} aria-hidden="true" />
        Review
      </button>
      <button
        type="button"
        disabled
        className="flex min-h-16 flex-col items-center justify-center gap-1 text-[11px] text-muted-content"
      >
        <MagnifyingGlassIcon size={20} aria-hidden="true" />
        Search
      </button>
    </nav>
  );
}
