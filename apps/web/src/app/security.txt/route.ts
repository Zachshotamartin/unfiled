import { securityReportUrl } from "@/lib/public-site";

const securityText = [
  "Contact: " + securityReportUrl,
  "Expires: 2027-08-31T23:59:59Z",
  "Preferred-Languages: en",
  "Canonical: https://unfiled.app/.well-known/security.txt",
  "Policy: https://unfiled.app/security"
].join("\n");

export function GET(): Response {
  return new Response(securityText + "\n", {
    status: 200,
    headers: {
      "Cache-Control": "public, max-age=3600",
      "Content-Type": "text/plain; charset=utf-8"
    }
  });
}
