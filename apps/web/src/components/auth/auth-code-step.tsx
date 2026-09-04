import type { SyntheticEvent } from "react";

import { UnfiledGlyph } from "@/components/product/unfiled-glyph";

import {
  VERIFICATION_CODE_EXPLANATION,
  VERIFICATION_CODE_LENGTH,
  verificationCodeComplete
} from "./auth-form-rules";

export type AuthCodeStepProps = Readonly<{
  code: string;
  error: string | null;
  notice: string | null;
  onCodeChange: (value: string) => void;
  onResend: () => void;
  onStartOver: () => void;
  onSubmit: () => void;
  pending: boolean;
  resending: boolean;
}>;

/**
 * The six digits an owner was emailed. The field carries the one-time-code hint so the keyboard
 * offers the code from the message, and a whole code submits itself: reading six digits across
 * from another app and then hunting for a button is the part people give up on.
 */
export function AuthCodeStep({
  code,
  error,
  notice,
  onCodeChange,
  onResend,
  onStartOver,
  onSubmit,
  pending,
  resending
}: AuthCodeStepProps) {
  function submit(event: SyntheticEvent<HTMLFormElement>): void {
    event.preventDefault();
    onSubmit();
  }

  return (
    <form onSubmit={submit} className="mt-10" noValidate>
      <label htmlFor="verification-code" className="field-label">
        Six-digit code
      </label>
      <input
        id="verification-code"
        name="verification-code"
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        autoFocus
        required
        maxLength={VERIFICATION_CODE_LENGTH}
        minLength={VERIFICATION_CODE_LENGTH}
        pattern="[0-9]{6}"
        value={code}
        onChange={(event) => onCodeChange(event.target.value)}
        aria-describedby="auth-code-note auth-feedback"
        className="editor-control auth-code mt-2"
      />
      <p id="auth-code-note" className="auth-note">
        {VERIFICATION_CODE_EXPLANATION}
      </p>
      <div aria-live="polite" className="auth-notice">
        {notice}
      </div>
      <div aria-live="polite" className="auth-feedback" id="auth-feedback">
        {error}
      </div>
      <div className="auth-actions">
        <button
          type="submit"
          disabled={pending || !verificationCodeComplete(code)}
          className="button-primary w-full disabled:cursor-wait disabled:opacity-55"
        >
          {pending ? "Checking…" : "Confirm email"}
          {pending ? null : <UnfiledGlyph glyph="arrow" size={17} weight={2.2} />}
        </button>
        <button
          type="button"
          disabled={pending || resending}
          onClick={onResend}
          className="button-secondary w-full disabled:opacity-55"
        >
          {resending ? "Sending…" : "Email another code"}
        </button>
        <button
          type="button"
          disabled={pending || resending}
          onClick={onStartOver}
          className="quiet-button w-full justify-center"
        >
          Use a different email address
        </button>
      </div>
    </form>
  );
}
