import { z } from "zod";

import { ExpansionStyleSchema, OrganizationModeSchema, RoutingEffortSchema } from "./enums.js";
import { ExpectedRevisionSchema, IdempotencyKeySchema } from "./idempotency.js";

export const MAX_AI_SETTINGS_REQUEST_BYTES = 4 * 1024;
export const MAX_AI_SETTINGS_RESPONSE_BYTES = 32 * 1024;
export const MAX_PROVIDER_KEY_REQUEST_BYTES = 4 * 1024;
export const MAX_PROVIDER_KEY_RESPONSE_BYTES = 16 * 1024;

/** Providers that have passed the public adapter and evaluation gate. */
export const PublicByokProviderSchema = z.literal("openai");
export type PublicByokProvider = z.infer<typeof PublicByokProviderSchema>;

export const ProviderModeSchema = z.enum(["app_default", "byok"]);
export type ProviderMode = z.infer<typeof ProviderModeSchema>;

export const ProviderKeyStatusSchema = z.enum(["active", "invalid", "revoked"]);
export type ProviderKeyStatus = z.infer<typeof ProviderKeyStatusSchema>;

const timezoneSchema = z.string().trim().min(1).max(100);
const localeSchema = z
  .string()
  .trim()
  .min(2)
  .max(35)
  .regex(/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u, "Use a BCP 47 locale identifier");

export const UserSettingsDtoSchema = z
  .strictObject({
    settingsRevision: ExpectedRevisionSchema,
    organizationMode: OrganizationModeSchema,
    providerMode: ProviderModeSchema,
    byokProvider: PublicByokProviderSchema.nullable(),
    byokFallbackToApp: z.boolean(),
    routingEffort: RoutingEffortSchema,
    expansionStyle: ExpansionStyleSchema,
    timezone: timezoneSchema,
    locale: localeSchema,
    updatedAt: z.iso.datetime({ offset: true })
  })
  .superRefine((settings, context) => {
    if (settings.providerMode === "byok" && settings.byokProvider === null) {
      context.addIssue({
        code: "custom",
        message: "BYOK mode requires a provider",
        path: ["byokProvider"]
      });
    }
    if (settings.providerMode === "app_default" && settings.byokProvider !== null) {
      context.addIssue({
        code: "custom",
        message: "The app-default mode cannot select a BYOK provider",
        path: ["byokProvider"]
      });
    }
    if (settings.providerMode === "app_default" && settings.byokFallbackToApp) {
      context.addIssue({
        code: "custom",
        message: "Fallback is meaningful only while BYOK mode is active",
        path: ["byokFallbackToApp"]
      });
    }
  });
export type UserSettingsDto = z.infer<typeof UserSettingsDtoSchema>;

export const UserSettingsResponseSchema = z.strictObject({ settings: UserSettingsDtoSchema });
export type UserSettingsResponse = z.infer<typeof UserSettingsResponseSchema>;

