// SPDX-License-Identifier: AGPL-3.0-or-later

import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

const LEGACY_VERSION = "v1";
const VERSION = "v2";
const KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type ProviderTokenKeyring = Readonly<{
  activeVersion: number;
  keys: ReadonlyMap<number, string>;
}>;

function decodeKey(encodedKey: string): Buffer {
  if (!KEY_PATTERN.test(encodedKey)) {
    throw new Error("Payment method token key must be base64url without padding");
  }
  const key = Buffer.from(encodedKey, "base64url");
  if (key.length !== 32) throw new Error("Payment method token key must decode to 32 bytes");
  if (key.toString("base64url") !== encodedKey) {
    throw new Error("Payment method token key must use canonical base64url encoding");
  }
  return key;
}

function assertKeyVersion(version: number): void {
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error("Payment method token key version must be a positive integer");
  }
}

/**
 * Builds a versioned keyring without ever returning key material in an error.
 * Previous keys use the comma-separated form `version:base64url-key`.
 */
export function createProviderTokenKeyring(
  activeVersion: number,
  activeKey: string,
  previousKeys = "",
): ProviderTokenKeyring {
  assertKeyVersion(activeVersion);
  const activeMaterial = decodeKey(activeKey).toString("hex");
  const keys = new Map<number, string>([[activeVersion, activeKey]]);
  const keyMaterials = new Set([activeMaterial]);

  for (const item of previousKeys.split(",").map((value) => value.trim()).filter(Boolean)) {
    const separator = item.indexOf(":");
    if (separator <= 0 || separator === item.length - 1 || item.indexOf(":", separator + 1) >= 0) {
      throw new Error("Previous payment method token keys must use version:base64url-key entries");
    }
    const version = Number(item.slice(0, separator));
    const encodedKey = item.slice(separator + 1);
    assertKeyVersion(version);
    if (version >= activeVersion) {
      throw new Error("Previous payment method token key versions must be lower than active");
    }
    const keyMaterial = decodeKey(encodedKey).toString("hex");
    if (keys.has(version)) {
      throw new Error(`Payment method token key version ${version} is duplicated`);
    }
    if (keyMaterials.has(keyMaterial)) {
      throw new Error("Payment method token key material cannot be reused across versions");
    }
    keys.set(version, encodedKey);
    keyMaterials.add(keyMaterial);
  }

  return Object.freeze({ activeVersion, keys });
}

export function providerTokenKeyForVersion(
  keyring: ProviderTokenKeyring,
  version: number,
): string {
  assertKeyVersion(version);
  const key = keyring.keys.get(version);
  if (!key) {
    throw new Error(`Payment method token key version ${version} is unavailable`);
  }
  return key;
}

export function assertProviderTokenKeyringCoversVersions(
  keyring: ProviderTokenKeyring,
  storedVersions: Iterable<number>,
  label: "encryption" | "lookup",
): void {
  let maximumStoredVersion = 0;
  for (const version of storedVersions) {
    assertKeyVersion(version);
    maximumStoredVersion = Math.max(maximumStoredVersion, version);
    if (!keyring.keys.has(version)) {
      throw new Error(
        `Payment method token ${label} keyring does not cover stored version ${version}`,
      );
    }
  }
  if (maximumStoredVersion > keyring.activeVersion) {
    throw new Error(
      `Payment method token ${label} active version is older than stored data`,
    );
  }
}

export function fingerprintProviderTokenKey(
  encodedKey: string,
  kind: "encryption" | "lookup",
  keyVersion: number,
): Buffer {
  assertKeyVersion(keyVersion);
  return createHmac("sha256", decodeKey(encodedKey))
    .update(`opensales:payment-method-token-key-fingerprint:v1\0${kind}\0${keyVersion}`, "utf8")
    .digest();
}

export function fingerprintProviderTokenKeyMaterial(encodedKey: string): Buffer {
  return createHmac("sha256", decodeKey(encodedKey))
    .update("opensales:payment-method-token-key-material-fingerprint:v1", "utf8")
    .digest();
}

