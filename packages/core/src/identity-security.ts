// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export const CUSTOMER_API_KEY_SCOPES = [
  "account.read",
  "orders.read",
  "billing.read",
  "services.read",
  "support.read",
  "support.write",
] as const;

export type CustomerApiKeyScope = (typeof CUSTOMER_API_KEY_SCOPES)[number];

const apiKeyScopeSet: ReadonlySet<string> = new Set(CUSTOMER_API_KEY_SCOPES);
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const API_KEY_PATTERN =
  /^oss_lab_([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})_([A-Za-z0-9_-]{43})$/;
const KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type IdentitySecretKeyring = Readonly<{
  activeVersion: number;
  keys: ReadonlyMap<number, string>;
}>;

function assertPositiveVersion(version: number): void {
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error("Identity secret key version must be a positive integer");
  }
}

function decodeEncryptionKey(encodedKey: string): Buffer {
  if (!KEY_PATTERN.test(encodedKey)) {
    throw new Error("Identity secret key must be canonical base64url without padding");
  }
  const decoded = Buffer.from(encodedKey, "base64url");
  if (decoded.length !== 32 || decoded.toString("base64url") !== encodedKey) {
    throw new Error("Identity secret key must decode to exactly 32 bytes");
  }
  return decoded;
}

export function createIdentitySecretKeyring(
  activeVersion: number,
  activeKey: string,
  previousKeys = "",
): IdentitySecretKeyring {
  assertPositiveVersion(activeVersion);
  const activeMaterial = decodeEncryptionKey(activeKey).toString("hex");
  const keys = new Map<number, string>([[activeVersion, activeKey]]);
  const materials = new Set([activeMaterial]);
  for (const entry of previousKeys.split(",").map((value) => value.trim()).filter(Boolean)) {
    const separator = entry.indexOf(":");
    if (separator <= 0 || separator === entry.length - 1 || entry.indexOf(":", separator + 1) >= 0) {
      throw new Error("Previous identity secret keys must use version:base64url-key entries");
    }
    const version = Number(entry.slice(0, separator));
    const encodedKey = entry.slice(separator + 1);
    assertPositiveVersion(version);
    if (version >= activeVersion || keys.has(version)) {
      throw new Error("Previous identity secret key versions must be unique and lower than active");
    }
    const material = decodeEncryptionKey(encodedKey).toString("hex");
    if (materials.has(material)) {
      throw new Error("Identity secret key material cannot be reused across versions");
    }
    keys.set(version, encodedKey);
    materials.add(material);
  }
  return Object.freeze({ activeVersion, keys });
}

function keyForVersion(keyring: IdentitySecretKeyring, version: number): Buffer {
  assertPositiveVersion(version);
  const encodedKey = keyring.keys.get(version);
  if (!encodedKey) throw new Error(`Identity secret key version ${version} is unavailable`);
  return decodeEncryptionKey(encodedKey);
}

export function encryptIdentitySecret(
  plaintext: string,
  purpose: string,
  subjectId: string,
  keyring: IdentitySecretKeyring,
): Readonly<{ ciphertext: string; keyVersion: number }> {
  if (!plaintext || plaintext.length > 20_000 || !purpose || !subjectId) {
    throw new Error("Identity secret envelope input is invalid");
  }
  const version = keyring.activeVersion;
  const nonce = randomBytes(12);
  const aad = `opensales:identity-secret:v1:${version}:${purpose}:${subjectId}`;
  const cipher = createCipheriv("aes-256-gcm", keyForVersion(keyring, version), nonce);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const payload = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: [
      "v1",
      String(version),
      nonce.toString("base64url"),
      payload.toString("base64url"),
      tag.toString("base64url"),
    ].join("."),
    keyVersion: version,
  };
}

export function decryptIdentitySecret(
  ciphertext: string,
  keyVersion: number,
  purpose: string,
  subjectId: string,
  keyring: IdentitySecretKeyring,
): string {
  const [format, embeddedVersionText, nonceText, payloadText, tagText, extra] =
    ciphertext.split(".");
  const embeddedVersion = Number(embeddedVersionText);
  if (
    format !== "v1" ||
    extra !== undefined ||
    embeddedVersion !== keyVersion ||
    !nonceText ||
    !payloadText ||
    !tagText
  ) {
    throw new Error("Identity secret ciphertext format is invalid");
  }
  const nonce = Buffer.from(nonceText, "base64url");
  const payload = Buffer.from(payloadText, "base64url");
  const tag = Buffer.from(tagText, "base64url");
  if (nonce.length !== 12 || tag.length !== 16) {
    throw new Error("Identity secret ciphertext parameters are invalid");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    keyForVersion(keyring, keyVersion),
    nonce,
  );
  decipher.setAAD(
    Buffer.from(
      `opensales:identity-secret:v1:${keyVersion}:${purpose}:${subjectId}`,
      "utf8",
    ),
  );
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(payload), decipher.final()]).toString("utf8");
}

