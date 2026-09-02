import type { MetadataRoute } from "next";

import { canonicalSiteUrl, publicInformationRoutes } from "@/lib/public-site";

export default function sitemap(): MetadataRoute.Sitemap {
  const siteUrl = canonicalSiteUrl();

  return [
    {
      url: siteUrl,
      changeFrequency: "monthly",
      priority: 1
    },
    ...publicInformationRoutes.map((route) => ({
      url: siteUrl + route,
      changeFrequency: "monthly" as const,
      priority: route === "/support" ? 0.6 : 0.4
    }))
  ];
}
