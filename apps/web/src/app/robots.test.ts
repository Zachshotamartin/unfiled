import { afterEach, describe, expect, it } from "vitest";

import robots from "./robots";

const originalSiteUrl = process.env.NEXT_PUBLIC_SITE_URL;

afterEach(() => {
  if (originalSiteUrl === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
  else process.env.NEXT_PUBLIC_SITE_URL = originalSiteUrl;
});

describe("robots policy", () => {
  it("allows public information while excluding private product and API surfaces", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://unfiled.app/";

    expect(robots()).toEqual({
      rules: {
        userAgent: "*",
        allow: "/",
        disallow: ["/api/", "/app", "/auth"]
      },
      sitemap: "https://unfiled.app/sitemap.xml"
    });
  });
});
