"use client";

import { useRouter } from "next/navigation";
import { type SyntheticEvent, useState } from "react";

import { UnfiledGlyph } from "@/components/product/unfiled-glyph";
import { browserApi } from "@/lib/product/browser-api";

import { AuthCodeStep } from "./auth-code-step";
import {
  authSubmitDisabled,
  MAXIMUM_PASSWORD_LENGTH,
  MINIMUM_PASSWORD_LENGTH,
  requestAnotherCode,
  submitCredentials,
  submitVerificationCode,
  verificationCodeChange,
  verificationCodeComplete,
  type AuthMode
} from "./auth-form-rules";

export function AuthForm({ initialMode = "sign-in" }: Readonly<{ initialMode?: AuthMode }>) {
  const router = useRouter();
  const [mode, setMode] = useState<AuthMode>(initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  // The address a code was emailed to, and the only thing that puts the form on its code step.
  const [awaitingCode, setAwaitingCode] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [resending, setResending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function enterLibrary(): void {
    router.replace("/app");
    router.refresh();
  }

  async function submit(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (authSubmitDisabled(pending, email, password)) return;
    setPending(true);
    setError(null);
    const outcome = await submitCredentials(browserApi, mode, email, password);
    setPending(false);
    if (outcome.status === "refused") {
      setError(outcome.message);
      return;
    }
    // A deployment that confirms addresses has emailed a code instead of opening a session. The
    // account exists either way, so nothing here is a failure to report.
    if (outcome.status === "code-required") {
      setAwaitingCode(outcome.email);
      setPassword("");
      return;
    }
    enterLibrary();
  }

  async function confirm(entered: string): Promise<void> {
    if (pending || awaitingCode === null || !verificationCodeComplete(entered)) return;
    setPending(true);
    setError(null);
    setNotice(null);
    const outcome = await submitVerificationCode(browserApi, awaitingCode, entered);
    setPending(false);
    if (outcome.status === "refused") {
      setError(outcome.message);
      return;
    }
    enterLibrary();
  }

  function changeCode(value: string): void {
    const change = verificationCodeChange(value);
    setCode(change.code);
    if (change.send) void confirm(change.code);
  }

  async function resend(): Promise<void> {
    if (resending || pending || awaitingCode === null) return;
    setResending(true);
    setError(null);
    setNotice(null);
    const outcome = await requestAnotherCode(browserApi, awaitingCode);
    setResending(false);
    setCode("");
    if (outcome.status === "refused") setError(outcome.message);
    else setNotice(outcome.message);
  }

  function startOver(): void {
    setAwaitingCode(null);
    setCode("");
    setError(null);
    setNotice(null);
  }

  function switchMode(): void {
    setMode((current) => (current === "sign-in" ? "sign-up" : "sign-in"));
    setError(null);
  }

  if (awaitingCode !== null) {
    return (
      <>
        <div className="auth-code-glyph">
          <UnfiledGlyph glyph="tray" size={22} weight={2.2} />
        </div>
        <p className="eyebrow mt-5">Confirm your address</p>
        <h2 id="auth-panel-title" className="auth-panel-title">
          Enter the six digits we emailed
        </h2>
        <p className="auth-panel-lede">
          Your account is created. We sent a code to {awaitingCode}; entering it opens your library.
        </p>
        <AuthCodeStep
          code={code}
          error={error}
          notice={notice}
          onCodeChange={changeCode}
          onResend={() => void resend()}
          onStartOver={startOver}
          onSubmit={() => void confirm(code)}
          pending={pending}
          resending={resending}
        />
      </>
    );
  }

  return (
    <>
      <p className="eyebrow">{mode === "sign-up" ? "Create an account" : "Sign in"}</p>
      <h2 id="auth-panel-title" className="auth-panel-title">
        Continue to your notes
      </h2>
      <p className="auth-panel-lede">
        Use your email address and password. New here? Create an account in a few seconds.
      </p>
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
            {pending ? null : <UnfiledGlyph glyph="arrow" size={17} weight={2.2} />}
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
    </>
  );
}
