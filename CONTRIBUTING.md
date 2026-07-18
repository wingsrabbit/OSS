<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Contributing

> **NOT FOR PRODUCTION — MOCK PROVIDERS ONLY**

## Clean-room requirement

Contributions must be independently authored from this project's public specifications, general engineering principles, and fully synthetic fixtures. Do not inspect, copy, translate, or emulate proprietary WHMCS source, database structures, templates, routes, hook/module interfaces, signatures, or commercial assets.

Do not include customer data, production logs, credentials, private infrastructure identifiers, or real-provider secrets. Real Provider implementations and legacy migration are outside the current laboratory goal.

## Change workflow

1. Use a scoped branch and a focused pull request after the one-time repository bootstrap.
2. Link each behavior change to its Evidence ID, state/guard oracle, ledger vector, contract vector, or explicit exclusion.
3. Modify normative CI/security policy, ledger invariants, or conformance oracles in a separate pull request before implementation that depends on the change.
4. Include normal, failure, duplicate, out-of-order, crash, and recovery tests where the evidence card requires them.
5. Record reproducible review commands and results. Authors do not count as the independent reviewer for financial, authorization, irreversible service, Provider trust, migration, or recovery changes.
6. Update `VERSION`, `CHANGELOG.md`, relevant documentation, and compatibility metadata when the version policy requires it.

Never weaken a required check, rewrite protected history, dismiss review, or use an administrative bypass to merge.

## Commit and pull-request hygiene

- Stage only intended paths and inspect the staged diff.
- Use clear, scoped commit messages.
- Keep generated files reproducible and identify their source.
- Pin CI actions to full commit SHAs and container images to immutable digests. Docker action metadata must use a digest-pinned `docker://` image; local Dockerfile actions are rejected until a separately reviewed build-provenance policy exists.
- Every workflow uses only the repository's explicit GitHub-hosted runner allowlist. Self-hosted, custom-label, matrix-selected, and expression-selected runners are fail-closed; any future deployment exception requires a separately reviewed protected-environment policy before it can enter the allowlist.
- Workflow jobs and steps may not mask failures with `continue-on-error`; only the literal value `false` is accepted when that key is present.
- Conditional workflow execution is fail-closed during bootstrap: an `if` key may only be the literal `true`. Workflows reachable from an untrusted trigger cannot reference repository secrets or protected environments.
- The `bootstrap-policy` check name, triggers, least-privilege permissions, exact install/check commands, and pinned checkout, runtime, and secret-scanner identities are structural invariants enforced by the repository validator.
- During bootstrap, `bootstrap-policy.yml` is the only permitted workflow and local actions are disabled. It invokes the specification tests and validator by their fixed Node commands rather than a mutable package-script alias; bootstrap package scripts, runtime pins, and validator dependencies are themselves exact policy inputs.
- Bootstrap workflows cannot reference `secrets`, `github.token`, an environment, or `read-all`. A future build or deployment workflow requires a separately reviewed protected-branch/tag, Gate, artifact, and environment policy before it can be added.
- Keep untrusted pull requests read-only and free of deployment or repository secrets.
