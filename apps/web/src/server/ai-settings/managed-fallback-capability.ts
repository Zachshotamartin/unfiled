/**
 * Deployment capability flag for app-funded (managed) AI fallback.
 *
 * The web tier cannot see the organizer's provider secret, so a deployment declares the
 * capability explicitly. Anything other than an exact opt-in value reads as unavailable, which
 * keeps the free private beta from promising app-funded inference it does not have.
 */
export const MANAGED_FALLBACK_CAPABILITY_VARIABLE =
  "UNFILED_MANAGED_AI_FALLBACK_AVAILABLE" as const;

const OPT_IN_VALUES = Object.freeze(new Set(["1", "true"]));

export type ManagedFallbackEnvironment = Readonly<Record<string, string | undefined>>;

export function isManagedFallbackAvailable(
  environment: ManagedFallbackEnvironment = process.env
): boolean {
  const raw = environment[MANAGED_FALLBACK_CAPABILITY_VARIABLE];
  if (typeof raw !== "string") return false;
  return OPT_IN_VALUES.has(raw.trim().toLowerCase());
}
