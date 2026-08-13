// SPDX-License-Identifier: AGPL-3.0-or-later

import { z } from "zod";
import {
  assertProviderTokenKeyringsSeparated,
  createProviderTokenKeyring,
  type ProviderTokenKeyring,
} from "@opensales/core/provider-token-vault";
import {
  createIdentitySecretKeyring,
  type IdentitySecretKeyring,
} from "@opensales/core/identity-security";

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  DATABASE_RUNTIME_ROLE: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/).optional(),
  MIGRATION_DATABASE_URL: z.string().min(1).optional(),
  DATABASE_API_ROLE_PASSWORD: z.string().min(32).optional(),
  DATABASE_WORKER_ROLE_PASSWORD: z.string().min(32).optional(),
  OSS_ENV: z.enum(["development", "test", "laboratory"]).default("development"),
  OSS_LOG_LEVEL: z
    .enum(["silent", "fatal", "error", "warn", "info", "debug", "trace"])
    .optional(),
  OSS_PUBLIC_URL: z.url(),
  API_HOST: z.string().default("0.0.0.0"),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  GLOBAL_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),
  SESSION_COOKIE_NAME: z.string().default("oss_session"),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(24),
  VERIFICATION_TTL_MINUTES: z.coerce.number().int().positive().default(30),
  WEB_ORIGIN: z.url().default("http://localhost:5173"),
  MOCK_MAILBOX_URL: z.url().default("http://localhost:4000"),
  LAB_MAILBOX_TOKEN: z.string().min(32),
  PROVIDER_OPERATION_CAPABILITY_SECRET: z.string().min(32),
  PAYMENT_METHOD_TOKEN_KEY: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  PAYMENT_METHOD_TOKEN_KEY_VERSION: z.coerce.number().int().positive().optional(),
  PAYMENT_METHOD_TOKEN_PREVIOUS_KEYS: z.string().optional(),
  PAYMENT_METHOD_TOKEN_LOOKUP_KEY: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  PAYMENT_METHOD_TOKEN_LOOKUP_KEY_VERSION: z.coerce.number().int().positive().optional(),
  PAYMENT_METHOD_TOKEN_LOOKUP_PREVIOUS_KEYS: z.string().optional(),
  IDENTITY_SECRET_KEY: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  IDENTITY_SECRET_KEY_VERSION: z.coerce.number().int().positive().optional(),
  IDENTITY_SECRET_PREVIOUS_KEYS: z.string().optional(),
  OSS_SCHEMA_ROLLBACK_BRIDGE: z
    .enum(["disabled", "016-to-017"])
    .optional(),
  MOCK_PAYMENT_WEBHOOK_SECRET: z.string().min(32),
  MOCK_PROVISIONING_WEBHOOK_SECRET: z.string().min(32),
  LAB_MAILBOX_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
});

export type Config = z.infer<typeof schema>;

export function identitySecretKeyring(config: Config): IdentitySecretKeyring {
  return createIdentitySecretKeyring(
    config.IDENTITY_SECRET_KEY_VERSION ?? 1,
    config.IDENTITY_SECRET_KEY,
    config.IDENTITY_SECRET_PREVIOUS_KEYS,
  );
}

export function paymentMethodTokenKeyrings(config: Config): Readonly<{
  encryption: ProviderTokenKeyring;
  lookup: ProviderTokenKeyring;
}> {
  const encryption = createProviderTokenKeyring(
    config.PAYMENT_METHOD_TOKEN_KEY_VERSION ?? 1,
    config.PAYMENT_METHOD_TOKEN_KEY,
    config.PAYMENT_METHOD_TOKEN_PREVIOUS_KEYS,
  );
  const lookup = createProviderTokenKeyring(
    config.PAYMENT_METHOD_TOKEN_LOOKUP_KEY_VERSION ?? 1,
    config.PAYMENT_METHOD_TOKEN_LOOKUP_KEY,
    config.PAYMENT_METHOD_TOKEN_LOOKUP_PREVIOUS_KEYS,
  );
  assertProviderTokenKeyringsSeparated(encryption, lookup);
  return Object.freeze({ encryption, lookup });
}

export function loadConfig(): Config {
  const config = schema.parse(process.env);
  paymentMethodTokenKeyrings(config);
  identitySecretKeyring(config);
  return config;
}
