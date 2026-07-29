// SPDX-License-Identifier: AGPL-3.0-or-later

import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  OSS_ENV: z.enum(["development", "test", "laboratory"]).default("development"),
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
  MOCK_PAYMENT_WEBHOOK_SECRET: z.string().min(32),
  MOCK_PROVISIONING_WEBHOOK_SECRET: z.string().min(32),
  LAB_MAILBOX_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(): Config {
  return schema.parse(process.env);
}
