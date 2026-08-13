// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  decryptIdentitySecret,
  digestRecoveryCode,
  matchTotpStep,
} from "@opensales/core/identity-security";
import { identitySecretKeyring, type Config } from "./config.js";
import type { DatabaseClient } from "./database.js";

export type FactorMethod = "password" | "totp" | "recovery_code";

async function databaseClockMs(client: DatabaseClient): Promise<number> {
  const result = await client.query<{ now_ms: string }>(
    `SELECT pg_catalog.floor(
       extract(epoch FROM pg_catalog.clock_timestamp()) * 1000
     )::bigint::text AS now_ms`,
  );
  const value = Number(result.rows[0]?.now_ms);
  if (!Number.isSafeInteger(value)) throw new Error("Database clock is unavailable");
  return value;
}

type CredentialRow = Readonly<{
  id: string;
  seed_ciphertext: string;
  seed_key_version: number;
}>;

export async function activeTotpCredential(
  client: DatabaseClient,
  userId: string,
  lock: "share" | "update" = "update",
): Promise<CredentialRow | null> {
  const result = await client.query<CredentialRow>(
    `SELECT id, seed_ciphertext, seed_key_version
     FROM public.user_totp_credentials
     WHERE user_id = $1 AND disabled_at IS NULL
     FOR ${lock === "share" ? "SHARE" : "UPDATE"}`,
    [userId],
  );
  return result.rows[0] ?? null;
}

export async function verifyConfiguredFactorLocked(
  client: DatabaseClient,
  config: Config,
  userId: string,
  code: string | undefined,
  purpose: "login" | "reauth" | "enrollment",
  input: Readonly<{ credential?: CredentialRow | null; required?: boolean }> = {},
): Promise<FactorMethod | null> {
  const credential = input.credential === undefined
    ? await activeTotpCredential(client, userId)
    : input.credential;
  if (!credential) return input.required ? null : "password";
  if (!code) return null;

  if (/^\d{6}$/.test(code)) {
    const secret = decryptIdentitySecret(
      credential.seed_ciphertext,
      credential.seed_key_version,
      "totp",
      userId,
      identitySecretKeyring(config),
    );
    const step = matchTotpStep(secret, code, await databaseClockMs(client));
    if (step === null) return null;
    try {
      await client.query(
        `INSERT INTO public.totp_step_use_facts(credential_id, timestep, purpose)
         VALUES ($1, $2, $3)`,
        [credential.id, step.toString(), purpose],
      );
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "23505") {
        return null;
      }
      throw error;
    }
    return "totp";
  }

  if (!/^[0-9A-F]{5}(?:-[0-9A-F]{5}){3}$/.test(code)) return null;
  const recovery = await client.query<{ id: string }>(
    `SELECT recovery.id
     FROM public.totp_recovery_codes recovery
     WHERE recovery.credential_id = $1
       AND recovery.code_digest = $2
       AND recovery.used_at IS NULL
       AND recovery.invalidated_at IS NULL
     FOR UPDATE`,
    [credential.id, digestRecoveryCode(code)],
  );
  const recoveryId = recovery.rows[0]?.id;
  if (!recoveryId) return null;
  const consumed = await client.query(
    `UPDATE public.totp_recovery_codes
     SET used_at = pg_catalog.now()
     WHERE id = $1 AND used_at IS NULL AND invalidated_at IS NULL
     RETURNING id`,
    [recoveryId],
  );
  return consumed.rowCount === 1 ? "recovery_code" : null;
}
