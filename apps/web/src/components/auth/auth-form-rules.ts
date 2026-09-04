import { authVerificationRequired } from "@unfiled/api-client";
import type {
  AuthPasswordSignInRequest,
  AuthPasswordSignUpRequest,
  AuthResendRequest,
  AuthResendResponse,
  AuthSession,
  AuthSignUpResponse,
  AuthVerifyRequest
} from "@unfiled/contracts";

import { productErrorMessage } from "@/lib/product/browser-api";

export type AuthMode = "sign-in" | "sign-up";

export const MINIMUM_PASSWORD_LENGTH = 8;
export const MAXIMUM_PASSWORD_LENGTH = 72;
/** The contract's code is exactly six digits, so the field never holds more than six. */
export const VERIFICATION_CODE_LENGTH = 6;

/**
 * What a wrong or expired code means, said once on the screen rather than only after a refusal:
 * nothing was lost, and the newest code is the one that works.
 */
export const VERIFICATION_CODE_EXPLANATION =
  "Codes expire, and asking for a new one retires the code before it. If yours is refused, the " +
  "account is still there: ask for another and enter the newest one.";

/** The part of the API client this form uses, so its outcomes can be exercised without a network. */
export interface AuthTransport {
  signUp(input: AuthPasswordSignUpRequest): Promise<AuthSignUpResponse>;
  signIn(input: AuthPasswordSignInRequest): Promise<AuthSession>;
  verifyEmail(input: AuthVerifyRequest): Promise<AuthSession>;
  resendVerification(input: AuthResendRequest): Promise<AuthResendResponse>;
}

/**
 * Creating an account either signs the owner in or leaves them holding an emailed code, and the
 * same build meets both: a local stack confirms nothing, production will.
 */
export type CredentialsOutcome =
  | Readonly<{ status: "signed-in" }>
  | Readonly<{ status: "code-required"; email: string }>
  | Readonly<{ status: "refused"; message: string }>;

export type VerificationOutcome =
  Readonly<{ status: "signed-in" }> | Readonly<{ status: "refused"; message: string }>;

export type ResendOutcome =
  Readonly<{ status: "sent"; message: string }> | Readonly<{ status: "refused"; message: string }>;

export function authSubmitDisabled(pending: boolean, email: string, password: string): boolean {
  return (
    pending ||
    email.trim().length === 0 ||
    password.length < MINIMUM_PASSWORD_LENGTH ||
    password.length > MAXIMUM_PASSWORD_LENGTH
  );
}

/**
 * Keeps the digits and at most six of them. A code arrives by email and is read back by hand or
 * by the keyboard's one-time-code suggestion, so "123 456" and a trailing space are the same code.
 */
export function normalizedVerificationCode(value: string): string {
  return value.replace(/\D/gu, "").slice(0, VERIFICATION_CODE_LENGTH);
}

/** True once the field holds a whole code, which is when the form submits itself. */
export function verificationCodeComplete(value: string): boolean {
  return normalizedVerificationCode(value).length === VERIFICATION_CODE_LENGTH;
}

/**
 * What one change to the code field means. A whole code sends itself: six digits are read across
 * from a mail app or filled in by the keyboard, and hunting for a button after that is the step
 * people abandon.
 */
export function verificationCodeChange(value: string): Readonly<{ code: string; send: boolean }> {
  const code = normalizedVerificationCode(value);
  return { code, send: verificationCodeComplete(code) };
}

export async function submitCredentials(
  transport: AuthTransport,
  mode: AuthMode,
  email: string,
  password: string
): Promise<CredentialsOutcome> {
  try {
    if (mode === "sign-in") {
      await transport.signIn({ email, password });
      return { status: "signed-in" };
    }
    const created = await transport.signUp({ email, password });
    // A confirming deployment answers with the address it emailed and no session. The account
    // exists; the owner finishes by entering the six digits.
    if (authVerificationRequired(created)) {
      return { status: "code-required", email: created.email };
    }
    return { status: "signed-in" };
  } catch (reason) {
    return {
      status: "refused",
      message: productErrorMessage(
        reason,
        mode === "sign-up"
          ? "The account could not be created. Try again."
          : "Sign-in failed. Check your email and password."
      )
    };
  }
}

export async function submitVerificationCode(
  transport: AuthTransport,
  email: string,
  code: string
): Promise<VerificationOutcome> {
  try {
    await transport.verifyEmail({ email, code: normalizedVerificationCode(code) });
    return { status: "signed-in" };
  } catch (reason) {
    return {
      status: "refused",
      message: productErrorMessage(
        reason,
        "That code could not be checked. Enter it again, or ask for a new one."
      )
    };
  }
}

export async function requestAnotherCode(
  transport: AuthTransport,
  email: string
): Promise<ResendOutcome> {
  try {
    await transport.resendVerification({ email });
    return {
      status: "sent",
      message: `A new code is on its way to ${email}. Enter the newest one; the earlier code no longer works.`
    };
  } catch (reason) {
    return {
      status: "refused",
      message: productErrorMessage(
        reason,
        "A new code could not be sent just now. Try again in a moment."
      )
    };
  }
}
