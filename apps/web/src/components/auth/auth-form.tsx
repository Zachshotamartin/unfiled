"use client";

import { ArrowRightIcon } from "@phosphor-icons/react";
import { useRouter } from "next/navigation";
import { type SyntheticEvent, useState } from "react";

import { browserApi, productErrorMessage } from "@/lib/product/browser-api";

export type AuthMode = "sign-in" | "sign-up";

export const MINIMUM_PASSWORD_LENGTH = 8;
export const MAXIMUM_PASSWORD_LENGTH = 72;

export function authSubmitDisabled(pending: boolean, email: string, password: string): boolean {
  return (
    pending ||
    email.trim().length === 0 ||
    password.length < MINIMUM_PASSWORD_LENGTH ||
    password.length > MAXIMUM_PASSWORD_LENGTH
  );
}

export function AuthForm({ initialMode = "sign-in" }: Readonly<{ initialMode?: AuthMode }>) {
  const router = useRouter();
  const [mode, setMode] = useState<AuthMode>(initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (authSubmitDisabled(pending, email, password)) return;
    setPending(true);
    setError(null);
    try {
      if (mode === "sign-up") await browserApi.signUp({ email, password });
      else await browserApi.signIn({ email, password });
      router.replace("/app");
      router.refresh();
    } catch (reason) {
      setError(
        productErrorMessage(
          reason,
          mode === "sign-up"
            ? "The account could not be created. Try again."
            : "Sign-in failed. Check your email and password."
        )
      );
    } finally {
      setPending(false);
    }
  }

  function switchMode(): void {
    setMode((current) => (current === "sign-in" ? "sign-up" : "sign-in"));
    setError(null);
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="mt-10" noValidate>
      <div>
        <label htmlFor="email" className="field-label">
          Email address
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="you@example.com"
          className="editor-control mt-2"
        />
        <label htmlFor="password" className="field-label mt-5">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete={mode === "sign-up" ? "new-password" : "current-password"}
          required
          minLength={MINIMUM_PASSWORD_LENGTH}
          maxLength={MAXIMUM_PASSWORD_LENGTH}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder={mode === "sign-up" ? "At least 8 characters" : "Your password"}
          className="editor-control mt-2"
        />
      </div>
      <div aria-live="polite" className="auth-feedback" id="auth-feedback">
        {error}
      </div>
      <div className="auth-actions">
        <button
          type="submit"
          disabled={authSubmitDisabled(pending, email, password)}
          className="button-primary w-full disabled:cursor-wait disabled:opacity-55"
        >
          {pending ? "Working…" : mode === "sign-up" ? "Create account" : "Sign in"}
          {pending ? null : <ArrowRightIcon size={17} weight="bold" aria-hidden="true" />}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={switchMode}
          className="min-h-11 w-full text-sm text-muted-content hover:text-content disabled:opacity-50"
        >
          {mode === "sign-up" ? "Have an account? Sign in" : "New here? Create an account"}
        </button>
      </div>
    </form>
  );
}
