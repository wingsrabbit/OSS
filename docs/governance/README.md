<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Governance artifacts

> **NOT FOR PRODUCTION — MOCK PROVIDERS ONLY**

This directory contains the public, machine-readable governance anchors for the
OpenSales System laboratory project. It must not contain credentials, private
infrastructure identifiers, customer data, the private Scope Confirmation
Record, or local filesystem paths to controlled records.

## Scope deviation approvals

`deviation-approval.schema.json` defines the only normative artifact that can
authorize an Evidence Card's non-null `approved_deviation_id`. It does not trust
a repository author who merely writes `project_owner`. The frozen authorization
registry currently contains exactly the two Owner decisions stated in the
governing Goal: optional customer/Staff MFA at `L337`, and the new TermRat
deployment's USD-only boundary at `L482-L483`. A record must select the matching
stable decision ID, exact Goal anchor and digest, canonical approved change, and
canonical fail-closed constraints. The private operational Scope Confirmation
Record is still bound for deployment scope, but it is not misrepresented as the
source of either product/security authorization.

A blank, denied, draft, unrelated, self-asserted, or newly invented decision is
not an approval. Approval narratives must contain Unicode letters or numbers;
whitespace, punctuation alone, control characters, and Unicode default-
ignorable characters cannot manufacture a nonempty decision.

Each approval is a JSON file at the deterministic, case-preserving path
`docs/governance/decisions/<decision_id>.json`. Its filename stem must exactly
equal `decision_id`. `feature_ids` limits the decision to the named Features,
and `constraints` records the fixed fail-closed boundary of the approved change.
An Evidence Card may cite the approval only with the exact repository reference
and byte digest for that file. The declared Feature set must equal—not merely
contain—the cards bound to the decision in the relevant repository/Gate commit.
Reusing an approval for an unlisted Feature, or declaring a Feature that has no
same-commit card, is not authorized.

The record repeats the trusted goal and Scope bindings so an approval cannot be
detached from the source and authorization context under which it was granted.
Only the public Scope Summary reference and the digest of the private Scope
Confirmation Record are stored; the private record and its filesystem location
remain outside the repository.

Approval records are immutable after their first frozen commit. Corrections do
not rewrite or broaden an existing approval in place. A future Owner deviation
is fail-closed until a separate policy PR adds a new trusted authorization key
and binds exact, separately captured Owner evidence; creating a JSON file alone
can never extend the registry. The validator also
requires `recorded_at` and `lifecycle.frozen_at` not to be in the future or later
than a Gate report commit that captures the approval.

`lifecycle.content_digest` is lowercase `sha256` over the deterministic,
recursively key-sorted JSON representation of the approval after removing only
`lifecycle.content_digest`. Arrays retain their declared order. The digest is
therefore independent of source-file whitespace while remaining sensitive to
every approval field.
