import { z } from "zod";

export const NormalizedEmailSchema = z.string().trim().toLowerCase().max(254).pipe(z.email());

/** Length bounds only; the identity provider applies its own policy and hashing. */
export const PasswordSchema = z
  .string()
  .min(8, "Use at least 8 characters")
  .max(72, "Use at most 72 characters");

export const AuthPasswordSignUpRequestSchema = z.strictObject({
  email: NormalizedEmailSchema,
  password: PasswordSchema
});
export type AuthPasswordSignUpRequest = z.infer<typeof AuthPasswordSignUpRequestSchema>;

export const AuthPasswordSignInRequestSchema = z.strictObject({
  email: NormalizedEmailSchema,
  password: PasswordSchema
});
export type AuthPasswordSignInRequest = z.infer<typeof AuthPasswordSignInRequestSchema>;

export const AuthUserSchema = z.strictObject({ id: z.uuid(), email: NormalizedEmailSchema });
export type AuthUser = z.infer<typeof AuthUserSchema>;

export const AuthSessionSchema = z.strictObject({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresAt: z.iso.datetime({ offset: true }),
  user: AuthUserSchema
});
export type AuthSession = z.infer<typeof AuthSessionSchema>;

/** The six digits an owner receives by email when a new account must be confirmed. */
export const AuthVerificationCodeSchema = z
  .string()
  .trim()
  .regex(/^[0-9]{6}$/u, "A verification code is six digits.");
export type AuthVerificationCode = z.infer<typeof AuthVerificationCodeSchema>;

/**
 * Creating an account either signs the owner in or asks them for the code just emailed to them,
 * depending on whether the deployment confirms addresses. A client must handle both: the same
 * build talks to a local stack that confirms nothing and to production, which does.
 */
export const AuthSignUpResponseSchema = z.union([
  AuthSessionSchema,
  z.strictObject({
    verificationRequired: z.literal(true),
    email: NormalizedEmailSchema
  })
]);
export type AuthSignUpResponse = z.infer<typeof AuthSignUpResponseSchema>;

export const AuthVerifyRequestSchema = z.strictObject({
  email: NormalizedEmailSchema,
  code: AuthVerificationCodeSchema
});
export type AuthVerifyRequest = z.infer<typeof AuthVerifyRequestSchema>;

export const AuthResendRequestSchema = z.strictObject({ email: NormalizedEmailSchema });
export type AuthResendRequest = z.infer<typeof AuthResendRequestSchema>;

/** Content-free by design: whether a given address has an account is not disclosed here. */
export const AuthResendResponseSchema = z.strictObject({ sent: z.literal(true) });
export type AuthResendResponse = z.infer<typeof AuthResendResponseSchema>;

export const AuthSessionResponseSchema = z.strictObject({ user: AuthUserSchema });
export type AuthSessionResponse = z.infer<typeof AuthSessionResponseSchema>;

export const AuthSignOutResponseSchema = z.strictObject({ signedOut: z.literal(true) });
export type AuthSignOutResponse = z.infer<typeof AuthSignOutResponseSchema>;

export const AuthRefreshRequestSchema = z.strictObject({
  refreshToken: z.string().min(1).max(8_192)
});
export type AuthRefreshRequest = z.infer<typeof AuthRefreshRequestSchema>;