export function canonicalCustomerApiKeyScopes(
  scopes: readonly string[],
): readonly CustomerApiKeyScope[] {
  if (scopes.length < 1 || scopes.length > CUSTOMER_API_KEY_SCOPES.length) {
    throw new Error("At least one reviewed customer API key scope is required");
  }
  const unique = [...new Set(scopes)];
  if (unique.some((scope) => !apiKeyScopeSet.has(scope))) {
    throw new Error("Customer API key scope is not allowed");
  }
  return unique.sort() as CustomerApiKeyScope[];
}

export function createCustomerApiKey(
  keyId: string,
): Readonly<{ rawKey: string; digest: Buffer }> {
  const rawKey = `oss_lab_${keyId}_${randomBytes(32).toString("base64url")}`;
  if (!API_KEY_PATTERN.test(rawKey)) throw new Error("Customer API key identifier is invalid");
  return { rawKey, digest: digestCustomerApiKey(rawKey) };
}

export function parseCustomerApiKey(rawKey: string): Readonly<{ keyId: string }> | null {
  const match = API_KEY_PATTERN.exec(rawKey);
  return match?.[1] ? { keyId: match[1].toLowerCase() } : null;
}

export function digestCustomerApiKey(rawKey: string): Buffer {
  return createHash("sha256")
    .update("opensales:customer-api-key:v1\0", "utf8")
    .update(rawKey, "utf8")
    .digest();
}

export function digestRecoveryCode(code: string): Buffer {
  return createHash("sha256")
    .update("opensales:totp-recovery-code:v1\0", "utf8")
    .update(code.trim().toUpperCase(), "utf8")
    .digest();
}

export function generateRecoveryCodes(count = 10): readonly string[] {
  if (!Number.isSafeInteger(count) || count < 1 || count > 20) {
    throw new Error("Recovery code count must be from 1 through 20");
  }
  return Array.from({ length: count }, () => {
    const encoded = randomBytes(10).toString("hex").toUpperCase();
    return `${encoded.slice(0, 5)}-${encoded.slice(5, 10)}-${encoded.slice(10, 15)}-${encoded.slice(15)}`;
  });
}

export function base32Encode(value: Uint8Array): string {
  let bits = 0;
  let accumulator = 0;
  let result = "";
  for (const byte of value) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += BASE32_ALPHABET[(accumulator >>> bits) & 31];
    }
  }
  if (bits > 0) result += BASE32_ALPHABET[(accumulator << (5 - bits)) & 31];
  return result;
}

export function base32Decode(value: string): Buffer {
  if (!value || !/^[A-Z2-7]+$/.test(value)) {
    throw new Error("TOTP seed must be canonical unpadded uppercase base32");
  }
  let bits = 0;
  let accumulator = 0;
  const bytes: number[] = [];
  for (const character of value) {
    accumulator = (accumulator << 5) | BASE32_ALPHABET.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >>> bits) & 0xff);
    }
  }
  const decoded = Buffer.from(bytes);
  if (base32Encode(decoded) !== value) {
    throw new Error("TOTP seed has noncanonical residual bits");
  }
  return decoded;
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpCode(
  base32Secret: string,
  instantMs = Date.now(),
  periodSeconds = 30,
  digits = 6,
): string {
  if (!Number.isSafeInteger(periodSeconds) || periodSeconds < 1) {
    throw new Error("TOTP period must be a positive integer");
  }
  if (!Number.isSafeInteger(digits) || digits < 6 || digits > 8) {
    throw new Error("TOTP digits must be from 6 through 8");
  }
  const counter = BigInt(Math.floor(instantMs / 1_000 / periodSeconds));
  const counterBytes = Buffer.alloc(8);
  counterBytes.writeBigUInt64BE(counter);
  const digest = createHmac("sha1", base32Decode(base32Secret))
    .update(counterBytes)
    .digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, "0");
}

export function verifyTotpCode(
  base32Secret: string,
  candidate: string,
  instantMs = Date.now(),
  window = 1,
): boolean {
  return matchTotpStep(base32Secret, candidate, instantMs, window) !== null;
}

export function matchTotpStep(
  base32Secret: string,
  candidate: string,
  instantMs = Date.now(),
  window = 1,
): bigint | null {
  if (!/^\d{6}$/.test(candidate) || !Number.isSafeInteger(window) || window < 0 || window > 2) {
    return null;
  }
  const candidateBytes = Buffer.from(candidate, "ascii");
  const currentStep = BigInt(Math.floor(instantMs / 30_000));
  for (let offset = -window; offset <= window; offset += 1) {
    const matchedStep = currentStep + BigInt(offset);
    if (matchedStep < 0n) continue;
    const expected = Buffer.from(
      totpCode(base32Secret, Number(matchedStep * 30_000n)),
      "ascii",
    );
    if (timingSafeEqual(candidateBytes, expected)) return matchedStep;
  }
  return null;
}
