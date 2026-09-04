"use client";

import { useRouter } from "next/navigation";
import { type ReactNode, useCallback, useEffect, useState } from "react";

import type { SessionUser } from "@/lib/product/types";

import { UnfiledGlyph } from "./unfiled-glyph";

export function AuthGate({ children }: Readonly<{ children: ReactNode }>) {
  const router = useRouter();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/v1/auth/session", { cache: "no-store" });
      if (response.status === 401) {
        router.replace("/auth");
        return;
      }
      if (!response.ok) throw new Error("session_unavailable");
      const body = (await response.json()) as { user: SessionUser };
      setUser(body.user);
    } catch {
      setError(navigator.onLine ? "Your session could not be checked." : "You’re offline.");
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <main id="main-content" aria-busy="true" className="state-page">
        <div className="skeleton-block h-4 w-24" />
        <div className="skeleton-block mt-7 h-14 w-64 max-w-full" />
        <div className="skeleton-block mt-12 h-px w-full" />
      </main>
    );
  }

  if (error !== null || user === null) {
    return (
      <main id="main-content" className="state-page">
        <UnfiledGlyph glyph="warning" size={30} weight={1.9} className="text-action" />
        <h1 className="mt-6 text-4xl font-semibold tracking-[-0.045em]">
          Can’t open your library.
        </h1>
        <p className="mt-4 text-muted-content">{error ?? "Your session has ended."}</p>
        <button type="button" className="button-secondary mt-7" onClick={() => void load()}>
          <UnfiledGlyph glyph="undo" size={17} weight={1.9} /> Retry
        </button>
      </main>
    );
  }

  return children;
}
