import { readFileSync } from "node:fs";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { DESK_DESTINATIONS, DeskDock, isDeskDestinationActive } from "./desk-navigation";
import { DeskLibraryMenu, DeskSettingsButton } from "./desk-menu";

vi.mock("next/navigation", () => ({
  usePathname: () => "/app",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() })
}));

const responsiveCss = readFileSync(
  new URL("../../app/globals-responsive.css", import.meta.url),
  "utf8"
);
const deskCss = readFileSync(new URL("../../app/desk.css", import.meta.url), "utf8");

describe("the Desk navigation", () => {
  it("is two destinations and one action", () => {
    expect(DESK_DESTINATIONS.map((destination) => destination.label)).toEqual(["Inbox", "Library"]);
    // Review and Search are no longer tabs (ADR-0019, decision 6).
    expect(DESK_DESTINATIONS.map((destination) => destination.href)).not.toContain("/app/review");
    expect(DESK_DESTINATIONS.map((destination) => destination.href)).not.toContain("/app/search");
  });

  it("marks only the destination the owner is on", () => {
    expect(isDeskDestinationActive("/app", "/app", true)).toBe(true);
    expect(isDeskDestinationActive("/app/library", "/app", true)).toBe(false);
    expect(isDeskDestinationActive("/app/library/anything", "/app/library", false)).toBe(true);
  });

  it("keeps the dock on screen at phone width", () => {
    // The old bar was hidden by `.desktop-nav { display: none }` below 48rem and the mobile bar
    // held no account entry, so /app/settings — where the provider key is saved — was reachable
    // only after a capture had already failed.
    const dockRule = /\.desk-dock \{(?<body>[^}]*)\}/u.exec(deskCss)?.groups?.body;
    expect(dockRule).toContain("position: fixed");
    expect(dockRule).not.toContain("display: none");

    // The rail replaces the dock only once there is room for it; nothing hides both.
    const wideRules = /@media \(min-width: 48rem\) \{(?<body>[\s\S]*?)\n\}/u.exec(responsiveCss)
      ?.groups?.body;
    expect(wideRules).toContain(".desk-rail {\n    display: flex;");
    expect(wideRules).toContain(".desk-dock {\n    display: none;");
  });

  it("offers the composer and both destinations from the dock", () => {
    const html = renderToStaticMarkup(<DeskDock />);

    expect(html).toContain('href="/app"');
    expect(html).toContain('href="/app/library"');
    expect(html).toContain('aria-label="Write something"');
    expect(html).toContain('aria-current="page"');
  });

  it("puts Settings in the Inbox header, where no breakpoint can hide it", () => {
    const html = renderToStaticMarkup(<DeskSettingsButton />);

    expect(html).toContain('href="/app/settings"');
    expect(html).toContain('aria-label="Settings"');
  });

  it("keeps only the archive and the recovery window in the Library header", () => {
    // The phone's menu carries two rows. Settings is one tap from the Inbox and sign-out lives
    // in Settings, so the menu does not repeat what the rail and the dock already reach.
    const html = renderToStaticMarkup(<DeskLibraryMenu />);

    expect(html).toContain('href="/app/archive"');
    expect(html).toContain('href="/app/archive#recently-deleted"');
    expect(html).not.toContain('href="/app/settings"');
    expect(html).not.toContain("Sign out");
  });
});
