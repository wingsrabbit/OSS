<!-- SPDX-License-Identifier: Apache-2.0 -->

# Provider functional conformance

> **NOT FOR PRODUCTION — MOCK PROVIDERS ONLY**

This package is an HTTP-only consumer of the public Provider contract. It does
not import Mock implementation code or Core. The public journey validates the
manifest and executes all 14 declared mutation operations across the six
capabilities, including stable idempotency, reconciliation, and event
envelopes for each operation. The Mock reliability profile additionally covers
functional failure, duplicate events, out-of-order events, timeout-as-unknown,
process restart, and query-only reconciliation for every capability.

`runProviderManagementLifecycleConformance` is a pure, deterministic public
contract check. It covers install, pause without new mutation side effects,
resume, bounded credential-version overlap and expiry, manifest limit
admission, uninstall blocking and drain, and final revoke while retaining
query-only reconciliation. It requires no network or database.

The Mock reliability profile uses `X-OSS-Lab-Scenario`. That header is a
laboratory control and is deliberately absent from the public Provider schema.
It cannot be used to add Provider-specific business fields to a real contract.

Build the contracts, SDK, Mock Lab, and this package, then run:

```sh
PROVIDER_DATABASE_URL=postgresql://... \
PROVIDER_CONFORMANCE_DATABASE_NAME=provider \
MOCK_PROVIDER_PLATFORM_TOKEN=replace-with-a-synthetic-32-byte-token \
node conformance/provider-platform/dist/mock-lab.integration.js
```

The integration starts the Mock process, exercises all six capabilities,
stops it after durable `pending` facts exist, restarts it against the same
Provider database, and proves reconciliation returns the original operations.