export const UserSettingsUpdateRequestSchema = z
  .strictObject({
    expectedSettingsRevision: ExpectedRevisionSchema,
    idempotencyKey: IdempotencyKeySchema,
    organizationMode: OrganizationModeSchema.optional(),
    providerMode: ProviderModeSchema.optional(),
    byokProvider: PublicByokProviderSchema.nullable().optional(),
    byokFallbackToApp: z.boolean().optional(),
    routingEffort: RoutingEffortSchema.optional(),
    expansionStyle: ExpansionStyleSchema.optional(),
    timezone: timezoneSchema.optional(),
    locale: localeSchema.optional()
  })
  .superRefine(
    (
      {
        organizationMode,
        providerMode,
        byokProvider,
        byokFallbackToApp,
        routingEffort,
        expansionStyle,
        timezone,
        locale
      },
      context
    ) => {
      if (
        organizationMode === undefined &&
        providerMode === undefined &&
        byokProvider === undefined &&
        byokFallbackToApp === undefined &&
        routingEffort === undefined &&
        expansionStyle === undefined &&
        timezone === undefined &&
        locale === undefined
      ) {
        context.addIssue({ code: "custom", message: "At least one settings field is required" });
      }
      if (providerMode === "app_default" && byokProvider !== undefined && byokProvider !== null) {
        context.addIssue({
          code: "custom",
          message: "The app-default mode cannot select a BYOK provider",
          path: ["byokProvider"]
        });
      }
      if (providerMode === "app_default" && byokFallbackToApp === true) {
        context.addIssue({
          code: "custom",
          message: "Fallback is meaningful only while BYOK mode is active",
          path: ["byokFallbackToApp"]
        });
      }
      if (providerMode === "byok" && byokProvider === null) {
        context.addIssue({
          code: "custom",
          message: "BYOK mode requires a provider",
          path: ["byokProvider"]
        });
      }
      if (byokProvider === null && byokFallbackToApp === true) {
        context.addIssue({
          code: "custom",
          message: "Fallback requires an active BYOK provider selection",
          path: ["byokFallbackToApp"]
        });
      }
    }
  );
export type UserSettingsUpdateRequest = z.infer<typeof UserSettingsUpdateRequestSchema>;

export const UserSettingsUpdateResponseSchema = z.strictObject({
  settings: UserSettingsDtoSchema,
  replayed: z.boolean()
});
export type UserSettingsUpdateResponse = z.infer<typeof UserSettingsUpdateResponseSchema>;

export const ProviderKeyMetadataSchema = z
  .strictObject({
    provider: PublicByokProviderSchema,
    lastFour: z.string().regex(/^[!-~]{4}$/u, "Expected exactly four visible ASCII characters"),
    status: ProviderKeyStatusSchema,
    credentialRevision: ExpectedRevisionSchema,
    validatedAt: z.iso.datetime({ offset: true }).nullable(),
    updatedAt: z.iso.datetime({ offset: true })
  })
  .superRefine((metadata, context) => {
    if (metadata.status === "active" && metadata.validatedAt === null) {
      context.addIssue({
        code: "custom",
        message: "An active provider key must have a validation timestamp",
        path: ["validatedAt"]
      });
    }
  });
export type ProviderKeyMetadata = z.infer<typeof ProviderKeyMetadataSchema>;

export const ProviderKeyResponseSchema = z.strictObject({
  providerKey: ProviderKeyMetadataSchema.nullable()
});
export type ProviderKeyResponse = z.infer<typeof ProviderKeyResponseSchema>;

export const ProviderKeyPutRequestSchema = z.strictObject({
  idempotencyKey: IdempotencyKeySchema,
  provider: PublicByokProviderSchema,
  expectedCredentialRevision: ExpectedRevisionSchema.nullable(),
  apiKey: z
    .string()
    .min(20)
    .max(500)
    .regex(/^[!-~]+$/u, "Provider keys must use visible ASCII without spaces")
});
export type ProviderKeyPutRequest = z.infer<typeof ProviderKeyPutRequestSchema>;

export const ProviderKeyPutResponseSchema = z.strictObject({
  providerKey: ProviderKeyMetadataSchema,
  replayed: z.boolean()
});
export type ProviderKeyPutResponse = z.infer<typeof ProviderKeyPutResponseSchema>;

export const ProviderKeyDeleteRequestSchema = z.strictObject({
  idempotencyKey: IdempotencyKeySchema,
  provider: PublicByokProviderSchema,
  expectedCredentialRevision: ExpectedRevisionSchema
});
export type ProviderKeyDeleteRequest = z.infer<typeof ProviderKeyDeleteRequestSchema>;

export const ProviderKeyDeleteResponseSchema = z.strictObject({
  provider: PublicByokProviderSchema,
  deleted: z.literal(true),
  deletedCredentialRevision: ExpectedRevisionSchema,
  replayed: z.boolean()
});
export type ProviderKeyDeleteResponse = z.infer<typeof ProviderKeyDeleteResponseSchema>;
