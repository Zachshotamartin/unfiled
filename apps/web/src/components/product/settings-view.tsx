"use client";

import { SignOutIcon } from "@phosphor-icons/react";
import { useRouter } from "next/navigation";

import type { SessionUser } from "@/lib/product/types";
import { useLiveResource } from "@/lib/product/use-live-resource";

import { ResourceError, ResourceSkeleton } from "./resource-states";
import { AiSettings } from "./ai-settings";
import { AccountDataControls } from "./account-data-controls";
import { RoutingRulesSettings } from "./routing-rules-settings";

export type SettingsViewProps = Readonly<{
  /** True only when this deployment provides an app-funded provider credential. */
  managedFallbackAvailable?: boolean;
}>;

export function SettingsView({ managedFallbackAvailable = false }: SettingsViewProps = {}) {
  const router = useRouter();
  const session = useLiveResource<{ user: SessionUser }>("/api/v1/auth/session");
  async function signOut(): Promise<void> {
    await fetch("/api/v1/auth/sign-out", { method: "POST" });
    router.replace("/auth");
    router.refresh();
  }
  if (session.loading && session.data === null) return <ResourceSkeleton rows={2} />;
  if (session.error !== null && session.data === null)
    return (
      <ResourceError
        message={session.error}
        offline={session.offline}
        retry={() => void session.refresh()}
      />
    );
  return (
    <div className="border-t border-outline">
      <section className="settings-row">
        <div>
          <h2 className="text-lg font-medium">Account</h2>
          <p className="mt-2 text-sm text-muted-content">{session.data?.user.email}</p>
        </div>
        <button type="button" className="button-secondary" onClick={() => void signOut()}>
          <SignOutIcon size={17} /> Sign out
        </button>
      </section>
      <AiSettings managedFallbackAvailable={managedFallbackAvailable} />
      <RoutingRulesSettings />
      <AccountDataControls />
      <section className="settings-row">
        <div>
          <h2 className="text-lg font-medium">Private manual notes</h2>
          <p className="mt-2 max-w-xl text-sm leading-6 text-muted-content">
            Choose “Private manual” in an editor to keep that note outside AI-assisted organization.
            Manual edits and revision history still work.
          </p>
        </div>
      </section>
      <section className="settings-row">
        <div>
          <h2 className="text-lg font-medium">Sync</h2>
          <p className="mt-2 max-w-xl text-sm leading-6 text-muted-content">
            This web app and the iPhone app use the same account and backend. Open views refresh
            when another device changes your library.
          </p>
        </div>
      </section>
    </div>
  );
}
