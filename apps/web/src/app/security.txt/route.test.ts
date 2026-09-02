import { describe, expect, it } from "vitest";

import { securityReportUrl } from "@/lib/public-site";

import { GET } from "./route";

describe("GET /.well-known/security.txt", () => {
  it("publishes a standards-shaped private reporting path", async () => {
    const response = GET();
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(body).toContain("Contact: " + securityReportUrl);
    expect(body).toContain("Expires: 2027-08-31T23:59:59Z");
    expect(body).toContain("Canonical: https://unfiled.app/.well-known/security.txt");
    expect(body).toContain("Policy: https://unfiled.app/security");
    expect(body.endsWith("\n")).toBe(true);
  });
});
