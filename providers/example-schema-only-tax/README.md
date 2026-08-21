<!-- SPDX-License-Identifier: Apache-2.0 -->

# Independent schema-only Tax Provider example

> **NOT FOR PRODUCTION — MOCK PROVIDERS ONLY**

This example deliberately has **no dependency** on
`@opensales/provider-sdk-typescript` or any Core package. It loads only the
published JSON Schema files, implements the documented HTTP boundary with
Node.js, and validates its manifest, requests, results, and events with Ajv.

It proves an external developer can implement a Provider without the official
SDK. The calculation is a synthetic 5% laboratory tax fact, never a real tax
rule and never authority to change an Invoice or Ledger.

```sh
SCHEMA_ONLY_PROVIDER_TOKEN=replace-with-a-synthetic-32-byte-token \
SCHEMA_ONLY_PROVIDER_PORT=4402 \
node server.mjs
```
