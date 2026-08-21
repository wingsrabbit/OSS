// SPDX-License-Identifier: AGPL-3.0-or-later

export type StaffActionIntent = Readonly<{
  fingerprint: string;
  intentId: string;
}>;

const REAUTH_CREDENTIAL_FIELD = /password|factorcode|recoverycode|secret|token|totp/iu;

function canonicalBusinessJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Staff action intent contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalBusinessJson(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => {
        if (REAUTH_CREDENTIAL_FIELD.test(key)) {
          throw new Error("Reauthentication credentials cannot enter a Staff action intent");
        }
        return `${JSON.stringify(key)}:${canonicalBusinessJson(record[key])}`;
      })
      .join(",")}}`;
  }
  throw new Error("Staff action intent contains an unsupported value");
}

export function staffActionIntent(
  intents: Map<string, StaffActionIntent>,
  slot: string,
  businessPayload: unknown,
): string {
  const fingerprint = canonicalBusinessJson(businessPayload);
  const prior = intents.get(slot);
  if (prior?.fingerprint === fingerprint) return prior.intentId;
  const intentId = globalThis.crypto.randomUUID();
  intents.set(slot, { fingerprint, intentId });
  return intentId;
}

export function clearStaffActionIntent(
  intents: Map<string, StaffActionIntent>,
  slot: string,
  intentId: string,
): void {
  if (intents.get(slot)?.intentId === intentId) intents.delete(slot);
}
