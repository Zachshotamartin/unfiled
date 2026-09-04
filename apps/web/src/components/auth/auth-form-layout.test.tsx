import { readdirSync, readFileSync } from "node:fs";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { AuthCodeStep } from "./auth-code-step";
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

  it("names the panel with the heading it draws, so the step the owner is on has a name", () => {
    const html = renderToStaticMarkup(<AuthForm />);

    expect(html).toMatch(/<h2 id="auth-panel-title" class="auth-panel-title">/u);
  });
});

describe("AuthCodeStep layout", () => {
  function render(overrides: Partial<Parameters<typeof AuthCodeStep>[0]> = {}) {
    return renderToStaticMarkup(
      <AuthCodeStep
        code=""
        error={null}
        notice={null}
        onCodeChange={vi.fn()}
        onResend={vi.fn()}
        onStartOver={vi.fn()}
        onSubmit={vi.fn()}
        pending={false}
        resending={false}
        {...overrides}
      />
    );
  }

  it("offers the code from the message to the keyboard and takes digits only", () => {
    const html = render();

    expect(html).toMatch(/<input[^>]*autocomplete="one-time-code"/iu);
    expect(html).toMatch(/<input[^>]*inputmode="numeric"/iu);
    expect(html).toMatch(/<input[^>]*maxlength="6"/iu);
    expect(html).toMatch(/<input[^>]*pattern="\[0-9\]\{6\}"/iu);
  });

  it("says what a wrong or expired code means before one is ever refused", () => {
    const html = render();

    expect(html).toContain("Codes expire");
    expect(html).toContain("ask for another and enter the newest one");
    expect(html).toMatch(/<input[^>]*aria-describedby="auth-code-note auth-feedback"/iu);
    expect(html).toContain('id="auth-code-note"');
  });

  it("cannot be submitted until the field holds a whole code", () => {
    expect(render()).toMatch(/<button[^>]*type="submit"[^>]*disabled=""/u);
    expect(render({ code: "12345" })).toMatch(/<button[^>]*type="submit"[^>]*disabled=""/u);
    expect(render({ code: "123456" })).not.toMatch(/<button[^>]*type="submit"[^>]*disabled=""/u);
  });

  it("offers another code and a way back to the address field", () => {
    const html = render();

    expect(html).toContain("Email another code");
    expect(html).toContain("Use a different email address");
  });

  it("reports a sent code and a refusal in separate regions a reader is told about", () => {
    const html = render({ error: "That code is wrong or has expired.", notice: "A new code." });

    expect(html).toMatch(/<div aria-live="polite" class="auth-notice">A new code\.<\/div>/u);
    expect(html).toMatch(
      /<div aria-live="polite" class="auth-feedback" id="auth-feedback">That code is wrong or has expired\.<\/div>/u
    );
  });

  it("draws the code field in the Paper system, not a stock form control", () => {
    const html = render();

    // ADR-0019, decision 2: monospace is for literal codes, and `.auth-code` is the one rule for it.
    expect(html).toMatch(/<input[^>]*class="editor-control auth-code mt-2"/iu);
    expect(html).toContain('data-glyph="arrow"');
  });
});

describe("the auth surface", () => {
  it("leaves no stock icon set on the screens an owner signs in through", () => {
    // ADR-0019, decision 4: every icon is a tray, a card, or a stroke in the app's own hand.
    const directory = new URL(".", import.meta.url);
    const stockIconPackage = ["@phosphor-icons", "react"].join("/");
    const offenders = readdirSync(directory)
      .filter((entry) => entry.endsWith(".tsx") || entry.endsWith(".ts"))
      .filter((entry) =>
        readFileSync(new URL(entry, directory), "utf8").includes(stockIconPackage)
      );

    expect(offenders).toEqual([]);
  });
});
