<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# G0 policy-foundation role-separated review

> **NOT FOR PRODUCTION — MOCK PROVIDERS ONLY**

Recorded at: `2026-07-18T12:08:18Z`

This is engineering review evidence for the `0.1.0` policy-foundation pull
request. It is not a G0 exit report, release approval, independent professional
certification, or approval to run against production or real Providers.

## Roles and reviewed boundary

The primary integration role authored and integrated the change. Three separate
roles independently reviewed authorization and inventory closure, Git history
and Gate integrity, and the complete policy surface. No review role authored the
implementation it reviewed.

The reviewed policy surface is the following path-ordered 15-file set. The
aggregate is SHA-256 over the exact `shasum -a 256` output lines in this order:

`cb0ef8cec0b70bbae3b5cea27a4948e5fffcc6edb529927f674eb70b937ca65e`

| Path | SHA-256 |
| --- | --- |
| `CHANGELOG.md` | `55c6351ad93a44652f2674cecea975fca28bc484c03bacd1213e9d224dadee03` |
| `README.md` | `c3125723d5543dc7d1ad4f48e96cf8d58b70a4dfbfd663417513245fbf407539` |
| `VERSION` | `e9dd8507f4bf0c6f42458e41aea833ad0bd3f6127272335eee9bf4d58541ed67` |
| `docs/gates/README.md` | `2b96bbc5db7de7731a1aeb845484071e0f987a8d4bbb6a9861e6e27bfb97ed42` |
| `docs/gates/gate-exit-report.schema.json` | `1c6e8b4f864fced4d7fc2cb1882e1929580aff03012dd31b61b58b07b865367d` |
| `docs/gates/gate-exit-report.template.yaml` | `8699d2fb3a5d36e503dfadcbfc25a9df4495b56866287e2b76d49017ce7b826d` |
| `docs/governance/README.md` | `ff8d8221950b1f73a733c9900af05f3ae313a5f8563adaf6d885a851ac9b3c0e` |
| `docs/governance/deviation-approval.schema.json` | `c062e6b11136bc1c2c6ae9fb0233b760916705183663ad523d0867ab135fa951` |
| `docs/provenance/README.md` | `f5c2402fb0d6d5f92360965fb47db1fbda7d4812f78e52fd8b893f096dbe4f3a` |
| `docs/provenance/evidence-card.schema.json` | `9f3382e7560fb4ad8b3a2dfc3e3ae6ea0e21d0a740fac32a3f4a4cb9d2e7fd83` |
| `docs/provenance/evidence-card.template.yaml` | `170b1ecee97c72c78d7f78effc1022640a9e7434906f54320cc0ce2d293bf382` |
| `docs/provenance/evidence-inventory.schema.json` | `03560065d45571deb0f787771d19e420cb635349b76c3232da33b7345b615162` |
| `package.json` | `dee7efadd4bf754b42702b3c992d3e1fa78b6c379df536e9b6b94f1975602d95` |
| `tools/validate-specifications.mjs` | `f0e525db5fdeaf067b45b6dce79a98cf181eb16639df6fa379119f6e4f7e7fed` |
| `tools/validate-specifications.test.mjs` | `b7c0422e61d4e28db6da0d6a0e96a6fbedb7d55baf902ee4901643c94c544d04` |

The review also verified these controlling anchors against their actual bytes:

- Governing Goal SHA-256:
  `9cd354eacdc194b94d03ced6e986687da71f8cb58bdb50450c2ff91bca843392`
- Private Scope Confirmation Record SHA-256 only:
  `59447dea237574d67bad0e07734d77c76ae09fad53d731b5e3c2368223fd8977`
- Public Scope Summary SHA-256:
  `81deb422cde10d5f62502024135bcddd2840f962bd90feb1720ceead7c6320d7`

The private record and its controlled path remain outside Git.

## Review progression

1. Authorization/inventory review initially rejected repository-authored Owner
   assertions, one-way Gate deviation closure, weak narrative fields, ambiguous
   review roles, invalid chronology, and overclaimed machine proof of semantic
   atomicity. The final policy admits only the two explicit Goal Owner decisions,
   requires exact same-commit Feature closure, rejects meaningless text and role
   collisions, enforces chronology, and requires an explicit role-separated
   semantic-decomposition review covering every Requirement, Feature, and check.
2. History review required every reachable Git parent edge and the complete
   `VERSION`/package/README/changelog bundle to be validated. It then reproduced
   two later blockers: semantic YAML comparison allowed byte-only edits to a
   committed Gate report, and custom replace-ref namespaces or legacy grafts
   could rewrite the DAG seen by the validator. The final policy compares Gate
   report blob bytes across all parent edges and the working tree, disables
   replacement objects for normative reads, clears repository-redirection
   environment inputs, and rejects shallow history, standard/custom replace
   state, and graft files.
3. Holistic review verified the complete final aggregate after those repairs.
   It found no P0/P1 issue, no private-data leak, no unsupported claim that
   structural checks alone prove semantic atomicity, and no artifact that could
   truthfully open G0.

All three final review conclusions were `NO BLOCKER` and independently bound to
the exact aggregate above. The authorization/inventory and history reviewers
each replayed eight focused adversarial tests. The holistic reviewer reran the
entire check suite.

## Reproduction and observed results

| Check | Result |
| --- | --- |
| `pnpm check` with Node `24.18.0` and pnpm `11.14.0` | 55/55 tests passed; 9 schemas and all recognized specification documents validated |
| Authorization/inventory focused adversarial suite | 8/8 passed |
| History/Gate focused adversarial suite | 8/8 passed |
| `git diff --check` | Passed |
| JSON parsing with `jq` for every changed/new JSON policy file | Passed |
| Gitleaks v8.30.1 working-tree scan | No leaks found |
| Gitleaks v8.30.1 reachable-history scan | No leaks found |
| `pnpm audit --prod --audit-level=high` | No known vulnerabilities found |

The checked regressions include self-asserted and unknown deviations, exact
Feature-set closure, invisible and punctuation-only narratives, role collisions,
future and reversed timestamps, hidden side-branch rewrites, synchronized
version-bundle history, later-card and later-approval retroactivity, byte-only
edits to active and superseded Gate reports, shallow clones, standard and custom
replace refs, and legacy grafts.

## Conclusion and remaining boundary

`GO` applies only to committing and merging this `0.1.0` policy foundation
through the protected pull-request workflow. G0 remains `NO-GO`. There is no
frozen G0 Evidence Inventory, concrete Feature Evidence Card set, mandatory
oracle pack, application, Provider, database, deployment, release candidate, or
production artifact in this change. Earlier generated inventory drafts were
explicitly rejected and are not part of the repository.

The next policy-controlled work must regenerate the atomic G0 Evidence Inventory
from the governing Goal and Scope bindings, receive a separate role-separated
freeze review, and then build each required oracle without retroactively treating
this policy review as Feature or Gate evidence.
