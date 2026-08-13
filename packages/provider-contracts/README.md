<!-- SPDX-License-Identifier: Apache-2.0 -->

# OpenSales System Provider contracts

> **NOT FOR PRODUCTION — MOCK PROVIDERS ONLY**

This package publishes the process-boundary contracts for Payment,
Provisioning, Mail, Verification, Tax, and Anti-abuse Challenge Providers.
Transport envelopes are `v1`; capability contracts are `v1alpha1`. JSON Schema
2020-12 and the generated OpenAPI 3.1 document are normative. The TypeScript
types and validator are derived views of the same schema definitions.

Providers report external facts. They never receive a Core database credential
and never write invoice, ledger, Credit, or Service state.

Run `opensales-provider-validate <kind> <document.json>` where `kind` is
`manifest`, `operation-request`, `operation-result`, `event`, or `event-page`.

Licensed under Apache-2.0. See `../../LICENSES/Apache-2.0.txt`.
