<!-- SPDX-License-Identifier: Apache-2.0 -->

# OpenSales System Provider SDK for TypeScript

> **NOT FOR PRODUCTION — MOCK PROVIDERS ONLY**

The official SDK wraps the public Apache-2.0 Provider contracts. It provides a
strict HTTP client, deterministic operation identifiers, canonical request
fingerprints, bounded query-only reconciliation, and duplicate/out-of-order
event reduction. It does not grant a Provider access to Core state.

Installation helpers project the complete operator review, detect capability,
scope, field, Secret, limit, retention, endpoint, and lifecycle expansion that
requires fresh approval, and block uninstall while unknown operations, pending
funds, or owned Active resources remain.

The public lifecycle helpers model an installed Provider as active, paused, or
revoked. Mutation admission stops while paused or revoked, while query-only
reconciliation remains available for normal draining. Credential rotation uses
a bounded two-version overlap, then expires the previous version. Admission
also enforces the manifest's concurrent-operation, amount, and owned-resource
limits before a new mutation is accepted.
