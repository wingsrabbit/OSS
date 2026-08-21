<!-- SPDX-License-Identifier: Apache-2.0 -->

# License boundary

The repository uses explicit SPDX identifiers and package/directory metadata to avoid license ambiguity.

- Core, Web, Worker, shared domain/application/database packages, and core administration tools: `AGPL-3.0-or-later`.
- OpenAPI, JSON Schema, event schema, Provider Contract, generators, official SDK, conformance vectors, and schema-only clients: `Apache-2.0`.
- Reference and Mock Providers: `Apache-2.0`.
- The vendored Noto Sans SC variable TrueType font used in invoice PDFs:
  `OFL-1.1`;
  see [OFL-1.1-Noto-Sans-CJK.txt](OFL-1.1-Noto-Sans-CJK.txt) and its adjacent
  source metadata under `apps/api/assets/fonts`.
- Third-party out-of-process Providers may use other compatible licenses because they communicate only through the published process boundary and contracts.

The root [LICENSE](../LICENSE) contains the GNU Affero General Public License text. [Apache-2.0.txt](Apache-2.0.txt) contains the Apache License 2.0 text. A file-level SPDX identifier or the nearest package metadata is authoritative for the applicable choice above.
