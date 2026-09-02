import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { AuthForm } from "./auth-form";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() })
}));

describe("AuthForm layout", () => {
  it("keeps labels above their fields and the submit action in its own region", () => {
    const html = renderToStaticMarkup(<AuthForm />);

    const emailLabel = html.indexOf('for="email"');
    const emailInput = html.indexOf('id="email"');
    const passwordLabel = html.indexOf('for="password"');
    const passwordInput = html.indexOf('id="password"');
    const feedback = html.indexOf('class="auth-feedback"');
    const actions = html.indexOf('class="auth-actions"');
    const submit = html.indexOf('type="submit"');

    expect(emailLabel).toBeGreaterThan(-1);
    expect(emailInput).toBeGreaterThan(emailLabel);
    expect(passwordLabel).toBeGreaterThan(emailInput);
    expect(passwordInput).toBeGreaterThan(passwordLabel);
    expect(feedback).toBeGreaterThan(passwordInput);
    expect(actions).toBeGreaterThan(feedback);
    expect(submit).toBeGreaterThan(actions);
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("Sign in");
    expect(html).toContain("Create an account");
    expect(html).not.toContain("code");
    expect(html).toMatch(/<input[^>]*type="password"[^>]*autocomplete="current-password"/iu);
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*class="button-primary w-full/u);
  });

  it("starts in account creation when asked and never renders the submit button adjacent to an input", () => {
    const html = renderToStaticMarkup(<AuthForm initialMode="sign-up" />);

    expect(html).toContain("Create account");
    expect(html).toMatch(/autocomplete="new-password"/iu);
    expect(html).not.toMatch(/<\/input>\s*<button/u);
    expect(html).not.toMatch(/<input[^>]*\/?>\s*<button/u);
  });
});
