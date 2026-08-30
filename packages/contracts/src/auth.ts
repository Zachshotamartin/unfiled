import { z } from "zod";

export const NormalizedEmailSchema = z.string().trim().toLowerCase().max(254).pipe(z.email());

export const OtpCodeSchema = z.string().regex(/^\d{6}$/u, "Enter the six-digit code");

export const AuthOtpRequestSchema = z.strictObject({ email: NormalizedEmailSchema });
export type AuthOtpRequest = z.infer<typeof AuthOtpRequestSchema>;

export const AuthOtpAcceptedResponseSchema = z.strictObject({
  accepted: z.literal(true),
  retryAfterSeconds: z.number().int().positive()
});
export type AuthOtpAcceptedResponse = z.infer<typeof AuthOtpAcceptedResponseSchema>;

export const AuthOtpVerifyRequestSchema = z.strictObject({
  email: NormalizedEmailSchema,
  code: OtpCodeSchema
});
export type AuthOtpVerifyRequest = z.infer<typeof AuthOtpVerifyRequestSchema>;

export const AuthVerifyRequestSchema = AuthOtpVerifyRequestSchema;
export type AuthVerifyRequest = AuthOtpVerifyRequest;

export const AuthUserSchema = z.strictObject({ id: z.uuid(), email: NormalizedEmailSchema });
export type AuthUser = z.infer<typeof AuthUserSchema>;

export const AuthSessionSchema = z.strictObject({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresAt: z.iso.datetime({ offset: true }),
  user: AuthUserSchema
});
export type AuthSession = z.infer<typeof AuthSessionSchema>;

export const AuthVerifyResponseSchema = AuthSessionSchema;
export type AuthVerifyResponse = AuthSession;

export const AuthSessionResponseSchema = z.strictObject({ user: AuthUserSchema });
export type AuthSessionResponse = z.infer<typeof AuthSessionResponseSchema>;

export const AuthSignOutResponseSchema = z.strictObject({ signedOut: z.literal(true) });
export type AuthSignOutResponse = z.infer<typeof AuthSignOutResponseSchema>;

export const AuthRefreshRequestSchema = z.strictObject({
  refreshToken: z.string().min(1).max(8_192)
});
export type AuthRefreshRequest = z.infer<typeof AuthRefreshRequestSchema>;
