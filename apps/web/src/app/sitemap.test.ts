import { afterEach, describe, expect, it } from "vitest";

import { publicInformationRoutes } from "@/lib/public-site";

import sitemap from "./sitemap";

const originalSiteUrl = process.env.NEXT_PUBLIC_SITE_URL;

afterEach(() => {
  if (originalSiteUrl === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
  else process.env.NEXT_PUBLIC_SITE_URL = originalSiteUrl;
});

describe("public sitemap", () => {
  it("publishes every trust route with a normalized canonical origin", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://unfiled.app/";

    const entries = sitemap();

    expect(entries[0]?.url).toBe("https://unfiled.app");
    expect(entries.map((entry) => entry.url)).toEqual([
      "https://unfiled.app",
      ...publicInformationRoutes.map((route) => "https://unfiled.app" + route)
    ]);
  });
});
