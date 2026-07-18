<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Initial bootstrap role-separated review

> **NOT FOR PRODUCTION — MOCK PROVIDERS ONLY**

Recorded at: `2026-07-18T08:44:58Z`

This is engineering review evidence for the one intentional bootstrap commit in
an empty public repository. It is not a G0 exit report, a release approval, or
an independent professional certification.

## Reviewed scope

- Governing prompt SHA-256:
  `9cd354eacdc194b94d03ced6e986687da71f8cb58bdb50450c2ff91bca843392`
- Private Scope Confirmation Record SHA-256 only:
  `59447dea237574d67bad0e07734d77c76ae09fad53d731b5e3c2368223fd8977`
- Bootstrap workflow raw SHA-256:
  `16fe824550f31ea9e29b815b0009f91a16b0967ffb685ffae616daf3759dbe99`
- Bootstrap workflow normalized policy SHA-256:
  `9397a19b2445d86115f63980d65adfad93b46074b39b18fd094fe862fa6357af`
- Package policy SHA-256:
  `1931cfbd80a5c22dacf579fafd664f4211b61f444c15a8604c6537c8ad4b4f8b`
- Specification validator SHA-256:
  `3a306188135d7b3cc08458043a2fea49f97cced30fa75a56dee48eb8513072db`
- Specification tests SHA-256:
  `1dd370fa8c857bd66c8dbc5fc34ed34de398abfcc2a6a34c0aed40afb741ba28`
- Exact-ledger runner SHA-256:
  `86fd5c597ba87f15b5c0d09bdb67579f34420f7e00ecd6c72e5b770c11467c97`

The primary execution role authored and integrated the bootstrap. Separate
review roles inspected the Gate/Evidence invariants, exact-ledger execution,
and CI/bootstrap policy. Review findings were reproduced before correction and
replayed after correction.

## Review progression

1. The Gate/Evidence review required trusted goal-source binding, monotonic and
   append-only Evidence history, report-commit inventory checks, stable Gate
   report amendments, one active head, and targeted regression coverage. Those
   controls and regression tests are present. That review's only remaining
   no-go was the ledger runner described next.
2. The ledger review reproduced acceptance of a no-op runner and fabricated
   evidence. The final design replaces self-asserted status with a fixed,
   digest-anchored executable, strict canonical attestation, exact BigInt
   arithmetic, concrete rounding, per-asset journal balance, exact ordered
   vector equality, and fresh-output byte comparison. A separate ledger quality
   reviewer replayed malformed, stale, unbalanced, cross-asset, rounding,
   digest, runner, and vector cases and concluded `GO` with no remaining P0/P1.
3. The CI review reproduced a mutable `pnpm check` alias and an additional
   `workflow_dispatch` workflow using `read-all`, a Secret, and a production
   environment. The workflow now calls the two fixed Node entry points;
   package scripts, runtime, package-manager integrity and validator
   dependencies are exact policy inputs; bootstrap permits one workflow and no
   local actions; and every bootstrap workflow rejects `secrets`,
   `github.token`, environments, and `read-all`. The same reviewer replayed both
   cases and concluded `GO` with no remaining P0/P1.

## Reproduction and observed results

| Check | Result |
| --- | --- |
| `pnpm check` using Node `24.18.0`, Corepack `0.35.0`, pnpm `11.14.0` | 41/41 tests passed; 7 schemas and all recognized documents validated |
| `node --test tools/validate-specifications.test.mjs` | Passed |
| `node tools/validate-specifications.mjs` | Passed |
| `gitleaks dir . --redact --exit-code 1` with v8.30.1 | No leaks found |
| `pnpm audit --audit-level=high` | No known vulnerabilities found |
| `git diff --check` | Passed |
| Workflow action identity verification | Both pinned SHAs resolve in the official `actions/checkout` and `actions/setup-node` repositories |
| Secret-scanner image identity verification | The v8.30.1 Docker Hub tag resolves to the pinned `sha256:c00b6bd0a...` manifest |

The reviewed tree contains governance, schemas, tests, and review tooling only.
It contains no application, Provider, database, deployment, production, or
real-infrastructure implementation and no Secret or private infrastructure
identifier. Full private scope evidence remains outside Git; only its digest is
public.

## Conclusion and remaining boundary

`GO` applies only to creating the one intentional `0.0.0` bootstrap commit.
The remote push must still pass the pinned `bootstrap-policy` check, after which
`main` must be protected against direct and force pushes. All later work uses
scoped branches and pull requests. G0 remains `NO-GO` until concrete Feature
Evidence Cards and every mandatory state, guard, ledger, transport, Provider,
retention, threat-model, and test-strategy oracle receive their own immutable
evidence commit and passing Gate Exit Report.