export function assertProviderTokenKeyringsSeparated(
  encryptionKeyring: ProviderTokenKeyring,
  lookupKeyring: ProviderTokenKeyring,
): void {
  const encryptionMaterials = new Set(
    [...encryptionKeyring.keys.values()].map((key) => decodeKey(key).toString("hex")),
  );
  for (const lookupKey of lookupKeyring.keys.values()) {
    if (encryptionMaterials.has(decodeKey(lookupKey).toString("hex"))) {
      throw new Error("Payment method encryption and lookup keys must be different");
    }
  }
}

export function digestProviderToken(providerToken: string, encodedLookupKey: string): Buffer {
  return createHmac("sha256", decodeKey(encodedLookupKey))
    .update("opensales:provider-token-lookup:v1\0", "utf8")
    .update(providerToken, "utf8")
    .digest();
}

export function digestProviderTokenCandidates(
  providerToken: string,
  lookupKeyring: ProviderTokenKeyring,
): readonly Readonly<{ keyVersion: number; digest: Buffer }>[] {
  const orderedVersions = [
    lookupKeyring.activeVersion,
    ...[...lookupKeyring.keys.keys()]
      .filter((version) => version !== lookupKeyring.activeVersion)
      .sort((left, right) => right - left),
  ];
  return orderedVersions.map((keyVersion) => ({
    keyVersion,
    digest: digestProviderToken(
      providerToken,
      providerTokenKeyForVersion(lookupKeyring, keyVersion),
    ),
  }));
}

export function encryptProviderToken(
  providerToken: string,
  encodedKey: string,
  keyVersion = 1,
): string {
  if (providerToken.length < 16 || providerToken.length > 500) {
    throw new Error("Provider payment method token length is invalid");
  }
  assertKeyVersion(keyVersion);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", decodeKey(encodedKey), nonce);
  cipher.setAAD(Buffer.from(`opensales:saved-payment-method:v2:${keyVersion}`, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(providerToken, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    String(keyVersion),
    nonce.toString("base64url"),
    ciphertext.toString("base64url"),
    tag.toString("base64url"),
  ].join(".");
}

export function decryptProviderToken(
  ciphertext: string,
  encodedKey: string,
  expectedKeyVersion?: number,
): string {
  const pieces = ciphertext.split(".");
  const version = pieces[0];
  let nonceText: string | undefined;
  let payloadText: string | undefined;
  let tagText: string | undefined;
  let aad: string;
  if (version === LEGACY_VERSION && pieces.length === 4) {
    if (expectedKeyVersion !== undefined && expectedKeyVersion !== 1) {
      throw new Error("Saved payment method ciphertext key version does not match its record");
    }
    [, nonceText, payloadText, tagText] = pieces;
    aad = "opensales:saved-payment-method:v1";
  } else if (version === VERSION && pieces.length === 5) {
    const embeddedKeyVersion = Number(pieces[1]);
    assertKeyVersion(embeddedKeyVersion);
    if (expectedKeyVersion !== undefined && embeddedKeyVersion !== expectedKeyVersion) {
      throw new Error("Saved payment method ciphertext key version does not match its record");
    }
    [, , nonceText, payloadText, tagText] = pieces;
    aad = `opensales:saved-payment-method:v2:${embeddedKeyVersion}`;
  } else {
    throw new Error("Saved payment method ciphertext format is invalid");
  }
  if (!nonceText || !payloadText || !tagText) {
    throw new Error("Saved payment method ciphertext format is invalid");
  }
  const nonce = Buffer.from(nonceText, "base64url");
  const payload = Buffer.from(payloadText, "base64url");
  const tag = Buffer.from(tagText, "base64url");
  if (nonce.length !== 12 || tag.length !== 16) {
    throw new Error("Saved payment method ciphertext parameters are invalid");
  }
  const decipher = createDecipheriv("aes-256-gcm", decodeKey(encodedKey), nonce);
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(payload), decipher.final()]).toString("utf8");
}

export function decryptProviderTokenWithKeyring(
  ciphertext: string,
  encryptionKeyVersion: number,
  keyring: ProviderTokenKeyring,
): string {
  return decryptProviderToken(
    ciphertext,
    providerTokenKeyForVersion(keyring, encryptionKeyVersion),
    encryptionKeyVersion,
  );
}
