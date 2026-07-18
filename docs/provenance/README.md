<!-- SPDX-License-Identifier: Apache-2.0 -->

# Provenance and feature evidence

> **NOT FOR PRODUCTION — MOCK PROVIDERS ONLY**

This directory defines the machine-readable provenance model used to connect an independently stated business requirement to its intended disposition, implementation, tests, and reproducible review evidence.

These files are specification artifacts. They do not contain product decisions, production observations, deployment locators, credentials, private host identifiers, customer data, or test results. Concrete evidence cards are added only after their sources have been reviewed under the project's clean-room rules.

## License boundary

The JSON Schemas and templates in this directory are licensed under `Apache-2.0`, matching the repository's contract and schema exception. Each file carries an SPDX identifier. Runtime applications and other source code may use a different repository-approved license; copying a schema into another directory does not silently change that directory's declared license.

## Canonical artifacts

- `evidence-card.schema.json` is the canonical JSON Schema Draft 2020-12 definition for one Feature Evidence Card.
- `evidence-card.template.yaml` is a parseable, non-normative starter document. Placeholder values are not business evidence and must be replaced before a card is frozen.
- Future concrete cards use stable Evidence and Feature identifiers and remain append-only after they are frozen. A correction creates a reviewed, frozen successor with the same Feature ID and a `supersedes` link to the prior Evidence ID. Each superseded card has exactly one direct successor; chains cannot branch, cycle, change goal scope, lower priority, or defer a Gate deadline.
- A concrete card lives at `docs/provenance/cards/<Evidence-ID>.yaml`. Git history fixes the first frozen decision projection at that path. Later implementation status, verification timestamps, review evidence, and implementation/artifact references may advance, but business description, sources, classification, disposition, oracle/test mappings, scenarios, scope, and Gate deadlines cannot change in place.
- Human-readable coverage tables should be generated from the cards. A hand-maintained table must not become a second source of truth.

Every current-goal card in a high lifecycle state (`frozen`, `implemented`,
`verified`, or `superseded`) is bound to the same trusted goal source. It must
contain a `goal_specification` source whose reference is exactly
`goal://cloud-termrat-core-goal-prompt` or that reference followed by a `#`
fragment, whose `content_digest` is
`sha256:9cd354eacdc194b94d03ced6e986687da71f8cb58bdb50450c2ff91bca843392`,
and whose verification status is `frozen` or `verified`. The binding is anchored
twice: `docs/governance/source-freeze.json` fixes the source ID and digest, while
`docs/governance/scope-summary.json` independently fixes the same governing
prompt digest. Either metadata anchor failing keeps the evidence invalid.

## Required classification

Every evidence item is assigned exactly one disposition status:

- `retained`: the capability is intentionally preserved and must map to implementation and acceptance evidence.
- `config`: the behavior is expressed by generic platform configuration rather than hard-coded product logic.
- `excluded`: the capability is intentionally outside scope and must have an exclusion assertion.
- `quarantined`: a known unsafe or unwanted behavior is held fail-closed and must have a negative regression test.
- `unknown`: the available evidence is insufficient or not authorized for verification. It must have an owner role, impact, fail-safe behavior, and resolution Gate.

Classification and implementation target are separate. A retained capability can require Core behavior, a Provider contract, deployment configuration, or a combination of them. Unknown evidence must never be guessed into a retained behavior.

The schema rejects contradictory combinations: `retained` and `config` cards
cannot target `exclude`; `config` cards must include `deployment_config`; and an
`excluded` card targets only `exclude`. Excluded and quarantined cards require at
least one negative-test reference. A passed review is valid only when it is
independent and records both reproduction commands and evidence references.
Every reference recorded by a passed review must use
`repo:docs/reviews/...` and resolve to a regular, non-symlink file inside the
repository. Gate validation repeats that resolution against the report commit,
so a working-tree-only or later-added review artifact is not acceptance
evidence.

## Evidence lifecycle

1. State the behavior independently from any proprietary implementation.
2. Record source references, authority, verification status, and a digest when available.
3. Assign priority, classification, rationale, and intended targets.
4. Link states, guards, permissions, ledger vectors, contracts, configuration, and tests by stable identifiers.
5. For P0 evidence, provide normal, failure, duplicate, out-of-order, crash, and recovery scenarios.
6. Obtain a review from a role that did not author the change and record reproducible commands and artifacts.
7. Freeze the card with a version and non-placeholder content digest. Frozen and
   verified cards require a passed independent review. Later changes supersede
   rather than silently rewrite the frozen decision.

Lifecycle and source verification can only advance. The allowed lifecycle
transitions are `frozen` to `frozen`, `implemented`, `verified`, or
`superseded`; `implemented` to `implemented`, `verified`, or `superseded`;
`verified` to `verified` or `superseded`; and `superseded` to `superseded`.
For every source ID retained on the frozen card, verification may move from
`unknown` to `unknown`, `frozen`, or `verified`; from
`not_authorized_to_verify` to itself, `frozen`, or `verified`; from `frozen` to
`frozen` or `verified`; and from `verified` only to `verified`. In particular,
`unknown` and `not_authorized_to_verify` are not interchangeable states.

These rules apply to every committed high-lifecycle snapshot, not merely the
current file. Repository validation rejects deletion or draft downgrade,
source-status or lifecycle regression, and any temporary in-place decision
rewrite even if a later commit restores the original bytes. Business decision
fields never advance in place: a changed decision requires a successor card.
Permitted implementation, artifact, and review references may advance, but
must remain resolvable repository files and cannot be used to rewrite historical
business provenance.

Frozen-card digests use lowercase `sha256` over the deterministic key-sorted JSON
representation after removing `lifecycle.content_digest`. Verified cards require
a verified source, target-specific mappings, implementation and acceptance
references, and repository-resident evidence. The author role cannot appear in
the reviewer-role list. An `other` source is fail-closed at authority rank 4 and
must explain why no stronger source type applies.

Every card declares `goal_scope`. Current-goal evidence enters the denominator
at G0 and must have an acceptance Gate no later than G9; it cannot be hidden in
`POST_GOAL`. A genuinely future item uses `post_goal` and both Gate fields are
`POST_GOAL`. That exception must already be frozen, independently reviewed,
linked to a repository-resident approval artifact, and supported by a frozen
Owner decision plus an `approved_deviation_id`; an unreviewed draft cannot leave
the current-goal denominator.

An unknown card has a separate resolution deadline. Its `resolution_gate` must
fall between `first_gate` and `acceptance_gate`. A Gate cannot report `go` once
that resolution deadline is due while the card is still classified `unknown`;
the later acceptance deadline remains the deadline for implementation evidence.
P0 evidence is stricter: it cannot remain `unknown` at any `go` Gate, including
G0.

## Clean-room and data handling

Source references identify approved documents, public observations, or controlled evidence by logical reference and digest. They must not embed restricted operational material. Raw evidence stays in its authorized system of record; a card stores only the minimum description and reference needed for auditability.

The classification index is complete only when every in-scope evidence item has a card, every retained item has an acceptance path, every explicit exclusion has a negative assertion, and no P0 item is unexplained.
