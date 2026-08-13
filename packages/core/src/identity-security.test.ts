// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import {
  base32Decode,
  base32Encode,
  canonicalCustomerApiKeyScopes,
  createCustomerApiKey,
  createIdentitySecretKeyring,
  decryptIdentitySecret,
  digestCustomerApiKey,
  digestRecoveryCode,
  encryptIdentitySecret,
  matchTotpStep,
  parseCustomerApiKey,
  totpCode,
  verifyTotpCode,
} from "./identity-security.js";

test("TOTP matches the RFC 6238 SHA-1 vector and verifies only the fixed window", () => {
  const secret = base32Encode(Buffer.from("12345678901234567890", "ascii"));
  assert.equal(totpCode(secret, 59_000, 30, 8), "94287082");
  const current = totpCode(secret, 1_700_000_000_000);
  assert.equal(verifyTotpCode(secret, current, 1_700_000_000_000), true);
  assert.equal(matchTotpStep(secret, current, 1_700_000_000_000), 56_666_666n);
  assert.equal(verifyTotpCode(secret, "000000", 1_700_000_000_000), false);
  assert.deepEqual(base32Decode(secret), Buffer.from("12345678901234567890", "ascii"));
  assert.throws(() => base32Decode(`${secret}=`));
  assert.throws(() => base32Decode("MZ"));
});

test("identity secret envelopes bind version, purpose, and subject", () => {
  const key = randomBytes(32).toString("base64url");
  const keyring = createIdentitySecretKeyring(3, key);
  const envelope = encryptIdentitySecret("synthetic-secret", "totp", "user-1", keyring);
  assert.equal(envelope.keyVersion, 3);
  assert.equal(
    decryptIdentitySecret(envelope.ciphertext, 3, "totp", "user-1", keyring),
    "synthetic-secret",
  );
  assert.throws(() =>
    decryptIdentitySecret(envelope.ciphertext, 3, "totp", "user-2", keyring),
  );
});

test("customer API keys are parseable by public id but only their digest is retained", () => {
  const keyId = randomUUID();
  const key = createCustomerApiKey(keyId);
  assert.deepEqual(parseCustomerApiKey(key.rawKey), { keyId });
  assert.deepEqual(key.digest, digestCustomerApiKey(key.rawKey));
  assert.equal(parseCustomerApiKey(`${key.rawKey}x`), null);
  assert.notDeepEqual(digestRecoveryCode(key.rawKey), key.digest);
});

test("customer API key scopes are reviewed, unique, and canonical", () => {
  assert.deepEqual(
    canonicalCustomerApiKeyScopes(["support.write", "account.read", "support.write"]),
    ["account.read", "support.write"],
  );
  assert.throws(() => canonicalCustomerApiKeyScopes(["payments.write"]));
  assert.throws(() => canonicalCustomerApiKeyScopes([]));
});
