<!-- SPDX-License-Identifier: Apache-2.0 -->

# Official TypeScript SDK example Provider

> **NOT FOR PRODUCTION — MOCK PROVIDERS ONLY**

This small process implements all six public Provider capabilities with the
official TypeScript SDK. It demonstrates manifest disclosure, request schema
validation, stable idempotency, result facts, reconciliation, and event replay.
It has no Core import or database credential and deliberately does not mutate
invoice, ledger, Credit, or Service state.

```sh
EXAMPLE_PROVIDER_TOKEN=replace-with-a-synthetic-32-byte-token \
EXAMPLE_PROVIDER_PORT=4401 \
node dist/server.js
```

The in-memory store is intentionally educational. Use the Mock Lab's durable
PostgreSQL implementation for restart conformance.
