<!-- SPDX-License-Identifier: Apache-2.0 -->

# Provider developer guide

> **NOT FOR PRODUCTION — MOCK PROVIDERS ONLY**

OpenSales System Providers are independent HTTP processes. This laboratory
release publishes six capability contracts:

- Payment
- Provisioning
- Mail
- Verification
- Tax
- Anti-abuse Challenge

The transport envelope is `v1`; capability messages are `v1alpha1`. Contract
and SDK versions are independent of the OpenSales application version.

## Start from public artifacts

The source of truth is under
`packages/provider-contracts/generated`:

- JSON Schema 2020-12 for manifest, request, result, event, and event page;
- OpenAPI 3.1 for all HTTP routes;
- a generated capability reference;
- `opensales-provider-validate` for documents created outside TypeScript.

The official `@opensales/provider-sdk-typescript` adds strict parsing,
canonical request fingerprints, deterministic operation IDs, bounded
query-only reconciliation, and duplicate/out-of-order event reduction. It is
optional: `providers/example-schema-only-tax` implements the published schema
without importing the SDK or Core.

The public HTTP conformance journey executes every declared mutation operation:
three Payment actions, seven Provisioning actions, and one action for each of
Mail, Verification, Tax, and Anti-abuse Challenge. Each operation must preserve
its stable idempotency result, reconcile by GET, and expose a valid event fact.

## Stable operation journey

1. Core creates one stable UUID `operationId` for one business intent.
2. Core sends it in both the body and `Idempotency-Key` header.
3. The Provider stores the request fingerprint before returning an outcome.
4. An exact replay returns the first operation. Reusing the ID with different
   content returns `409`.
5. A timeout or interrupted mutation is unknown. Core calls the GET operation
   endpoint; it does not create another operation.
6. Provider events are at least once. Consumers deduplicate `eventId` and never
   replace a greater accepted `sequence` with an older one.

Providers report facts and external references. They cannot write Core tables
or directly set Invoice Paid, Credit, Ledger postings, or Service Active.

## Installation disclosure

`GET /v1/manifest` is the review surface. Before installation, an operator must
be shown exactly what the manifest declares:

- provider ID, publisher, license, endpoint, manifest version, and capability
  contract versions;
- operations and event subscriptions per capability;
- requested scopes, named data fields, and every injected Secret with purpose
  and rotation requirement;
- maximum concurrent operations, money limit, and owned-resource limit;
- operation, event, and PII retention periods;
- pause, credential rotation, manual takeover, and uninstall constraints.

A capability, scope, field, Secret, amount/resource limit, event subscription,
or retention expansion is a new permission grant and requires a fresh operator
approval. A Provider cannot silently widen its installed manifest.
The official SDK exposes `providerInstallationReview` and
`reviewProviderPermissionExpansion` so install UIs and administrative APIs can
render and enforce the same public declaration without importing Provider code.

Pause blocks new mutations while preserving reconciliation. Revocation stops
new work and initiates credential retirement. Rotation uses an overlap long
enough for already-created operations to reconcile. Manual takeover preserves
the external owner and operation references. Uninstall is blocked while the
installation owns Active resources, pending funds, or unknown operations; the
operator must drain, reconcile, export, or deliberately move those facts to
manual ownership first.
`providerUninstallDecision` turns those three ownership counts into an explicit
blocker list; it never deletes or rewrites an operation, fund, or resource.

## Run the examples and functional conformance

```sh
pnpm --filter @opensales/provider-contracts docs:check
pnpm --filter @opensales/example-provider-sdk build
pnpm --filter @opensales/provider-conformance build
pnpm --filter @opensales/provider-conformance test:examples
```

For the durable Mock reliability profile, set a PostgreSQL 18 Provider database
and a synthetic token, then run `test:mock-lab`. It covers normal, functional
failure, duplicate, out-of-order, timeout, restart, and reconcile paths for all
six capabilities. It does not perform Cyber, malicious Provider, scanning,
egress, or internal-network testing.

Passing these tests proves compatibility only with this Mock-only contract
version. It is not a security assessment, production authorization, tax ruling,
payment certification, or identity-assurance certification.
