"use client";

import { ArrowRightIcon, ArrowUUpLeftIcon } from "@phosphor-icons/react";
import { useRouter } from "next/navigation";
import { type SyntheticEvent, useEffect, useRef, useState } from "react";

import {
  browserApi,
  productErrorMessage,
  productRetryAfterSeconds
} from "@/lib/product/browser-api";

type Step = "email" | "code";

export function authSubmitDisabled(
  step: Step,
  pending: boolean,
  resendAfter: number,
  codeLength: number
): boolean {
  return pending || (step === "email" ? resendAfter > 0 : codeLength !== 6);
}

export function AuthForm() {
  const router = useRouter();
  const codeInput = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resendAfter, setResendAfter] = useState(0);

  useEffect(() => {
    if (step === "code") codeInput.current?.focus();
  }, [step]);

  useEffect(() => {
    if (resendAfter < 1) return;
    const timer = window.setInterval(
      () => setResendAfter((value) => Math.max(0, value - 1)),
      1_000
    );
    return () => window.clearInterval(timer);
  }, [resendAfter]);

  async function requestCode(): Promise<void> {
    setPending(true);
    setError(null);
    try {
      const response = await browserApi.requestOtp({ email });
      setStep("code");
      setResendAfter(
        "retryAfterSeconds" in response && typeof response.retryAfterSeconds === "number"
          ? response.retryAfterSeconds
          : 0
      );
    } catch (reason) {
      setError(productErrorMessage(reason, "The sign-in email could not be sent. Try again."));
      setResendAfter(productRetryAfterSeconds(reason) ?? 0);
    } finally {
      setPending(false);
    }
  }

  async function submit(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (step === "email") {
      await requestCode();
      return;
    }
    setPending(true);
    setError(null);
    try {
      await browserApi.verifyOtp({ code, email });
      router.replace("/app");
      router.refresh();
    } catch (reason) {
      setError(productErrorMessage(reason, "That code could not be verified. Try again."));
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="mt-10" noValidate>
      {step === "email" ? (
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
        </div>
      ) : (
        <div>
          <button
            type="button"
            onClick={() => {
              setStep("email");
              setCode("");
              setError(null);
            }}
            className="inline-flex min-h-11 items-center gap-2 text-sm text-muted-content hover:text-content"
          >
            <ArrowUUpLeftIcon size={16} aria-hidden="true" />
            {email}
          </button>
          <label htmlFor="code" className="field-label mt-5">
            Six-digit code
          </label>
          <input
            ref={codeInput}
            id="code"
            name="code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            required
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/gu, "").slice(0, 6))}
            placeholder="000000"
            className="editor-control auth-code mt-2"
          />
        </div>
      )}

      <div aria-live="polite" className="min-h-12 pt-3 text-sm text-critical">
        {error}
      </div>

      <button
        type="submit"
        disabled={authSubmitDisabled(step, pending, resendAfter, code.length)}
        className="button-primary w-full disabled:cursor-wait disabled:opacity-55"
      >
        {pending
          ? "Working…"
          : resendAfter > 0 && step === "email"
            ? `Try again in ${resendAfter}s`
            : step === "email"
              ? "Send sign-in code"
              : "Open Unfiled"}
        {pending ? null : <ArrowRightIcon size={17} weight="bold" aria-hidden="true" />}
      </button>

      {step === "code" ? (
        <button
          type="button"
          disabled={pending || resendAfter > 0}
          onClick={() => void requestCode()}
          className="mt-3 min-h-11 w-full text-sm text-muted-content hover:text-content disabled:opacity-50"
        >
          {resendAfter > 0 ? `Send another code in ${resendAfter}s` : "Send another code"}
        </button>
      ) : null}
    </form>
  );
}
