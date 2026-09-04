"use client";

import { useRouter } from "next/navigation";

import type { SessionUser } from "@/lib/product/types";
import { useLiveResource } from "@/lib/product/use-live-resource";

import { AccountDataControls } from "./account-data-controls";
import { AiSettings } from "./ai-settings";
import { ResourceError, ResourceSkeleton } from "./resource-states";
import { RoutingRulesSettings } from "./routing-rules-settings";
import { UnfiledGlyph } from "./unfiled-glyph";

export type SettingsViewProps = Readonly<{
  /** True only when this deployment provides an app-funded provider credential. */
  managedFallbackAvailable?: boolean;
}>;

/**
 * The settings body, separated from the session fetch so what the owner reads can be rendered
 * and asserted directly. There is no "Private manual notes" section: ADR-0021 removed the mode
 * from the product, so teaching a workflow around it would describe something that no longer
 * exists.
 */
export function SettingsSections({
  email,
  managedFallbackAvailable,
  onSignOut
}: Readonly<{
  email: string | null;
  managedFallbackAvailable: boolean;
  onSignOut: () => void;
}>) {
  return (
    <div className="border-t border-outline">
      <section className="settings-row">
        <div>
          <h2 className="text-lg font-medium">Account</h2>
          <p className="mt-2 text-sm text-muted-content">{email}</p>
        </div>
        <button type="button" className="button-secondary" onClick={onSignOut}>
          <UnfiledGlyph glyph="arrow" size={17} weight={2} /> Sign out
        </button>
      </section>
      <AiSettings managedFallbackAvailable={managedFallbackAvailable} />
      <RoutingRulesSettings />
      <AccountDataControls />
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
    <SettingsSections
      email={session.data?.user.email ?? null}
      managedFallbackAvailable={managedFallbackAvailable}
      onSignOut={() => void signOut()}
    />
  );
}
