#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { assertProviderDocument } from "./validator.js";
import type { ProviderDocumentKind } from "./types.js";

const kinds = new Set<ProviderDocumentKind>([
  "manifest",
  "operation-request",
  "operation-result",
  "event",
  "event-page",
]);
const kind = process.argv[2] as ProviderDocumentKind | undefined;
const path = process.argv[3];

if (!kind || !kinds.has(kind) || !path) {
  console.error(
    "usage: opensales-provider-validate <manifest|operation-request|operation-result|event|event-page> <document.json>",
  );
  process.exitCode = 2;
} else {
  const document: unknown = JSON.parse(await readFile(path, "utf8"));
  assertProviderDocument(kind, document);
  console.log(`valid ${kind}: ${path}`);
}
