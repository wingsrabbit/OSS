<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Gate evidence

> **NOT FOR PRODUCTION — MOCK PROVIDERS ONLY**

Every concrete G0–G9 exit report has the stable path
`docs/gates/reports/<report_id>.yaml`. It contains the machine-readable
decision, immutable artifact references, and role-separated review evidence; a
human-readable summary may accompany it under `docs/reviews/`. A Gate passes
only when its normative oracle, tests, and active report all pass. Later UI or
Mock success cannot retroactively waive an earlier Gate.

## Append-only reports and amendments

A committed report is append-only at the file level: its path and bytes cannot
be edited, deleted, or renamed. Remediation or a changed decision creates a new
report with a new `report_id` and `supersedes_report_id` naming the report it
amends. An amendment must retain the same Gate identity, have a later
`recorded_at`, and extend a single non-branching, acyclic chain; it never rewrites
or erases the superseded report.

Each Gate has exactly one active report head: the report in that Gate's chain
that has no successor. Only that active head authorizes `go` or records
`no-go`; inactive historical reports are audit evidence, not current
authorization. An active `go` with an expired high-risk acceptance automatically
fails validation and re-blocks the Gate. Restoring `go` requires a new amendment
with current remediation or acceptance evidence—never an in-place extension of
the expired report.

For a `go` report, feature counts are recomputed from concrete Evidence Cards;
the report lists every in-scope card with its stable path and byte digest;
passing commands and reviews point to repository-resident artifacts; high-risk
acceptance expires within 30 days; and `content_digest` is recomputed from the
canonical key-sorted JSON form with that field removed. `source_commit` names the
audited subject commit. The immutable report lives in the immediately following
dedicated evidence commit, which has exactly one parent equal to `source_commit`
and whose changes are limited to `docs/gates/` and `docs/reviews/`. Every
`repo:` artifact must be a regular file in that report commit's tree. Generic
G0 oracle wrappers additionally declare the SHA-256 digest of each normative
artifact, which is recomputed from that same report commit. Evidence-card
manifests are checked the same way, so a later commit cannot retroactively
supply or replace accepted evidence. `release_identity.project_version` is
recomputed from the subject commit's exact `VERSION`, `package.json`, `README.md`,
and `CHANGELOG.md` blobs. Every cited Owner deviation record is also required in
the report commit, byte-digest checked there, and snapshot-matched to the
validated registry-bound approval. Its declared Feature IDs must equal every
same-decision Evidence Card in that report commit, including post-goal cards
that are not part of Gate counts; a missing Feature cannot be supplied later to
repair an overbroad historical approval. Later files cannot retroactively
authorize a Gate.
Conversely, a deviation introduced by a later card is not projected backward
into an older report: each Gate derives its approval set only from the Evidence
Card bytes in that report's own manifest and commit. The dedicated report commit
is the unique Git-DAG origin where the stable report path first appears; a later
normal merge does not replace that origin or turn the merge commit into evidence.
A later release manifest binds subject commit, report commit, report digest, and
release artifact digests.

There is exactly one active head, and therefore at most one active `go`, for
each reported Gate. A Gate cannot pass unless every predecessor Gate has an
active `go` report. Each later Gate's audited subject commit must descend from
the immediately preceding Gate's active report commit; if an earlier Gate is
amended, downstream reports must still satisfy that active ancestry and be
reissued when necessary. This makes Gate order a verifiable Git history
property rather than a naming convention.

A G0 `go` report additionally carries `g0_oracles`, with nonempty, distinct,
commit-captured artifacts for the G0 Evidence Inventory, state transitions,
guard/RBAC, ledger postings, transport, Provider contracts, data retention,
threat modeling, and test strategy. Counts are recomputed from schema-backed
documents, and every document must have a passed independent review. The
inventory must be frozen and its artifact must be the same inventory named by
`feature_evidence.matrix_artifact`. A pending, absent, or mismatched oracle
therefore keeps G0 closed even when individual Feature Evidence Cards exist.

`next_gate` names the next Gate that remains locked until this report is `go`.
Its presence in a `no-go` report is planning metadata and never authorizes
advancement.
