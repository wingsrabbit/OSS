<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Changelog

All notable project changes will be documented here. Project release numbering and independently versioned Provider contracts/SDKs are separate policies and will be frozen during G0/G1.

## [Unreleased]

### Planned

- G0 independent specification and threat-model pack.

## [0.1.0] - 2026-07-18

### Changed

- G0 policy now requires a source- and scope-bound Evidence Inventory before a Gate can claim complete feature coverage.
- Project package versions are validated against the repository `VERSION` file while bootstrap scripts, dependencies, runtime, and workflow identities remain pinned.
- Scope deviations now accept only the two explicit Goal Owner decisions, with immutable typed records bound to exact authorization lines, Feature closure, Scope, repository bytes, and Gate commits; future deviations require a separately reviewed registry change.
- Frozen Evidence Card decision and review metadata is immutable while review, implementation, and acceptance references may advance only append-only.
- Normative history validation now traverses every Git DAG parent edge, rejects shallow, replaced, custom replace-base, or grafted history, validates the full VERSION/package/README/changelog bundle, and keeps historical Gate approvals isolated from future deviation records.
- Evidence and Inventory narratives reject invisible or punctuation-only content, canonicalize review roles, enforce chronology, and bind frozen semantic-decomposition review coverage to every Requirement and Feature.

## [0.0.0] - 2026-07-18

### Added

- Intentional public-repository bootstrap with clean-room governance, license boundaries, non-production limitations, evidence schemas, architecture decisions, and safe CI policy.
