// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import test from "node:test";
import {
  assertProviderTokenKeyringCoversVersions,
  assertProviderTokenKeyringsSeparated,
  createProviderTokenKeyring,
  decryptProviderToken,
  decryptProviderTokenWithKeyring,
  digestProviderToken,
  digestProviderTokenCandidates,
  encryptProviderToken,
  fingerprintProviderTokenKey,
  fingerprintProviderTokenKeyMaterial,
} from "./provider-token-vault.js";

const key = Buffer.alloc(32, 7).toString("base64url");
const lookupKey = Buffer.alloc(32, 8).toString("base64url");

function legacyCiphertext(providerToken: string, encodedKey: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(encodedKey, "base64url"), nonce);
  cipher.setAAD(Buffer.from("opensales:saved-payment-method:v1", "utf8"));
  const payload = Buffer.concat([cipher.update(providerToken, "utf8"), cipher.final()]);
  return [
    "v1",
    nonce.toString("base64url"),
    payload.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
  ].join(".");
}

test("Provider token vault encrypts nondeterministically and decrypts exactly", () => {
  const token = "mock-provider-token-for-customer-1234";
  const first = encryptProviderToken(token, key);
  const second = encryptProviderToken(token, key);
  assert.notEqual(first, second);
  assert.equal(decryptProviderToken(first, key), token);
  assert.deepEqual(
    digestProviderToken(token, lookupKey),
    digestProviderToken(token, lookupKey),
  );
  assert.notDeepEqual(
    digestProviderToken(token, lookupKey),
    digestProviderToken(token, key),
  );
});

test("Provider token vault rejects tampering and invalid keys", () => {
  const encrypted = encryptProviderToken("mock-provider-token-for-customer-5678", key);
  const pieces = encrypted.split(".");
  pieces[3] = `${pieces[3]?.startsWith("A") ? "B" : "A"}${pieces[3]?.slice(1) ?? ""}`;
  assert.throws(() => decryptProviderToken(pieces.join("."), key));
  assert.throws(() => encryptProviderToken("mock-provider-token-for-customer-5678", "short"));
  assert.throws(() => digestProviderToken("mock-provider-token-for-customer-5678", "short"));
});

test("Provider token keyrings read an old version while new writes bind the active version", () => {
  const oldKey = Buffer.alloc(32, 11).toString("base64url");
  const activeKey = Buffer.alloc(32, 12).toString("base64url");
  const keyring = createProviderTokenKeyring(2, activeKey, `1:${oldKey}`);
  const token = "mock-provider-token-for-customer-rotation";
  const oldCiphertext = legacyCiphertext(token, oldKey);
  const newCiphertext = encryptProviderToken(token, activeKey, 2);

  assert.equal(decryptProviderTokenWithKeyring(oldCiphertext, 1, keyring), token);
  assert.equal(decryptProviderTokenWithKeyring(newCiphertext, 2, keyring), token);
  assert.throws(() => decryptProviderToken(newCiphertext, activeKey, 1));
  assert.throws(() => decryptProviderTokenWithKeyring(newCiphertext, 3, keyring));
});

test("lookup key rotation produces active-first dual-read candidates", () => {
  const oldKey = Buffer.alloc(32, 13).toString("base64url");
  const activeKey = Buffer.alloc(32, 14).toString("base64url");
  const keyring = createProviderTokenKeyring(2, activeKey, `1:${oldKey}`);
  const token = "mock-provider-token-for-customer-lookup";
  const candidates = digestProviderTokenCandidates(token, keyring);

  assert.deepEqual(candidates.map(({ keyVersion }) => keyVersion), [2, 1]);
  assert.deepEqual(candidates[0]?.digest, digestProviderToken(token, activeKey));
  assert.deepEqual(candidates[1]?.digest, digestProviderToken(token, oldKey));
});

test("keyrings reject duplicated versions, reused material, and encryption/lookup overlap", () => {
  const first = Buffer.alloc(32, 15).toString("base64url");
  const second = Buffer.alloc(32, 16).toString("base64url");
  assert.throws(() => createProviderTokenKeyring(2, second, `2:${first}`));
  assert.throws(() => createProviderTokenKeyring(2, second, `3:${first}`));
  assert.throws(() => createProviderTokenKeyring(2, second, `1:${second}`));
  assert.throws(() => createProviderTokenKeyring(2, second, "not-a-keyring-entry"));
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const lastIndex = alphabet.indexOf(first.at(-1) ?? "");
  const noncanonicalAlias = `${first.slice(0, -1)}${alphabet[lastIndex + 1]}`;
  assert.deepEqual(
    Buffer.from(noncanonicalAlias, "base64url"),
    Buffer.from(first, "base64url"),
  );
  assert.throws(() => createProviderTokenKeyring(2, second, `1:${noncanonicalAlias}`));
  assert.throws(() =>
    assertProviderTokenKeyringsSeparated(
      createProviderTokenKeyring(2, second, `1:${first}`),
      createProviderTokenKeyring(3, first),
    ),
  );
});

test("keyrings fail closed when stored token versions are no longer readable", () => {
  const oldKey = Buffer.alloc(32, 17).toString("base64url");
  const activeKey = Buffer.alloc(32, 18).toString("base64url");
  const rotating = createProviderTokenKeyring(2, activeKey, `1:${oldKey}`);
  assert.doesNotThrow(() =>
    assertProviderTokenKeyringCoversVersions(rotating, [1, 2, 2], "encryption"),
  );
  assert.throws(
    () =>
      assertProviderTokenKeyringCoversVersions(
        createProviderTokenKeyring(2, activeKey),
        [1, 2],
        "encryption",
      ),
    /does not cover stored version 1/,
  );
  assert.throws(
    () => assertProviderTokenKeyringCoversVersions(rotating, [3], "lookup"),
    /does not cover stored version 3/,
  );
});

test("key fingerprints bind material, purpose, and version without exposing the key", () => {
  const first = Buffer.alloc(32, 19).toString("base64url");
  const second = Buffer.alloc(32, 20).toString("base64url");
  const fingerprint = fingerprintProviderTokenKey(first, "encryption", 1);
  assert.equal(fingerprint.length, 32);
  assert.ok(!fingerprint.toString("base64url").includes(first));
  assert.notDeepEqual(fingerprint, fingerprintProviderTokenKey(second, "encryption", 1));
  assert.notDeepEqual(fingerprint, fingerprintProviderTokenKey(first, "lookup", 1));
  assert.notDeepEqual(fingerprint, fingerprintProviderTokenKey(first, "encryption", 2));
  assert.deepEqual(
    fingerprintProviderTokenKeyMaterial(first),
    fingerprintProviderTokenKeyMaterial(first),
  );
  assert.notDeepEqual(
    fingerprintProviderTokenKeyMaterial(first),
    fingerprintProviderTokenKeyMaterial(second),
  );
});
