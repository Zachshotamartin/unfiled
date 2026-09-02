import type { NextConfig } from "next";

import {
  loadWebReleaseIdentity,
  releaseIdentityHeaderEntries
} from "./src/server/release/release-identity";

const securityHeaders = [
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), browsing-topics=()"
  }
] as const;

const nextConfig: NextConfig = {
  agentRules: false,
  output: "standalone",
  poweredByHeader: false,
  reactStrictMode: true,
  transpilePackages: ["@unfiled/api-client", "@unfiled/content-crypto", "@unfiled/contracts"],
  webpack(config) {
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"]
    };

    return config;
  },
  async headers() {
    const releaseHeaders = releaseIdentityHeaderEntries(loadWebReleaseIdentity(process.env));
    const publicInformationCache = {
      key: "Cache-Control",
      value: "public, max-age=0, must-revalidate"
    };
    return [
      { source: "/(.*)", headers: [...securityHeaders, ...releaseHeaders] },
      ...["privacy", "terms", "security", "support", "account-deletion"].map((route) => ({
        source: `/${route}`,
        headers: [publicInformationCache]
      })),
      { source: "/robots.txt", headers: [publicInformationCache] },
      { source: "/sitemap.xml", headers: [publicInformationCache] },
      {
        source: "/.well-known/security.txt",
        headers: [{ key: "Cache-Control", value: "public, max-age=3600" }]
      }
    ];
  },
  async rewrites() {
    return [
      {
        source: "/.well-known/security.txt",
        destination: "/security.txt"
      }
    ];
  }
};

export default nextConfig;
