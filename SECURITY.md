<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Security policy

> **NOT FOR PRODUCTION — MOCK PROVIDERS ONLY**

## Supported versions

There is no supported release yet. The repository is in specification and laboratory development.

## Reporting a vulnerability

Do not open a public issue containing vulnerability details, credentials, personal data, private infrastructure identifiers, or exploit material. Use GitHub private vulnerability reporting when it is available for this repository. If that channel is unavailable, contact the repository owner through an established private channel and disclose only the minimum needed to arrange a secure handoff.

Never send live credentials. Replace tokens, account identifiers, host details, customer records, and logs with synthetic values. If an exposed credential is discovered, stop further publication or deployment and rotate or revoke it before continuing.

## Gate policy

- Critical findings cannot be waived.
- High findings must be fixed before a gate passes, unless the Owner records a time-limited acceptance with precise scope, compensating controls, and an expiry of no more than 30 days.
- Scanner exceptions require reproducible evidence and an accountable owner; a bare ignore rule is not acceptable.
- Security review by project agents is role-separated engineering evidence, not an independent professional certification.
