import type { MetadataRoute } from "next";

import { canonicalSiteUrl } from "@/lib/public-site";

export default function robots(): MetadataRoute.Robots {
  const siteUrl = canonicalSiteUrl();

  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/api/", "/app", "/auth"]
    },
    sitemap: siteUrl + "/sitemap.xml"
  };
}
