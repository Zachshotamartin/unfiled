import {
  allowlistedCaptureSource,
  isNativeCaptureSource,
  type NativeCaptureSource
} from "./captureSource";

const SAFE_FALLBACK_ROUTE = "/";
const CAPTURE_ROUTE_ALIASES = new Set(["capture", "new", "quick-capture", "widget"]);
const KNOWN_SCHEMES = new Set(["unfiled", "unfiled-dev", "unfiled-preview"]);

interface ParsedIntent {
  route: string;
  source: string | undefined;
}

function parseIntent(path: string): ParsedIntent | null {
  const trimmed = path.trim();
  if (trimmed.length === 0) return null;

  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed)) {
      const url = new URL(trimmed);
      if (!KNOWN_SCHEMES.has(url.protocol.slice(0, -1))) return null;
      const route = (url.hostname || url.pathname).replace(/^\/+|\/+$/gu, "");
      return { route, source: url.searchParams.get("source") ?? undefined };
    }

    const url = new URL(trimmed.startsWith("/") ? trimmed : `/${trimmed}`, "https://unfiled.local");
    return {
      route: url.pathname.replace(/^\/+|\/+$/gu, ""),
      source: url.searchParams.get("source") ?? undefined
    };
  } catch {
    return null;
  }
}

export function canonicalCaptureRoute(source: NativeCaptureSource): string {
  return `/capture?source=${encodeURIComponent(source)}`;
}

export function rewriteNativeIntent(path: string): string {
  const parsed = parseIntent(path);
  if (parsed === null || !CAPTURE_ROUTE_ALIASES.has(parsed.route)) return SAFE_FALLBACK_ROUTE;

  const source = isNativeCaptureSource(parsed.source)
    ? parsed.source
    : allowlistedCaptureSource(undefined, "ios_lock_screen_widget");
  return canonicalCaptureRoute(source);
}
