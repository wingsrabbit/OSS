# Saved payment Provider token key rotation

> **NOT FOR PRODUCTION — MOCK PROVIDERS ONLY**

OSS stores only an opaque Provider payment-method token, encrypted with AES-256-GCM. It never
stores a card number or CVV. Two independent versioned keyrings are used:

- the encryption keyring protects the token at rest;
- the lookup keyring HMACs the token so duplicate Provider facts can be recognized without
  deterministic encryption.

The active keys are used for new writes. Previous keys are read-only and let the Worker decrypt an
old row and let payment callbacks search both old and new HMAC digests while a rotation is underway.
Key material belongs in the deployment Secret store, never in Git, command arguments, logs, or CI
artifacts.

## Rotation procedure

1. Put the public site into a maintenance window, pause new automatic payment jobs, drain in-flight
   requests, and stop **both** the API and Worker. Do not discard unknown Provider operations. Back
   up PostgreSQL and verify the backup is restorable. The old processes must stay stopped from the
   first committed key-registration transaction until the new dual-read processes are healthy.
2. Generate two different 32-byte random keys. Raise both active versions monotonically. Put the old
   values in the previous-key variables:

   ```dotenv
   PAYMENT_METHOD_TOKEN_KEY_VERSION=2
   PAYMENT_METHOD_TOKEN_KEY=<new-32-byte-base64url-key>
   PAYMENT_METHOD_TOKEN_PREVIOUS_KEYS=1:<old-32-byte-base64url-key>
   PAYMENT_METHOD_TOKEN_LOOKUP_KEY_VERSION=2
   PAYMENT_METHOD_TOKEN_LOOKUP_KEY=<different-new-32-byte-base64url-key>
   PAYMENT_METHOD_TOKEN_LOOKUP_PREVIOUS_KEYS=1:<different-old-32-byte-base64url-key>
   ```

   Multiple previous entries are comma-separated. OSS rejects duplicate versions and maintains a
   non-secret, append-only material fingerprint registry so a retired key cannot later be reused
   under a different version or purpose. It also rejects overlap between any encryption and lookup
   key.
3. With the old processes still stopped, run the new release's rotation command against PostgreSQL.
   Use a stable operator identifier and a non-secret reason:

   ```sh
   pnpm --filter @opensales/api rotate:payment-method-token-keys -- \
     --actor operator-key-rotation \
     --reason "scheduled laboratory key rotation" \
     --limit 100 \
     --confirm-api-worker-stopped \
     --confirm-rewrap
   ```

   This explicitly registers the new encryption and lookup version fingerprints, records the
   registration actor and reason, and rewraps the first bounded batch in one transaction. It locks
   each selected row, checks its optimistic version, decrypts only in memory, re-encrypts with
   authenticated key-version binding, replaces the lookup digest, and commits an append-only consent
   event plus an audit event in the same transaction. Output contains counts and key version numbers
   only. It refuses a downgrade, same-version key-material substitution, or a row whose required old
   key is absent. If it fails, registration and row changes roll back together.
   On the first command that extends either registry, OSS also refuses to proceed unless the
   explicit stop confirmation is present, no API/Worker process-lifetime registry guard remains,
   and PostgreSQL has no visible `opensales-api` or `opensales-worker` sessions. The lifetime guard
   closes the idle-pool and check/commit races; the session list remains a secondary check for an
   older process that predates the guard. PostgreSQL additionally rejects every newly saved token
   whose encryption or lookup version is not the maximum registered version, so an undetected
   legacy writer fails closed after registration instead of recreating old-key data. The first
   extension also holds a table write fence: token writes that began before the fence must finish
   and are included in the same rewrap scan, while later writes wait until the new maximum versions
   are committed. Therefore `remaining=0` cannot race an uncommitted old-version insert.
4. Start the API and Worker with the new active keys and all required previous keys. Confirm both are
   healthy before removing maintenance mode or resuming payment jobs. The API now writes version 2,
   the Worker reads versions 1 and 2, and Provider callbacks search HMAC candidates from both lookup
   versions. Startup and readiness are read-only: they never register a typo as a key version. They
   verify configured material against the registered fingerprints, reject an active version older
   than any registered version, and check every token version still stored in PostgreSQL. A missing
   or wrong old key makes the process unready instead of allowing a duplicate HMAC identity or an
   undecryptable background charge.
5. Repeat step 3 until `remaining` is `0`; after the first successful command, later batches may run
   while the dual-read release is healthy because the shared/exclusive rotation fence serializes
   token readers and rewraps. The offline confirmation flag is unnecessary for those later batches
   because they do not extend either registry. Exercise one saved-method automatic renewal in the Mock
   Provider and verify that no token, ciphertext, digest, or key appears in application logs.
6. Take and verify another backup. Remove old key entries from API and Worker configuration, restart,
   and confirm health again. Never remove an old key while `remaining` is non-zero. If either process
   refuses startup or readiness, restore the previous Secret-store version; do not bypass the check.

If a batch fails, its transaction rolls back, including its audit rows. Keep both old and new keys,
investigate the named saved-method ID without exporting its secret columns, and retry. Restoring an
application version is safe only while it understands every active key version; restoring the
database backup also requires restoring the matching Secret-store version.

Lookup rotation is deliberately dual-read/single-write: callbacks calculate digests under the active
and configured previous lookup keys, but every new saved method uses only the active digest. This
prevents a duplicate saved method during an online rotation. Once all rows report the active lookup
version and `remaining` is zero, the previous lookup keys are no longer needed.
