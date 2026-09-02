import { loadWebReleaseIdentity, releaseIdentityHeaders } from "@/server/release/release-identity";

export const dynamic = "force-dynamic";

export function GET() {
  try {
    return Response.json(
      {
        service: "unfiled-web",
        status: "ok"
      },
      { headers: releaseIdentityHeaders(loadWebReleaseIdentity()) }
    );
  } catch {
    return Response.json(
      { service: "unfiled-web", status: "unavailable" },
      { headers: releaseIdentityHeaders(null), status: 503 }
    );
  }
}
