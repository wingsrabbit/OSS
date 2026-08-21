<!-- SPDX-License-Identifier: Apache-2.0 -->

# OpenSales System functional Mock Provider Lab

> **NOT FOR PRODUCTION — MOCK PROVIDERS ONLY**

The lab exposes Payment, Provisioning, Mail, Verification, Tax, and Anti-abuse
Challenge through the public Provider `v1` transport and `v1alpha1` capability
contracts. The six capability mocks share one process for convenient laboratory
deployment but retain independent capability names, operations, inputs, output
facts, and events.

Set `PROVIDER_DATABASE_URL`, `MOCK_PROVIDER_PLATFORM_TOKEN`, the independent
`MOCK_PROVIDER_REQUEST_FINGERPRINT_KEY`, `CORE_CALLBACK_URL`, and
`PROVIDER_PORT`. The fingerprint key is a canonical 32-byte base64url value;
rotate it with `MOCK_PROVIDER_REQUEST_FINGERPRINT_KEY_VERSION` while retaining
older `version:key` entries in `MOCK_PROVIDER_REQUEST_FINGERPRINT_PREVIOUS_KEYS`
for the full lifetime of that Provider database and every recoverable backup.
The bounded keyring accepts at most 32 lifetime versions and does not infer key
retirement from the manifest retention declaration. Bearer-token rotation is
independent. The public manifest is available at `GET /v1/manifest`; mutation
and reconciliation routes require the synthetic Bearer credential.

Before accepting traffic, an upgraded Provider process locks any legacy
password-change operation rows, replaces the stored password with the redacted
projection, and recalculates the fingerprint under the active key in one
transaction. It refuses startup without printing the stored request if a row
cannot be upgraded safely.

## Functional reliability profile

`X-OSS-Lab-Scenario` may contain:

| Value | Functional result |
| --- | --- |
| `normal` | Persist and return one successful fact. |
| `failure` | Persist and return one definitive functional failure. |
| `duplicate` | Deliver the same event twice; consumers deduplicate by `eventId`. |
| `out_of_order` | Return sequence 2 before sequence 1; consumers preserve the latest fact. |
| `timeout` | Persist success, return HTTP 504, and require GET reconciliation. |
| `restart` | Persist `pending`; after process restart, GET reconciles the same operation to success. |

The header is not part of the public Provider contract. It is only a normal
product reliability fixture. The suite performs no malicious, offensive,
network, or Cyber testing.
