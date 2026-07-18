<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

## What changed

<!-- Describe the complete diff and why it is needed. -->

## Evidence and contract impact

- Evidence IDs:
- State/guard oracle:
- Ledger vectors:
- API/event/Provider contract:
- Version/compatibility impact:

## Validation

<!-- List exact commands, results, and durable artifact references. -->

## Role-separated review

- Author/implementation role:
- Independent Evidence/Blue/Red reviewer:
- Reproduction command and result:

## Safety checklist

- [ ] `NOT FOR PRODUCTION — MOCK PROVIDERS ONLY` remains accurate and visible.
- [ ] No credential, customer data, private infrastructure identifier, production log, or proprietary WHMCS material is present.
- [ ] No real Provider or production mutation was introduced.
- [ ] Normal, failure, duplicate, out-of-order, crash, and recovery cases are covered where required.
- [ ] CI/security policy, financial invariants, and conformance oracles were not weakened to make this change pass.
- [ ] Rollback and forward-migration compatibility are documented where applicable.
