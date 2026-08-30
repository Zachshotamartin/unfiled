"use client";

import {
  ArchiveTrayIcon,
  ArrowsClockwiseIcon,
  GearSixIcon,
  MagnifyingGlassIcon,
  NoteIcon,
  SignOutIcon,
  SquaresFourIcon,
  TrayIcon
} from "@phosphor-icons/react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { ReactNode } from "react";

import { BrandLogo } from "@/components/brand-logo";

const items: readonly Readonly<{
  exact?: boolean;
  href: string;
  icon: ReactNode;
  label: string;
}>[] = [
  { exact: true, href: "/app", icon: <TrayIcon size={21} />, label: "Today" },
  { href: "/app/notes", icon: <NoteIcon size={21} />, label: "Notes" },
  { href: "/app/spaces", icon: <SquaresFourIcon size={21} />, label: "Spaces" },
  { href: "/app/review", icon: <ArrowsClockwiseIcon size={21} />, label: "Review" },
  { href: "/app/search", icon: <MagnifyingGlassIcon size={21} />, label: "Search" }
];

function isActive(pathname: string, href: string, exact = false): boolean {
  return exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
}

function DesktopItem({ exact = false, href, icon, label }: (typeof items)[number]) {
  const pathname = usePathname();
  const active = isActive(pathname, href, exact);
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`app-nav-item ${active ? "app-nav-item-active" : ""}`}
    >
      {active ? <span className="app-nav-marker" aria-hidden="true" /> : null}
      <span className="shrink-0" aria-hidden="true">
        {icon}
      </span>
      <span className="hidden xl:inline">{label}</span>
      <span className="sr-only xl:hidden">{label}</span>
    </Link>
  );
}

async function signOut(router: ReturnType<typeof useRouter>): Promise<void> {
  await fetch("/api/v1/auth/sign-out", { method: "POST" }).catch(() => undefined);
  router.replace("/auth");
  router.refresh();
}

export function DesktopAppNavigation() {
  const router = useRouter();
  return (
    <aside className="desktop-nav">
      <div className="hidden xl:block">
        <BrandLogo href="/app" />
      </div>
      <div className="mx-auto xl:hidden">
        <BrandLogo compact href="/app" />
      </div>
      <nav aria-label="App navigation" className="mt-12 grid gap-1">
        {items.map((item) => (
          <DesktopItem key={item.href} {...item} />
        ))}
      </nav>
      <nav
        aria-label="Library controls"
        className="mt-auto grid gap-1 border-t border-outline pt-4"
      >
        <DesktopItem href="/app/archive" label="Archive" icon={<ArchiveTrayIcon size={21} />} />
        <DesktopItem href="/app/settings" label="Settings" icon={<GearSixIcon size={21} />} />
        <button
          type="button"
          onClick={() => void signOut(router)}
          className="app-nav-item text-muted-content hover:text-content"
        >
          <SignOutIcon size={21} aria-hidden="true" />
          <span className="hidden xl:inline">Sign out</span>
          <span className="sr-only xl:hidden">Sign out of Unfiled</span>
        </button>
      </nav>
    </aside>
  );
}

export function MobileAppNavigation() {
  const pathname = usePathname();
  return (
    <nav aria-label="Mobile app navigation" className="mobile-nav">
      {items.map((item) => {
        const active = isActive(pathname, item.href, item.exact);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={`mobile-nav-item ${active ? "text-content" : "text-muted-content"}`}
          >
            <span aria-hidden="true">{item.icon}</span>
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
