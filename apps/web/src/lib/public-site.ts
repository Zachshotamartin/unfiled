export const publicInformationRoutes = [
  "/privacy",
  "/terms",
  "/security",
  "/support",
  "/account-deletion"
] as const;

export const repositoryUrl = "https://github.com/Zachshotamartin/unfiled";
export const supportRequestUrl = `${repositoryUrl}/issues/new?template=support.yml`;
export const securityReportUrl = `${repositoryUrl}/security/advisories/new`;

export function canonicalSiteUrl(value = process.env.NEXT_PUBLIC_SITE_URL): string {
  return (value ?? "http://localhost:3000").replace(/\/+$/, "");
}
