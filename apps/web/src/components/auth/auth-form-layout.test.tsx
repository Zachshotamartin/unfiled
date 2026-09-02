import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { AuthForm } from "./auth-form";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() })
}));

describe("AuthForm layout", () => {
  it("keeps the email label above its field and the submit action in its own region", () => {
    const html = renderToStaticMarkup(<AuthForm />);

    const label = html.indexOf('for="email"');
    const input = html.indexOf('id="email"');
    const feedback = html.indexOf('class="auth-feedback"');
    const actions = html.indexOf('class="auth-actions"');
    const submit = html.indexOf('type="submit"');

    expect(label).toBeGreaterThan(-1);
    expect(input).toBeGreaterThan(label);
    expect(feedback).toBeGreaterThan(input);
    expect(actions).toBeGreaterThan(feedback);
    expect(submit).toBeGreaterThan(actions);
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("Send sign-in code");
    expect(html).not.toContain("Send another code");
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*class="button-primary w-full/u);
  });

  it("never renders the submit button adjacent to the text input", () => {
    const html = renderToStaticMarkup(<AuthForm />);

    expect(html).not.toMatch(/<\/input>\s*<button/u);
    expect(html).not.toMatch(/<input[^>]*\/?>\s*<button/u);
    expect(html).toMatch(/<input[^>]*id="email"[^>]*\/?>\s*<\/div>\s*<div aria-live="polite"/u);
  });
});
