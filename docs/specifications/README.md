<!-- SPDX-License-Identifier: Apache-2.0 -->

# Normative specification oracles

> **NOT FOR PRODUCTION — MOCK PROVIDERS ONLY**

This directory contains schemas and, after independent G0 review, the normative state, authorization, ledger, transport, Provider trust, data-lifecycle, and test-vector oracles. Schemas and contract artifacts are licensed under Apache-2.0.

`g0-oracle.schema.json` is the schema-backed review wrapper for mandatory
transport, Provider, data-retention, threat-model, and test-strategy artifacts.
It binds each artifact's repository path and byte digest to source Evidence, a
deterministic wrapper digest, and an independent reproducible review. Repository
validation rejects a missing, self-referential, duplicate, or byte-mismatched
artifact, and Gate validation repeats the digest check against the report
commit. A Gate manifest cannot replace this wrapper with a bare path or an
unreviewed document.

G0 inventory is explicit rather than count-only. It requires one independently
reviewed state table for each of the 17 goal aggregates (`AGGREGATE-USER`
through `AGGREGATE-OPERATION`), the named Order, Service, and Operation states,
guard resources for User, Client Account, Membership, Staff, and Provider, and
the Owner/account restriction-and-restoration combinations. Ledger coverage
must include every goal-mandated event, the revenue/deferred/tax/clearing/credit
liability accounts, the collectible/allocated/outstanding derivations, and the
four controlled manual financial commands. Generic oracle wrappers declare
`coverage_ids`; the validator's required-ID registry covers transport and
idempotency, Provider trust and revocation, every retention data class, threat
domains, and normal/failure/replay/crash/recovery plus adversarial test
strategies. Missing a required ID keeps G0 closed even if document counts look
complete.

Provider coverage is not satisfied by trust metadata alone. The Provider oracle
must cover all six v1alpha capability classes with their exact registry IDs:
`COVERAGE-CAPABILITY-PAYMENT-V1ALPHA`,
`COVERAGE-CAPABILITY-PROVISIONING-V1ALPHA`,
`COVERAGE-CAPABILITY-VERIFICATION-V1ALPHA`,
`COVERAGE-CAPABILITY-MAIL-V1ALPHA`, `COVERAGE-CAPABILITY-TAX-V1ALPHA`, and
`COVERAGE-CAPABILITY-ANTIABUSE-V1ALPHA`, in addition to Provider trust,
revocation, scope, and egress coverage. Omission of any one capability keeps G0
closed.

Mock implementations and application code must conform to these oracles. They must never be used to infer or silently rewrite the oracle after the fact.

Schema validity proves structure only. Repository validation additionally closes
known cross-document references, checks review completeness, and rejects unknown
normative documents. A passed ledger matrix therefore uses the executable
`oss-ledger-exact/v1` protocol rather than a free-form symbolic formula.

The exact amount AST admits only `input`, `amount`, `sum`, `subtract`, `min`,
`max`, `clamp_min_zero`, and `multiply_ratio_round`. Amounts, ratio numerators,
and denominators are canonical integer strings and are evaluated with exact
integer arithmetic; ratio operations name a concrete `half_up`, `half_even`,
`down`, or `up` rounding rule. References must close, declared input sets must
match the AST, amount dependencies must be acyclic, and posting lines bind only
declared amount and account IDs. Expression depth and node counts are bounded.

Golden fixtures and results conform to
`ledger-golden-artifact.schema.json`. An `input` artifact binds the matrix and
vector identities, exact atomic inputs, requested amount IDs, and posting-rule
IDs. An `expected` artifact binds the exact derived amounts and journals. An
`attestation` binds the protocol, matrix ID, matrix semantic digest, trusted
runner digest, ordered vector results, input/expected/vector digests, computed
amounts and journals, per-asset balance checks, and an all-passed summary.

The matrix's `golden_runner` must declare protocol `oss-ledger-exact/v1`, the
digest-bound executable `repo:tools/run-ledger-golden-vectors.mjs`, and a
digest-bound attestation under `repo:docs/reviews/`. Validation invokes that
trusted executable with the fixed protocol, repository root, matrix path, and
`canonical-json` format. It rejects a changed runner, a non-JSON or misplaced
passed matrix, non-regular fixture paths, fixture digest mismatches, noncanonical
stdout, schema-invalid output, a semantic or identity mismatch, reordered or
missing vectors, any non-passing result, or stored attestation bytes that differ
from a fresh run. The matrix semantic digest is canonical JSON with
`golden_runner` and `review` removed. The runner evaluates all declared vectors
using exact atomic arithmetic, compares the computed amounts and postings with
the expected canonical JSON value, and requires debit and credit equality
separately for every asset. The executable,
attestation, input, and expected-fixture digests are checked again in the G0
report commit.

This protocol proves deterministic arithmetic, executable rounding, frozen
expected postings, and per-asset journal balance for the declared vectors. It
does not execute database idempotency, concurrency, or end-to-end reversal
behavior; those claims still require their separately mapped tests and evidence.
G0 remains closed if either layer is missing or fails.
