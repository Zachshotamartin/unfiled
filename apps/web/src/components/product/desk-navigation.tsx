"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

import { BrandLogo } from "@/components/brand-logo";

import { UnfiledGlyph, type UnfiledGlyphName } from "./unfiled-glyph";

/**
 * The Desk (ADR-0019, decision 6): two destinations and one action. Review and Search are no
 * longer destinations — a review decision waits in the Inbox and search is the Library's own
 * field — so the dock carries the Inbox, the composer, and the Library and nothing else.
 */
export const DESK_DESTINATIONS: readonly Readonly<{
  exact: boolean;
  glyph: UnfiledGlyphName;
  href: string;
  label: string;
}>[] = [
  { exact: true, glyph: "inbox", href: "/app", label: "Inbox" },
  { exact: false, glyph: "library", href: "/app/library", label: "Library" }
];

/** The id of the composer's field, which the capture action puts the caret into. */
export const COMPOSER_FIELD_ID = "capture-text";

export function isDeskDestinationActive(pathname: string, href: string, exact: boolean): boolean {
  return exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
}

export async function signOutOfUnfiled(fetcher: typeof fetch = fetch): Promise<void> {
  await fetcher("/api/v1/auth/sign-out", { method: "POST" }).catch(() => undefined);
}

/**
 * The composer lives on the Inbox. On the Inbox the action puts the caret in the field; from
 * anywhere else it opens the Inbox, whose field takes focus as it mounts.
 */
function useCaptureAction(): () => void {
  const pathname = usePathname();
  const router = useRouter();
  return () => {
    if (pathname !== "/app") {
      router.push("/app");
      return;
    }
    const field = document.getElementById(COMPOSER_FIELD_ID);
    if (field instanceof HTMLTextAreaElement) {
      field.focus();
      field.scrollIntoView({ block: "center" });
    }
  };
}

function RailItem({
  exact = false,
  glyph,
  href,
  label
}: Readonly<{ exact?: boolean; glyph: UnfiledGlyphName; href: string; label: string }>) {
  const pathname = usePathname();
  const active = isDeskDestinationActive(pathname, href, exact);
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`desk-rail-item ${active ? "desk-rail-item-active" : ""}`}
    >
      <span className="shrink-0">
        <UnfiledGlyph glyph={glyph} size={22} weight={1.9} />
      </span>
      <span className="hidden xl:inline">{label}</span>
      <span className="sr-only xl:hidden">{label}</span>
    </Link>
  );
}

export function DeskRail() {
  const router = useRouter();
  const capture = useCaptureAction();
  return (
    <aside className="desk-rail">
      <div className="hidden xl:block">
        <BrandLogo href="/app" />
      </div>
      <div className="mx-auto xl:hidden">
        <BrandLogo compact href="/app" />
      </div>
      <nav aria-label="Desk" className="mt-10 grid gap-1">
        {DESK_DESTINATIONS.map((destination) => (
          <RailItem key={destination.href} {...destination} />
        ))}
        <button type="button" className="desk-rail-capture mt-1" onClick={capture}>
          <span className="shrink-0">
            <UnfiledGlyph glyph="pen" size={22} weight={2.1} />
          </span>
          <span className="hidden xl:inline">Write something</span>
          <span className="sr-only xl:hidden">Write something</span>
        </button>
      </nav>
      <nav aria-label="Account" className="mt-auto grid gap-1 border-t border-outline pt-4">
        <RailItem glyph="archive" href="/app/archive" label="Archive" />
        <RailItem glyph="sliders" href="/app/settings" label="Settings" />
        <button
          type="button"
          className="desk-rail-item"
          onClick={() => {
            void signOutOfUnfiled().then(() => {
              router.replace("/auth");
              router.refresh();
            });
          }}
        >
          <span className="shrink-0">
            <UnfiledGlyph glyph="arrow" size={22} weight={1.9} />
          </span>
          <span className="hidden xl:inline">Sign out</span>
          <span className="sr-only xl:hidden">Sign out of Unfiled</span>
        </button>
      </nav>
    </aside>
  );
}

/**
 * The dock is fixed to the bottom at every width below the rail's breakpoint, so the Library
 * and the composer are one tap away on a phone rather than behind a breakpoint that hides them.
 */
export function DeskDock() {
  const pathname = usePathname();
  const capture = useCaptureAction();
  const [inbox, library] = DESK_DESTINATIONS;
  if (inbox === undefined || library === undefined) return null;
  return (
    <nav aria-label="Desk" className="desk-dock">
      {[inbox].map((destination) => (
        <DockItem key={destination.href} destination={destination} pathname={pathname} />
      ))}
      <button
        type="button"
        className="desk-dock-capture"
        aria-label="Write something"
        onClick={capture}
      >
        <UnfiledGlyph glyph="pen" size={26} weight={2.2} />
      </button>
      {[library].map((destination) => (
        <DockItem key={destination.href} destination={destination} pathname={pathname} />
      ))}
    </nav>
  );
}

function DockItem({
  destination,
  pathname
}: Readonly<{ destination: (typeof DESK_DESTINATIONS)[number]; pathname: string }>) {
  const active = isDeskDestinationActive(pathname, destination.href, destination.exact);
  return (
    <Link
      href={destination.href}
      aria-current={active ? "page" : undefined}
      className={`desk-dock-item ${active ? "desk-dock-item-active" : ""}`}
    >
      <UnfiledGlyph glyph={destination.glyph} size={22} weight={1.9} />
      {destination.label}
    </Link>
  );
}
