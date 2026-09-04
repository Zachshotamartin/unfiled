"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";

import { signOutOfUnfiled } from "./desk-navigation";
import { UnfiledGlyph } from "./unfiled-glyph";

/**
 * The Library's trailing control (ADR-0019, decision 6): the archive, the recovery window, and
 * the account rows the dock does not carry. It is a disclosure rather than a floating menu so
 * it works at every width and needs no script to open.
 */
export function DeskLibraryMenu() {
  const router = useRouter();
  return (
    <details className="desk-menu">
      <summary className="header-icon-button" aria-label="Library actions">
        <UnfiledGlyph glyph="more" size={20} />
      </summary>
      <div className="desk-menu-list">
        <Link href="/app/archive">
          <UnfiledGlyph glyph="archive" size={18} weight={1.9} /> Archive
        </Link>
        <Link href="/app/archive#recently-deleted">
          <UnfiledGlyph glyph="trash" size={18} weight={1.9} /> Recently deleted
        </Link>
        <Link href="/app/settings">
          <UnfiledGlyph glyph="sliders" size={18} weight={1.9} /> Settings
        </Link>
        <button
          type="button"
          onClick={() => {
            void signOutOfUnfiled().then(() => {
              router.replace("/auth");
              router.refresh();
            });
          }}
        >
          <UnfiledGlyph glyph="arrow" size={18} weight={1.9} /> Sign out
        </button>
      </div>
    </details>
  );
}

/** The Inbox's trailing control: the key entry lives in Settings, one tap from the first screen. */
export function DeskSettingsButton() {
  return (
    <Link className="header-icon-button" href="/app/settings" aria-label="Settings">
      <UnfiledGlyph glyph="sliders" size={20} />
    </Link>
  );
}
