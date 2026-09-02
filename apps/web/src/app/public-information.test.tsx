import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import AccountDeletionPage from "./account-deletion/page";
import PrivacyPage from "./privacy/page";
import SecurityPage from "./security/page";
import SupportPage from "./support/page";
import TermsPage from "./terms/page";

const pages = [
  {
    name: "privacy",
    page: PrivacyPage,
    expected: ["not end-to-end encrypted", "Private manual", "30-day backup window"]
  },
  {
    name: "terms",
    page: TermsPage,
    expected: ["Your content stays yours", "AI output requires judgment", "private beta"]
  },
  {
    name: "security",
    page: SecurityPage,
    expected: [
      "application encryption at rest",
      "GitHub private vulnerability reporting",
      "Good-faith research"
    ]
  },
  {
    name: "support",
    page: SupportPage,
    expected: ["GitHub issues are public", "Protect private data", "Lock Screen widget"]
  },
  {
    name: "account deletion",
    page: AccountDeletionPage,
    expected: ["Type DELETE exactly", "Every active authentication session", "30 days"]
  }
] as const;

describe.each(pages)("$name public page", ({ page: Page, expected }) => {
  it("renders the shared trust surface and required disclosure", () => {
    const html = renderToStaticMarkup(<Page />);

    expect(html).toContain('id="main-content"');
    expect(html).toContain('aria-label="Primary navigation"');
    expect(html).toContain('aria-label="Trust and support links"');
    expect(html).toContain('href="/privacy"');
    expect(html).toContain('href="/terms"');
    expect(html).toContain('href="/security"');
    expect(html).toContain('href="/support"');
    expect(html).toContain('href="/account-deletion"');
    for (const text of expected) expect(html).toContain(text);
  });
});

describe("public information copy", () => {
  it("does not use typography characters prohibited by the web design system", () => {
    const html = pages.map(({ page: Page }) => renderToStaticMarkup(<Page />)).join("");

    expect(html).not.toMatch(/[–—]/u);
  });
});
