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

export const AuthSessionResponseSchema = z.strictObject({ user: AuthUserSchema });
export type AuthSessionResponse = z.infer<typeof AuthSessionResponseSchema>;

export const AuthSignOutResponseSchema = z.strictObject({ signedOut: z.literal(true) });
export type AuthSignOutResponse = z.infer<typeof AuthSignOutResponseSchema>;

export const AuthRefreshRequestSchema = z.strictObject({
  refreshToken: z.string().min(1).max(8_192)
});
export type AuthRefreshRequest = z.infer<typeof AuthRefreshRequestSchema>;
