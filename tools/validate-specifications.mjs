// SPDX-License-Identifier: AGPL-3.0-or-later
// NOT FOR PRODUCTION — MOCK PROVIDERS ONLY

import { createHash } from "node:crypto";
import { execFileSync as rawExecFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import YAML from "yaml";

const GIT_REPOSITORY_OVERRIDE_ENVIRONMENT = Object.freeze([
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_DIR",
  "GIT_INDEX_FILE",
  "GIT_NAMESPACE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_REPLACE_REF_BASE",
  "GIT_SHALLOW_FILE",
  "GIT_WORK_TREE",
]);

function execFileSync(file, args, options = {}) {
  if (file !== "git") return rawExecFileSync(file, args, options);
  const environment = { ...process.env, ...(options.env ?? {}) };
  for (const name of GIT_REPOSITORY_OVERRIDE_ENVIRONMENT) delete environment[name];
  environment.GIT_NO_REPLACE_OBJECTS = "1";
  return rawExecFileSync(file, args, { ...options, env: environment });
}

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(HERE, "..");

const SCHEMA_FILES = Object.freeze({
  evidence: "docs/provenance/evidence-card.schema.json",
  inventory: "docs/provenance/evidence-inventory.schema.json",
  deviation: "docs/governance/deviation-approval.schema.json",
  state: "docs/specifications/state-transition-table.schema.json",
  guard: "docs/specifications/guard-rbac-matrix.schema.json",
  ledger: "docs/specifications/ledger-posting-matrix.schema.json",
  ledgerArtifact: "docs/specifications/ledger-golden-artifact.schema.json",
  oracle: "docs/specifications/g0-oracle.schema.json",
  gate: "docs/gates/gate-exit-report.schema.json",
});

const AUTHORITY_RANKS = Object.freeze({
  owner_decision: 1,
  goal_specification: 1,
  financial_security_or_permission_invariant: 2,
  audited_black_box_behavior: 3,
  legacy_observation: 4,
  public_behavior: 4,
  other: 4,
});

const NEXT_GATE = Object.freeze({
  G0: "G1",
  G1: "G2",
  G2: "G3",
  G3: "G4",
  G4: "G5",
  G5: "G6",
  G6: "G7",
  G7: "G8",
  G8: "G9",
  G9: "none",
});

const GATE_INDEX = new Map(
  ["G0", "G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8", "G9", "POST_GOAL"].map(
    (gate, index) => [gate, index],
  ),
);

const MAX_HIGH_RISK_ACCEPTANCE_MS = 30 * 24 * 60 * 60 * 1000;
const VALIDATION_CLOCK_SKEW_MS = 5 * 60 * 1000;
const NON_MEANINGFUL_TEXT =
  /[\p{White_Space}\p{Default_Ignorable_Code_Point}\p{Cc}\p{Cf}\p{Cs}]/gu;
const PLACEHOLDER_TEXT =
  /^(?:todo|tbd|placeholder|changeme|unknown|replaceme|replacewith.*)[.!]?$/iu;
const ROLE_ID = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const TRUSTED_WORKFLOW_RUNNERS = new Set(["ubuntu-24.04", "windows-2025", "macos-15"]);
const EXPECTED_BOOTSTRAP_WORKFLOW_DIGEST =
  "sha256:9397a19b2445d86115f63980d65adfad93b46074b39b18fd094fe862fa6357af";
const TRUSTED_BOOTSTRAP_COMMIT = "ca8f5ec048b5779bc753249f63a0297154028a0e";
const EXPECTED_PACKAGE_MANAGER =
  "pnpm@11.14.0+sha512.66c1ac4c7d4762d6d7dde44c7f3e5a73591ed0a0806e751d4ed32d4f004f25b2285a906b1fd8a9e3e621df3b4e2858bf88e50e0cf626bedbe977fe434a5caf85";
const EXPECTED_PACKAGE_SCRIPTS = Object.freeze({
  check: "node --test tools/validate-specifications.test.mjs && node tools/validate-specifications.mjs",
  "test:specifications": "node --test tools/validate-specifications.test.mjs",
  "validate:specifications": "node tools/validate-specifications.mjs",
});
const EXPECTED_BOOTSTRAP_DEPENDENCIES = Object.freeze({
  ajv: "8.20.0",
  "ajv-formats": "3.0.1",
  yaml: "2.9.0",
});
const TRUSTED_GOAL_SOURCE_ID = "cloud-termrat-core-goal-prompt";
const TRUSTED_GOAL_SOURCE_SHA256 =
  "9cd354eacdc194b94d03ced6e986687da71f8cb58bdb50450c2ff91bca843392";
const TRUSTED_GOAL_SOURCE_LINES = 1070;
const TRUSTED_SCOPE_SUMMARY_REFERENCE = "repo:docs/governance/scope-summary.json";
const TRUSTED_SCOPE_SUMMARY_DIGEST =
  "sha256:81deb422cde10d5f62502024135bcddd2840f962bd90feb1720ceead7c6320d7";
const TRUSTED_PRIVATE_SCOPE_RECORD_DIGEST =
  "sha256:59447dea237574d67bad0e07734d77c76ae09fad53d731b5e3c2368223fd8977";
const TRUSTED_OWNER_DEVIATIONS = Object.freeze({
  "DEVIATION-MFA-OPTIONAL": Object.freeze({
    authorization_key: "OWNER-AUTH-MFA-OPTIONAL",
    title: "Keep customer and Staff MFA optional",
    approved_change:
      "Customer and Staff MFA remain optional rather than mandatory.",
    constraints: Object.freeze([
      "High-risk actions still require password re-entry.",
      "When Staff voluntarily enables MFA, qualifying step-up also requires the configured factor.",
      "Break-glass, immutable audit, and configured dual-review controls remain required.",
    ]),
    authorization_anchor: Object.freeze({
      reference: "goal://cloud-termrat-core-goal-prompt#L337-L337",
      line_start: 337,
      line_end: 337,
      content_digest: `sha256:${TRUSTED_GOAL_SOURCE_SHA256}`,
    }),
  }),
  "DEVIATION-TERMRAT-USD-ONLY": Object.freeze({
    authorization_key: "OWNER-AUTH-TERMRAT-USD-ONLY",
    title: "Keep the new TermRat deployment USD-only",
    approved_change:
      "The new TermRat deployment enables USD only and does not re-enable historical HKD behavior.",
    constraints: Object.freeze([
      "Core may support multiple fiat currencies, but each order and invoice keeps one immutable currency.",
      "USDT remains a payment asset and is not a TermRat invoice currency.",
      "No automatic exchange-rate process may silently rewrite historical prices.",
    ]),
    authorization_anchor: Object.freeze({
      reference: "goal://cloud-termrat-core-goal-prompt#L482-L483",
      line_start: 482,
      line_end: 483,
      content_digest: `sha256:${TRUSTED_GOAL_SOURCE_SHA256}`,
    }),
  }),
});
const REQUIRED_INVENTORY_REVIEW_CHECKS = Object.freeze([
  "atomic_single_obligation",
  "source_fidelity",
  "feature_cohesion",
  "classification_and_disposition",
  "scope_and_deviation",
  "gate_deadline",
]);
const TRUSTED_LEDGER_RUNNER_DIGEST =
  "sha256:86fd5c597ba87f15b5c0d09bdb67579f34420f7e00ecd6c72e5b770c11467c97";
const PRIORITY_INDEX = new Map(["P0", "P1", "P2", "P3"].map((priority, index) => [priority, index]));
const FROZEN_EVIDENCE_STATUSES = Object.freeze([
  "frozen",
  "implemented",
  "verified",
  "superseded",
]);
const EVIDENCE_LIFECYCLE_TRANSITIONS = Object.freeze({
  frozen: new Set(["frozen", "implemented", "verified", "superseded"]),
  implemented: new Set(["implemented", "verified", "superseded"]),
  verified: new Set(["verified", "superseded"]),
  superseded: new Set(["superseded"]),
});
const SOURCE_VERIFICATION_TRANSITIONS = Object.freeze({
  unknown: new Set(["unknown"]),
  not_authorized_to_verify: new Set(["not_authorized_to_verify"]),
  frozen: new Set(["frozen", "verified"]),
  verified: new Set(["verified"]),
});
const G0_ORACLE_CATEGORIES = Object.freeze({
  evidence_inventories: {
    recordKind: "inventory",
    pathPrefix: "docs/provenance/",
  },
  state_transition_tables: {
    recordKind: "state",
    pathPrefix: "docs/specifications/",
  },
  guard_rbac_matrices: {
    recordKind: "guard",
    pathPrefix: "docs/specifications/",
  },
  ledger_posting_matrices: {
    recordKind: "ledger",
    pathPrefix: "docs/specifications/",
  },
  transport_contracts: {
    recordKind: "oracle",
    oracleKind: "transport_contracts",
    pathPrefix: "docs/contracts/transport/",
  },
  provider_contracts: {
    recordKind: "oracle",
    oracleKind: "provider_contracts",
    pathPrefix: "docs/contracts/providers/",
  },
  data_retention_models: {
    recordKind: "oracle",
    oracleKind: "data_retention_models",
    pathPrefix: "docs/governance/data-retention/",
  },
  threat_models: {
    recordKind: "oracle",
    oracleKind: "threat_models",
    pathPrefix: "docs/threat-model/",
  },
  test_strategies: {
    recordKind: "oracle",
    oracleKind: "test_strategies",
    pathPrefix: "docs/testing/",
  },
});

const GOAL_SECTION_RANGES = Object.freeze([
  ["SECTION-0", 1, 19],
  ["SECTION-1", 20, 63],
  ["SECTION-2", 64, 75],
  ["SECTION-3", 76, 98],
  ["SECTION-4", 99, 133],
  ["SECTION-5", 134, 188],
  ["SECTION-6", 189, 261],
  ["SECTION-7", 262, 342],
  ["SECTION-8", 343, 400],
  ["SECTION-9", 401, 459],
  ["SECTION-10", 460, 545],
  ["SECTION-11", 546, 584],
  ["SECTION-12", 585, 622],
  ["SECTION-13", 623, 675],
  ["SECTION-14", 676, 719],
  ["SECTION-15", 720, 773],
  ["SECTION-16", 774, 853],
  ["SECTION-17", 854, 949],
  ["SECTION-18", 950, 1006],
  ["SECTION-19", 1007, 1034],
  ["SECTION-20", 1035, 1054],
  ["SECTION-21", 1055, 1070],
  ["SECTION-3-1", 78, 85],
  ["SECTION-3-2", 86, 94],
  ["SECTION-3-3", 95, 98],
  ["SECTION-6-1", 191, 212],
  ["SECTION-6-2", 213, 237],
  ["SECTION-6-3", 238, 250],
  ["SECTION-6-4", 251, 261],
  ["SECTION-7-1", 264, 273],
  ["SECTION-7-2", 274, 301],
  ["SECTION-7-3", 302, 319],
  ["SECTION-7-4", 320, 327],
  ["SECTION-7-5", 328, 338],
  ["SECTION-7-6", 339, 342],
  ["SECTION-8-1", 345, 358],
  ["SECTION-8-2", 359, 366],
  ["SECTION-8-3", 367, 384],
  ["SECTION-8-4", 385, 400],
  ["SECTION-10-1", 462, 479],
  ["SECTION-10-2", 480, 488],
  ["SECTION-10-3", 489, 510],
  ["SECTION-10-4", 511, 524],
  ["SECTION-10-5", 525, 536],
  ["SECTION-10-6", 537, 545],
  ["SECTION-13-1", 625, 641],
  ["SECTION-13-2", 642, 656],
  ["SECTION-13-3", 657, 666],
  ["SECTION-13-4", 667, 675],
  ["SECTION-14-1", 678, 685],
  ["SECTION-14-2", 686, 703],
  ["SECTION-14-3", 704, 719],
  ["SECTION-15-1", 722, 735],
  ["SECTION-15-2", 736, 753],
  ["SECTION-15-3", 754, 773],
  ["SECTION-16-1", 776, 816],
  ["SECTION-16-2", 817, 828],
  ["SECTION-16-3", 829, 853],
  ["SECTION-17-G0", 858, 867],
  ["SECTION-17-G1", 868, 876],
  ["SECTION-17-G2", 877, 885],
  ["SECTION-17-G3", 886, 893],
  ["SECTION-17-G4", 894, 903],
  ["SECTION-17-G5", 904, 910],
  ["SECTION-17-G6", 911, 922],
  ["SECTION-17-G7", 923, 929],
  ["SECTION-17-G8", 930, 937],
  ["SECTION-17-G9", 938, 947],
  ["SECTION-18-IDENTITY-AUTHORIZATION", 954, 962],
  ["SECTION-18-MONEY", 963, 979],
  ["SECTION-18-SERVICE", 980, 994],
  ["SECTION-18-DEPLOYMENT-RECOVERY", 995, 1006],
]);
const REQUIRED_GOAL_SECTION_IDS = Object.freeze(
  GOAL_SECTION_RANGES.map(([sectionId]) => sectionId),
);

const REQUIRED_STATE_AGGREGATE_IDS = Object.freeze([
  "AGGREGATE-USER",
  "AGGREGATE-CLIENT-ACCOUNT",
  "AGGREGATE-MEMBERSHIP",
  "AGGREGATE-QUOTE",
  "AGGREGATE-ORDER",
  "AGGREGATE-INVOICE",
  "AGGREGATE-SUBSCRIPTION",
  "AGGREGATE-PAYMENT-INTENT",
  "AGGREGATE-PAYMENT",
  "AGGREGATE-ALLOCATION",
  "AGGREGATE-TOPUP-INTENT",
  "AGGREGATE-STORED-PAYMENT-METHOD",
  "AGGREGATE-AUTOPAY-MANDATE",
  "AGGREGATE-REFUND",
  "AGGREGATE-CHARGEBACK",
  "AGGREGATE-SERVICE",
  "AGGREGATE-OPERATION",
]);

const REQUIRED_STATES_BY_AGGREGATE = Object.freeze({
  "AGGREGATE-ORDER": [
    "STATE-ORDER-DRAFT",
    "STATE-ORDER-PENDING-PAYMENT",
    "STATE-ORDER-PENDING-REVIEW",
    "STATE-ORDER-ACCEPTED",
    "STATE-ORDER-REJECTED",
    "STATE-ORDER-FRAUD",
    "STATE-ORDER-CANCELLED",
    "STATE-ORDER-FULFILLED",
  ],
  "AGGREGATE-SERVICE": [
    "STATE-SERVICE-PENDING",
    "STATE-SERVICE-AWAITING-MANUAL-REVIEW",
    "STATE-SERVICE-PROVISIONING",
    "STATE-SERVICE-RECONCILING",
    "STATE-SERVICE-PROVISION-FAILED",
    "STATE-SERVICE-ACTIVE",
    "STATE-SERVICE-SUSPENSION-PENDING",
    "STATE-SERVICE-SUSPENDED",
    "STATE-SERVICE-UNSUSPENSION-PENDING",
    "STATE-SERVICE-CANCELLATION-SCHEDULED",
    "STATE-SERVICE-TERMINATION-PENDING",
    "STATE-SERVICE-TERMINATED",
  ],
  "AGGREGATE-OPERATION": [
    "STATE-OPERATION-QUEUED",
    "STATE-OPERATION-RUNNING",
    "STATE-OPERATION-RECONCILING",
    "STATE-OPERATION-SUCCEEDED",
    "STATE-OPERATION-FAILED",
  ],
});

const REQUIRED_GUARD_RESOURCE_IDS = Object.freeze([
  "RESOURCE-USER",
  "RESOURCE-CLIENT-ACCOUNT",
  "RESOURCE-MEMBERSHIP",
  "RESOURCE-STAFF",
  "RESOURCE-PROVIDER",
]);

const REQUIRED_GUARD_COMBINATION_IDS = Object.freeze([
  "COMBINATION-OWNER-RESTRICTED-MEMBER-ACTIVE",
  "COMBINATION-CLIENT-ACCOUNT-RESTRICTED",
  "COMBINATION-CLIENT-ACCOUNT-RESTORED",
]);

const REQUIRED_LEDGER_EVENT_IDS = Object.freeze([
  "EVENT-INVOICE-ISSUED",
  "EVENT-INVOICE-VOIDED",
  "EVENT-INVOICE-CORRECTED",
  "EVENT-PAYMENT-SETTLED",
  "EVENT-ALLOCATION-POSTED",
  "EVENT-CREDIT-POSTED",
  "EVENT-UNAPPLIED-FUNDS-RECORDED",
  "EVENT-SURCHARGE-ASSESSED",
  "EVENT-LATE-FEE-ASSESSED",
  "EVENT-TOPUP-SETTLED",
  "EVENT-REFUND-COMPLETED",
  "EVENT-CHARGEBACK-RECORDED",
  "EVENT-WRITEOFF-RECORDED",
  "EVENT-MANUAL-CORRECTION-RECORDED",
]);

const REQUIRED_LEDGER_ACCOUNT_IDS = Object.freeze([
  "ACCOUNT-REVENUE",
  "ACCOUNT-DEFERRED-REVENUE",
  "ACCOUNT-TAX-PAYABLE",
  "ACCOUNT-PROCESSOR-CLEARING",
  "ACCOUNT-CUSTOMER-CREDIT-LIABILITY",
  "ACCOUNT-UNAPPLIED-FUNDS-LIABILITY",
]);

const REQUIRED_LEDGER_AMOUNT_IDS = Object.freeze([
  "AMOUNT-COLLECTIBLE-TOTAL",
  "AMOUNT-ALLOCATED-TOTAL",
  "AMOUNT-OUTSTANDING",
]);

const REQUIRED_LEDGER_COMMAND_IDS = Object.freeze([
  "COMMAND-RECORD-MANUAL-PAYMENT",
  "COMMAND-RECORD-MANUAL-TOPUP",
  "COMMAND-RECORD-MANUAL-REFUND",
  "COMMAND-RECORD-MANUAL-CORRECTION",
]);
const REQUIRED_MANUAL_PAYMENT_FIELDS = Object.freeze([
  "external_reference",
  "received_at",
  "amount",
  "currency_or_asset",
  "actual_fee",
  "payment_source_summary",
  "actor",
  "reason",
  "evidence_reference",
]);
const REQUIRED_MANUAL_PAYMENT_DESTINATIONS = Object.freeze(["invoice", "unapplied_funds"]);
const REQUIRED_DERIVED_AMOUNT_FORMULAS = Object.freeze({
  "AMOUNT-COLLECTIBLE-TOTAL": {
    op: "sum",
    values: [
      { op: "input", input_id: "INPUT-ACTIVE-LINE-SNAPSHOT-TOTAL" },
      { op: "input", input_id: "INPUT-APPEND-ONLY-CORRECTION-TOTAL" },
    ],
  },
  "AMOUNT-ALLOCATED-TOTAL": {
    op: "sum",
    values: [
      { op: "input", input_id: "INPUT-SETTLED-UNREVERSED-PAYMENT-ALLOCATION-TOTAL" },
      { op: "input", input_id: "INPUT-SETTLED-UNREVERSED-CREDIT-ALLOCATION-TOTAL" },
    ],
  },
  "AMOUNT-OUTSTANDING": {
    op: "clamp_min_zero",
    value: {
      op: "subtract",
      left: { op: "amount", amount_id: "AMOUNT-COLLECTIBLE-TOTAL" },
      right: { op: "amount", amount_id: "AMOUNT-ALLOCATED-TOTAL" },
    },
  },
});

const REQUIRED_GENERIC_ORACLE_COVERAGE = Object.freeze({
  transport_contracts: [
    "COVERAGE-ENVELOPE",
    "COVERAGE-IDEMPOTENCY",
    "COVERAGE-EVENT",
    "COVERAGE-WEBHOOK",
    "COVERAGE-RETRY",
    "COVERAGE-RECONCILE",
  ],
  provider_contracts: [
    "COVERAGE-PROVIDER-TRUST",
    "COVERAGE-PROVIDER-REVOCATION",
    "COVERAGE-PROVIDER-SCOPE",
    "COVERAGE-PROVIDER-EGRESS",
    "COVERAGE-CAPABILITY-PAYMENT-V1ALPHA",
    "COVERAGE-CAPABILITY-PROVISIONING-V1ALPHA",
    "COVERAGE-CAPABILITY-VERIFICATION-V1ALPHA",
    "COVERAGE-CAPABILITY-MAIL-V1ALPHA",
    "COVERAGE-CAPABILITY-TAX-V1ALPHA",
    "COVERAGE-CAPABILITY-ANTIABUSE-V1ALPHA",
  ],
  data_retention_models: [
    "DATA-RAW-WEBHOOK",
    "DATA-PAYMENT-EVIDENCE",
    "DATA-VERIFICATION-EVIDENCE",
    "DATA-ATTACHMENT",
    "DATA-IP-USER-AGENT",
    "DATA-APPLICATION-LOG",
    "DATA-SECURITY-LOG",
    "DATA-EXPORT",
    "DATA-SESSION",
    "DATA-LEDGER-AUDIT",
    "DATA-BACKUP",
  ],
  threat_models: [
    "THREAT-IDENTITY",
    "THREAT-AUTHORIZATION",
    "THREAT-FINANCIAL",
    "THREAT-PROVIDER",
    "THREAT-WEBHOOK",
    "THREAT-SSRF-EGRESS",
    "THREAT-SUPPLY-CHAIN",
    "THREAT-SECRET-PII",
    "THREAT-RECOVERY",
  ],
  test_strategies: [
    "SCENARIO-NORMAL",
    "SCENARIO-FAILURE",
    "SCENARIO-DUPLICATE",
    "SCENARIO-OUT-OF-ORDER",
    "SCENARIO-CRASH",
    "SCENARIO-RECOVERY",
    "SCENARIO-CONCURRENCY",
    "SCENARIO-MUTATION",
    "SCENARIO-MALICIOUS-PROVIDER",
    "SCENARIO-SCHEMA-ONLY-CLIENT",
    "SCENARIO-FAULT-PROXY",
  ],
});

function list(value) {
  return Array.isArray(value) ? value : [];
}

function normalizedNarrative(value) {
  if (typeof value !== "string") return "";
  return value.normalize("NFKC").replace(NON_MEANINGFUL_TEXT, "");
}

function narrativeIssues(value, label, { minimumLettersOrNumbers = 1, rejectPlaceholder = true } = {}) {
  if (typeof value !== "string") return [];
  const normalized = normalizedNarrative(value);
  const lettersOrNumbers = normalized.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
  const issues = [];
  if (!normalized || lettersOrNumbers < minimumLettersOrNumbers) {
    issues.push(
      `${label}: must contain at least ${minimumLettersOrNumbers} visible Unicode letter or number${minimumLettersOrNumbers === 1 ? "" : "s"}`,
    );
  }
  if (rejectPlaceholder && PLACEHOLDER_TEXT.test(normalized)) {
    issues.push(`${label}: must not be placeholder text`);
  }
  return issues;
}

function normalizedNarrativeKey(value) {
  return normalizedNarrative(value).toLocaleLowerCase("en-US").replace(/[^\p{L}\p{N}]/gu, "");
}

function chronologyIssues(createdAtValue, updatedAtValue, label) {
  const issues = [];
  const createdAt = Date.parse(createdAtValue ?? "");
  const updatedAt = Date.parse(updatedAtValue ?? "");
  const latestAllowed = Date.now() + VALIDATION_CLOCK_SKEW_MS;
  if (Number.isFinite(createdAt) && createdAt > latestAllowed) {
    issues.push(`${label}: created_at cannot be in the future`);
  }
  if (Number.isFinite(updatedAt) && updatedAt > latestAllowed) {
    issues.push(`${label}: updated_at cannot be in the future`);
  }
  if (Number.isFinite(createdAt) && Number.isFinite(updatedAt) && updatedAt < createdAt) {
    issues.push(`${label}: updated_at cannot precede created_at`);
  }
  return issues;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function contentDigest(document, pathToDigest) {
  const copy = JSON.parse(JSON.stringify(document));
  let parent = copy;
  for (const segment of pathToDigest.slice(0, -1)) parent = parent?.[segment];
  if (parent && typeof parent === "object") delete parent[pathToDigest.at(-1)];
  return `sha256:${createHash("sha256").update(canonicalJson(copy)).digest("hex")}`;
}

function ledgerMatrixSemanticDigest(document) {
  const copy = JSON.parse(JSON.stringify(document));
  delete copy.golden_runner;
  delete copy.review;
  return `sha256:${createHash("sha256").update(canonicalJson(copy)).digest("hex")}`;
}

function idSet(items, key) {
  return new Set(list(items).map((item) => item?.[key]).filter(Boolean));
}

function duplicateIdIssues(items, key, label) {
  const seen = new Set();
  const issues = [];
  for (const item of list(items)) {
    const id = item?.[key];
    if (!id) continue;
    if (seen.has(id)) issues.push(`${label}: duplicate ${key} ${id}`);
    seen.add(id);
  }
  return issues;
}

function missingRefIssues(values, known, label) {
  return list(values)
    .filter((value) => !known.has(value))
    .map((value) => `${label}: unresolved reference ${value}`);
}

function expressionReferenceSets(expression, depth = 0, budget = { nodes: 0 }) {
  const result = { inputs: new Set(), amounts: new Set(), roundingRules: new Set(), issues: [] };
  const merge = (child) => {
    for (const value of child.inputs) result.inputs.add(value);
    for (const value of child.amounts) result.amounts.add(value);
    for (const value of child.roundingRules) result.roundingRules.add(value);
    result.issues.push(...child.issues);
  };
  budget.nodes += 1;
  if (depth > 32 || budget.nodes > 1024) {
    result.issues.push("expression exceeds the depth or node limit");
    return result;
  }
  if (!expression || typeof expression !== "object" || Array.isArray(expression)) return result;
  if (expression.op === "input" && expression.input_id) result.inputs.add(expression.input_id);
  if (expression.op === "amount" && expression.amount_id) result.amounts.add(expression.amount_id);
  if (expression.op === "multiply_ratio_round" && expression.rounding_rule_id) {
    result.roundingRules.add(expression.rounding_rule_id);
  }
  const children = [];
  if (Array.isArray(expression.values)) children.push(...expression.values);
  for (const key of ["left", "right", "value"]) {
    if (expression[key] && typeof expression[key] === "object") children.push(expression[key]);
  }
  for (const child of children) merge(expressionReferenceSets(child, depth + 1, budget));
  return result;
}

function reviewIssues(review, label) {
  const issues = [];
  const authorRole = review?.author_role;
  const reviewerRoles = list(review?.reviewer_roles);
  if (typeof authorRole === "string" && !ROLE_ID.test(authorRole)) {
    issues.push(`${label}: author_role must be a canonical lowercase role id`);
  }
  for (const reviewerRole of reviewerRoles) {
    if (typeof reviewerRole === "string" && !ROLE_ID.test(reviewerRole)) {
      issues.push(`${label}: reviewer role must be a canonical lowercase role id`);
    }
  }
  if (new Set(reviewerRoles).size !== reviewerRoles.length) {
    issues.push(`${label}: reviewer roles must be unique`);
  }
  if (reviewerRoles.includes(authorRole)) {
    issues.push(`${label}: author role cannot also be a reviewer role`);
  }
  for (const [index, finding] of list(review?.findings).entries()) {
    issues.push(...narrativeIssues(finding, `${label}.findings.${index}`));
  }
  if (review?.status !== "passed") return issues;
  if (review.independent_review !== true) {
    issues.push(`${label}: passed review must be independent`);
  }
  if (list(review.reproduction_commands).length === 0) {
    issues.push(`${label}: passed review needs a reproduction command`);
  }
  for (const [index, command] of list(review.reproduction_commands).entries()) {
    issues.push(
      ...narrativeIssues(command, `${label}.reproduction_commands.${index}`, {
        minimumLettersOrNumbers: 2,
      }),
    );
  }
  const artifacts = review.evidence_refs ?? review.artifact_refs;
  if (list(artifacts).length === 0) {
    issues.push(`${label}: passed review needs an evidence or artifact reference`);
  }
  for (const artifact of list(artifacts)) {
    if (typeof artifact !== "string" || !artifact.startsWith("repo:docs/reviews/")) {
      issues.push(`${label}: passed review artifacts must use repo:docs/reviews/`);
    }
  }
  return issues;
}

function evidenceIssues(document) {
  const issues = [
    ...duplicateIdIssues(document.sources, "source_id", "evidence.sources"),
    ...reviewIssues(document.review, "evidence.review"),
  ];
  const rejectPlaceholder = FROZEN_EVIDENCE_STATUSES.includes(document.lifecycle?.status);
  for (const [field, value, minimumLettersOrNumbers] of [
    ["title", document.title, 2],
    ["business_description", document.business_description, 12],
    ["classification.rationale", document.classification?.rationale, 8],
    ["classification.fail_safe_behavior", document.classification?.fail_safe_behavior, 8],
    ["data_and_trust.minimum_disclosure", document.data_and_trust?.minimum_disclosure, 8],
    ["unknown_handling.impact", document.unknown_handling?.impact, 8],
    ["unknown_handling.fail_safe", document.unknown_handling?.fail_safe, 8],
  ]) {
    if (value === undefined || value === null) continue;
    issues.push(
      ...narrativeIssues(value, `evidence.${field}`, {
        minimumLettersOrNumbers,
        rejectPlaceholder,
      }),
    );
  }
  for (const source of list(document.sources)) {
    if (source?.notes === undefined) continue;
    issues.push(
      ...narrativeIssues(source.notes, `evidence.sources.${source?.source_id}.notes`, {
        minimumLettersOrNumbers: 2,
        rejectPlaceholder,
      }),
    );
  }
  for (const scenario of Object.values(document.scenarios ?? {}).flatMap(list)) {
    const scenarioLabel = `evidence.scenarios.${scenario?.scenario_id ?? "unknown"}`;
    issues.push(
      ...narrativeIssues(scenario?.stimulus, `${scenarioLabel}.stimulus`, {
        minimumLettersOrNumbers: 4,
        rejectPlaceholder,
      }),
    );
    for (const [index, value] of list(scenario?.preconditions).entries()) {
      issues.push(
        ...narrativeIssues(value, `${scenarioLabel}.preconditions.${index}`, {
          minimumLettersOrNumbers: 2,
          rejectPlaceholder,
        }),
      );
    }
    for (const [index, value] of list(scenario?.expected_outcomes).entries()) {
      issues.push(
        ...narrativeIssues(value, `${scenarioLabel}.expected_outcomes.${index}`, {
          minimumLettersOrNumbers: 2,
          rejectPlaceholder,
        }),
      );
    }
  }

  for (const source of list(document.sources)) {
    const expected = AUTHORITY_RANKS[source?.source_type];
    if (expected !== undefined && source.authority_rank !== expected) {
      issues.push(
        `evidence.sources.${source.source_id}: ${source.source_type} must use authority rank ${expected}`,
      );
    }
    if (
      source?.line_start !== undefined &&
      source?.line_end !== undefined &&
      source.line_end < source.line_start
    ) {
      issues.push(`evidence.sources.${source.source_id}: line_end precedes line_start`);
    }
    if (
      source?.source_type === "goal_specification" &&
      Number.isInteger(source?.line_start) &&
      Number.isInteger(source?.line_end) &&
      source.reference !==
        `goal://${TRUSTED_GOAL_SOURCE_ID}#L${source.line_start}-L${source.line_end}`
    ) {
      issues.push(`evidence.sources.${source.source_id}: goal anchor fragment must match its line range`);
    }
    if (source?.source_type === "other" && !source?.notes?.trim()) {
      issues.push(`evidence.sources.${source.source_id}: other source needs an explicit note`);
    }
    if (["frozen", "verified"].includes(source?.verification_status) && !source?.content_digest) {
      issues.push(`evidence.sources.${source.source_id}: frozen source needs a content digest`);
    }
    if (
      ["frozen", "verified"].includes(source?.verification_status) &&
      source?.content_digest === `sha256:${"0".repeat(64)}`
    ) {
      issues.push(`evidence.sources.${source.source_id}: frozen source digest cannot be a placeholder`);
    }
    if (source?.verification_status === "verified" && !source?.observed_at) {
      issues.push(`evidence.sources.${source.source_id}: verified source needs observed_at`);
    }
    if (
      Number.isFinite(Date.parse(source?.observed_at ?? "")) &&
      Date.parse(source.observed_at) > Date.now() + VALIDATION_CLOCK_SKEW_MS
    ) {
      issues.push(`evidence.sources.${source.source_id}: observed_at cannot be in the future`);
    }
  }

  issues.push(
    ...chronologyIssues(
      document.lifecycle?.created_at,
      document.lifecycle?.updated_at,
      "evidence.lifecycle",
    ),
  );

  const governance = document.governance ?? {};
  if (
    governance.scope_summary?.reference !== TRUSTED_SCOPE_SUMMARY_REFERENCE ||
    governance.scope_summary?.content_digest !== TRUSTED_SCOPE_SUMMARY_DIGEST ||
    governance.private_scope_record_digest !== TRUSTED_PRIVATE_SCOPE_RECORD_DIGEST
  ) {
    issues.push("evidence.governance: card must bind the exact public and private Scope Record digests");
  }
  if (governance.approved_deviation_id) {
    const ownerDecision = list(document.sources).some(
      (source) =>
        source?.source_id === governance.approved_deviation_id &&
        source?.source_type === "owner_decision" &&
        source?.reference?.startsWith("repo:docs/governance/decisions/") &&
        ["frozen", "verified"].includes(source?.verification_status),
    );
    if (!ownerDecision) {
      issues.push(
        "evidence.governance: approved deviation needs an exactly matching frozen owner decision source",
      );
    }
  }

  const status = document.classification?.status;
  const targets = new Set(list(document.disposition?.targets));
  if (["retained", "config"].includes(status) && targets.has("exclude")) {
    issues.push(`evidence.disposition: ${status} evidence cannot target exclude`);
  }
  if (status === "excluded" && (targets.size !== 1 || !targets.has("exclude"))) {
    issues.push("evidence.disposition: excluded evidence must target only exclude");
  }
  if (status === "config" && !targets.has("deployment_config")) {
    issues.push("evidence.disposition: config evidence must target deployment_config");
  }
  if (targets.has("core") && list(document.disposition?.module_ids).length === 0) {
    issues.push("evidence.disposition: core target needs a module_id");
  }
  if (
    targets.has("provider_contract") &&
    list(document.disposition?.provider_capability_ids).length === 0
  ) {
    issues.push("evidence.disposition: provider_contract target needs a capability_id");
  }
  if (
    targets.has("deployment_config") &&
    list(document.disposition?.configuration_keys).length === 0
  ) {
    issues.push("evidence.disposition: deployment_config target needs a configuration key");
  }
  if (
    ["excluded", "quarantined"].includes(status) &&
    list(document.classification?.negative_test_refs).length === 0
  ) {
    issues.push(`evidence.classification: ${status} evidence needs a negative test`);
  }
  if (
    ["excluded", "quarantined"].includes(status) &&
    list(document.disposition?.exclusion_assertion_ids).length === 0
  ) {
    issues.push(`evidence.disposition: ${status} evidence needs an exclusion assertion`);
  }
  if (
    ["retained", "config"].includes(status) &&
    list(document.disposition?.exclusion_assertion_ids).length > 0
  ) {
    issues.push(`evidence.disposition: ${status} evidence cannot declare exclusion assertions`);
  }

  const lifecycle = document.lifecycle?.status;
  if (["frozen", "implemented", "verified", "superseded"].includes(lifecycle)) {
    if (document.review?.status !== "passed") {
      issues.push(`evidence.lifecycle: ${lifecycle} evidence needs a passed review`);
    }
    if (document.lifecycle?.content_digest !== contentDigest(document, ["lifecycle", "content_digest"])) {
      issues.push(`evidence.lifecycle: ${lifecycle} content digest does not match the card`);
    }
  }
  if (
    ["implemented", "verified"].includes(lifecycle) &&
    ["retained", "config"].includes(status) &&
    list(document.traceability?.implementation_refs).length === 0
  ) {
    issues.push(`evidence.lifecycle: ${lifecycle} evidence needs an implementation reference`);
  }
  if (lifecycle === "verified") {
    if (!document.lifecycle?.last_verified_gate) {
      issues.push("evidence.lifecycle: verified evidence needs last_verified_gate");
    }
    if (status === "unknown") {
      issues.push("evidence.lifecycle: unknown evidence cannot be verified");
    }
    if (!list(document.sources).some((source) => source?.verification_status === "verified")) {
      issues.push("evidence.lifecycle: verified evidence needs a verified source");
    }
    if (list(document.traceability?.test_refs).length === 0) {
      issues.push("evidence.lifecycle: verified evidence needs an acceptance test reference");
    }
    if (list(document.traceability?.artifact_refs).length === 0) {
      issues.push("evidence.lifecycle: verified evidence needs an acceptance artifact reference");
    }
    if (["excluded", "quarantined"].includes(status)) {
      const acceptanceTests = new Set(list(document.traceability?.test_refs));
      for (const testId of list(document.classification?.negative_test_refs)) {
        if (!acceptanceTests.has(testId)) {
          issues.push(
            `evidence.lifecycle: verified negative test ${testId} must appear in traceability.test_refs`,
          );
        }
      }
    }
    if (
      GATE_INDEX.get(document.lifecycle?.last_verified_gate) <
      GATE_INDEX.get(document.lifecycle?.acceptance_gate)
    ) {
      issues.push("evidence.lifecycle: last_verified_gate cannot precede acceptance_gate");
    }
  }
  if (
    GATE_INDEX.get(document.lifecycle?.acceptance_gate) < GATE_INDEX.get(document.lifecycle?.first_gate)
  ) {
    issues.push("evidence.lifecycle: acceptance_gate cannot precede first_gate");
  }
  if (
    document.lifecycle?.goal_scope === "current_goal" &&
    (document.lifecycle?.first_gate !== "G0" || document.lifecycle?.acceptance_gate === "POST_GOAL")
  ) {
    issues.push("evidence.lifecycle: current-goal evidence starts at G0 and must be accepted by G9");
  }
  if (
    document.lifecycle?.goal_scope === "post_goal" &&
    (document.lifecycle?.first_gate !== "POST_GOAL" ||
      document.lifecycle?.acceptance_gate !== "POST_GOAL")
  ) {
    issues.push("evidence.lifecycle: post-goal evidence must use POST_GOAL for both Gate fields");
  }
  if (document.lifecycle?.goal_scope === "post_goal") {
    if (!["frozen", "implemented", "verified", "superseded"].includes(lifecycle)) {
      issues.push("evidence.lifecycle: post-goal evidence must be frozen and independently reviewed");
    }
    if (!document.governance?.approved_deviation_id) {
      issues.push("evidence.lifecycle: post-goal evidence needs an approved deviation id");
    }
    if (
      !list(document.sources).some(
        (source) =>
        source?.source_id === document.governance?.approved_deviation_id &&
        source?.source_type === "owner_decision" &&
        source?.reference?.startsWith("repo:docs/governance/decisions/") &&
        ["frozen", "verified"].includes(source?.verification_status),
      )
    ) {
      issues.push("evidence.lifecycle: post-goal evidence needs the matching frozen owner decision source");
    }
  }
  if (status === "unknown") {
    if (
      !list(document.sources).some((source) =>
        ["unknown", "not_authorized_to_verify"].includes(source?.verification_status),
      )
    ) {
      issues.push(
        "evidence.unknown_handling: unknown evidence needs an unknown or not-authorized source",
      );
    }
    const resolutionGate = document.unknown_handling?.resolution_gate;
    const resolutionIndex = GATE_INDEX.get(resolutionGate);
    const firstIndex = GATE_INDEX.get(document.lifecycle?.first_gate);
    const acceptanceIndex = GATE_INDEX.get(document.lifecycle?.acceptance_gate);
    if (document.lifecycle?.goal_scope === "current_goal" && resolutionGate === "POST_GOAL") {
      issues.push("evidence.unknown_handling: current-goal unknown must resolve by G9");
    }
    if (document.lifecycle?.goal_scope === "post_goal" && resolutionGate !== "POST_GOAL") {
      issues.push("evidence.unknown_handling: post-goal unknown must resolve at POST_GOAL");
    }
    if (resolutionIndex < firstIndex || resolutionIndex > acceptanceIndex) {
      issues.push(
        "evidence.unknown_handling: resolution_gate must be between first_gate and acceptance_gate",
      );
    }
  } else if (document.unknown_handling !== undefined && document.unknown_handling !== null) {
    issues.push("evidence.unknown_handling: non-unknown evidence cannot declare unknown handling");
  }
  const scenarios = Object.values(document.scenarios ?? {}).flatMap(list);
  issues.push(...duplicateIdIssues(scenarios, "scenario_id", "evidence.scenarios"));
  return issues;
}

function deviationIssues(document) {
  const issues = [];
  const label = `deviation.${document.decision_id ?? "unknown"}`;
  const trustedDecision = TRUSTED_OWNER_DEVIATIONS[document.decision_id];
  if (!trustedDecision) {
    issues.push(
      `${label}: decision_id is not in the frozen explicit-Owner authorization registry; add future authorizations through a separately reviewed policy change`,
    );
  } else {
    if (
      document.authorization_basis !== "explicit_goal_owner_decision" ||
      document.authorization?.kind !== "explicit_goal_owner_decision" ||
      document.authorization?.authorization_key !== trustedDecision.authorization_key ||
      canonicalJson(document.authorization?.goal_anchor) !==
        canonicalJson(trustedDecision.authorization_anchor)
    ) {
      issues.push(`${label}.authorization: must bind the exact registered Goal Owner-decision anchor`);
    }
    if (
      document.title !== trustedDecision.title ||
      document.approved_change !== trustedDecision.approved_change ||
      canonicalJson(document.constraints) !== canonicalJson(trustedDecision.constraints)
    ) {
      issues.push(`${label}: approved scope and constraints must exactly match the registered Owner decision`);
    }
  }
  if (
    document.goal_source?.source_id !== TRUSTED_GOAL_SOURCE_ID ||
    document.goal_source?.reference !== `goal://${TRUSTED_GOAL_SOURCE_ID}` ||
    document.goal_source?.content_digest !== `sha256:${TRUSTED_GOAL_SOURCE_SHA256}` ||
    document.goal_source?.total_lines !== TRUSTED_GOAL_SOURCE_LINES
  ) {
    issues.push(`${label}.goal_source: decision must bind the exact frozen Goal source`);
  }
  if (
    document.scope_binding?.public_summary?.reference !== TRUSTED_SCOPE_SUMMARY_REFERENCE ||
    document.scope_binding?.public_summary?.content_digest !== TRUSTED_SCOPE_SUMMARY_DIGEST ||
    document.scope_binding?.private_scope_record_digest !== TRUSTED_PRIVATE_SCOPE_RECORD_DIGEST
  ) {
    issues.push(`${label}.scope_binding: decision must bind the exact public and private Scope Record digests`);
  }
  for (const [field, value] of [
    ["title", document.title],
    ["approved_change", document.approved_change],
    ...list(document.constraints).map((constraint, index) => [
      `constraints.${index}`,
      constraint,
    ]),
  ]) {
    if (typeof value !== "string") continue;
    issues.push(
      ...narrativeIssues(value, `${label}.${field}`, {
        minimumLettersOrNumbers: field === "title" ? 4 : 8,
      }),
    );
  }
  if (document.lifecycle?.content_digest !== contentDigest(document, ["lifecycle", "content_digest"])) {
    issues.push(`${label}.lifecycle.content_digest: does not match the decision record`);
  }
  const recordedAt = Date.parse(document.recorded_at ?? "");
  const frozenAt = Date.parse(document.lifecycle?.frozen_at ?? "");
  const latestAllowed = Date.now() + VALIDATION_CLOCK_SKEW_MS;
  if (Number.isFinite(recordedAt) && recordedAt > latestAllowed) {
    issues.push(`${label}.recorded_at: cannot be in the future`);
  }
  if (Number.isFinite(frozenAt) && frozenAt > latestAllowed) {
    issues.push(`${label}.lifecycle.frozen_at: cannot be in the future`);
  }
  if (Number.isFinite(recordedAt) && Number.isFinite(frozenAt) && frozenAt < recordedAt) {
    issues.push(`${label}.lifecycle.frozen_at: cannot precede recorded_at`);
  }
  return issues;
}

function canonicalGoalSectionId(line) {
  let selected = null;
  for (const candidate of GOAL_SECTION_RANGES) {
    const [, lineStart, lineEnd] = candidate;
    if (line < lineStart || line > lineEnd) continue;
    if (!selected || lineEnd - lineStart < selected[2] - selected[1]) selected = candidate;
  }
  return selected?.[0] ?? null;
}

function compactGoalLineRanges(lines) {
  const sorted = [...lines].sort((left, right) => left - right);
  const ranges = [];
  for (const line of sorted) {
    const current = ranges.at(-1);
    if (current && line === current[1] + 1) current[1] = line;
    else ranges.push([line, line]);
  }
  return ranges
    .map(([lineStart, lineEnd]) =>
      lineStart === lineEnd ? `L${lineStart}` : `L${lineStart}-L${lineEnd}`,
    )
    .join(", ");
}

function inventoryIssues(document) {
  const issues = [
    ...duplicateIdIssues(document.section_coverage, "section_id", "inventory.section_coverage"),
    ...duplicateIdIssues(document.requirements, "requirement_id", "inventory.requirements"),
    ...duplicateIdIssues(document.features, "feature_id", "inventory.features"),
    ...duplicateIdIssues(document.features, "evidence_id", "inventory.features.evidence_ids"),
    ...reviewIssues(document.review, "inventory.review"),
  ];
  issues.push(
    ...narrativeIssues(document.title, "inventory.title", {
      minimumLettersOrNumbers: 6,
    }),
  );

  if (
    document.goal_source?.source_id !== TRUSTED_GOAL_SOURCE_ID ||
    document.goal_source?.reference !== `goal://${TRUSTED_GOAL_SOURCE_ID}` ||
    document.goal_source?.content_digest !== `sha256:${TRUSTED_GOAL_SOURCE_SHA256}` ||
    document.goal_source?.total_lines !== TRUSTED_GOAL_SOURCE_LINES
  ) {
    issues.push("inventory.goal_source: must bind the exact trusted goal id, digest, and line count");
  }
  if (
    document.scope_binding?.public_summary?.reference !== TRUSTED_SCOPE_SUMMARY_REFERENCE ||
    document.scope_binding?.public_summary?.content_digest !== TRUSTED_SCOPE_SUMMARY_DIGEST ||
    document.scope_binding?.private_scope_record_digest !== TRUSTED_PRIVATE_SCOPE_RECORD_DIGEST
  ) {
    issues.push("inventory.scope_binding: must bind the exact public and private Scope Record digests");
  }

  const requirements = list(document.requirements);
  const features = list(document.features);
  const sectionCoverage = list(document.section_coverage);
  if (requirements.length < REQUIRED_GOAL_SECTION_IDS.length) {
    issues.push(
      `inventory.requirements: at least ${REQUIRED_GOAL_SECTION_IDS.length} unique atomic requirements are required`,
    );
  }
  const requirementById = new Map(
    requirements.filter((entry) => entry?.requirement_id).map((entry) => [entry.requirement_id, entry]),
  );
  const featureById = new Map(
    features.filter((entry) => entry?.feature_id).map((entry) => [entry.feature_id, entry]),
  );
  const requirementOwners = new Map();
  const sectionOwners = new Map();
  const coveredGoalLines = new Set();
  const requirementDescriptionOwners = new Map();
  const featureTitleOwners = new Map();

  const actualSectionIds = sectionCoverage.map((entry) => entry?.section_id);
  issues.push(
    ...missingRequiredValues(
      actualSectionIds,
      REQUIRED_GOAL_SECTION_IDS,
      "inventory.section_coverage",
    ),
  );
  const allowedSectionIds = new Set(REQUIRED_GOAL_SECTION_IDS);
  for (const section of sectionCoverage) {
    const label = `inventory.section_coverage.${section?.section_id ?? "unknown"}`;
    if (!allowedSectionIds.has(section?.section_id)) {
      issues.push(`${label}: unknown section id`);
    }
    for (const requirementId of list(section?.requirement_ids)) {
      if (!requirementById.has(requirementId)) {
        issues.push(`${label}: references unknown requirement ${requirementId}`);
        continue;
      }
      const owners = sectionOwners.get(requirementId) ?? [];
      owners.push(section.section_id);
      sectionOwners.set(requirementId, owners);
    }
  }

  for (const requirement of requirements) {
    const label = `inventory.requirements.${requirement?.requirement_id ?? "unknown"}`;
    issues.push(
      ...narrativeIssues(requirement?.description, `${label}.description`, {
        minimumLettersOrNumbers: 12,
      }),
    );
    const descriptionKey = normalizedNarrativeKey(requirement?.description);
    if (descriptionKey) {
      const existing = requirementDescriptionOwners.get(descriptionKey);
      if (existing) {
        issues.push(`${label}.description: duplicates requirement narrative ${existing}`);
      } else {
        requirementDescriptionOwners.set(descriptionKey, requirement?.requirement_id);
      }
    }
    const invalidRange =
      !Number.isInteger(requirement?.source_line_start) ||
      !Number.isInteger(requirement?.source_line_end) ||
      requirement.source_line_start < 1 ||
      requirement.source_line_end > TRUSTED_GOAL_SOURCE_LINES ||
      requirement.source_line_end < requirement.source_line_start;
    if (invalidRange) {
      issues.push(`${label}: source line range is invalid`);
    } else {
      const declaredSections = sectionOwners.get(requirement.requirement_id) ?? [];
      for (let line = requirement.source_line_start; line <= requirement.source_line_end; line += 1) {
        coveredGoalLines.add(line);
        if (
          declaredSections.length === 1 &&
          canonicalGoalSectionId(line) !== declaredSections[0]
        ) {
          issues.push(
            `${label}: ${line === requirement.source_line_start && line === requirement.source_line_end ? `L${line}` : `line range L${requirement.source_line_start}-L${requirement.source_line_end}`} belongs to ${canonicalGoalSectionId(line)}, not ${declaredSections[0]}`,
          );
          break;
        }
      }
    }
    if (!featureById.has(requirement?.feature_id)) {
      issues.push(`${label}: references unknown feature ${requirement?.feature_id}`);
    }
  }

  const missingGoalLines = Array.from(
    { length: TRUSTED_GOAL_SOURCE_LINES },
    (_, index) => index + 1,
  ).filter((line) => !coveredGoalLines.has(line));
  if (missingGoalLines.length > 0) {
    issues.push(
      `inventory.requirements: trusted goal lines are not completely covered; missing ${compactGoalLineRanges(missingGoalLines)}`,
    );
  }

  for (const feature of features) {
    const label = `inventory.features.${feature?.feature_id ?? "unknown"}`;
    issues.push(
      ...narrativeIssues(feature?.title, `${label}.title`, {
        minimumLettersOrNumbers: 3,
      }),
    );
    const titleKey = normalizedNarrativeKey(feature?.title);
    if (titleKey) {
      const existing = featureTitleOwners.get(titleKey);
      if (existing) {
        issues.push(`${label}.title: duplicates Feature title ${existing}`);
      } else {
        featureTitleOwners.set(titleKey, feature?.feature_id);
      }
    }
    const anchors = list(feature?.goal_anchors);
    const anchorKeys = new Set();
    for (const [anchorIndex, anchor] of anchors.entries()) {
      const anchorLabel = `${label}.goal_anchors.${anchorIndex}`;
      if (
        typeof anchor?.reference !== "string" ||
        !Number.isInteger(anchor.line_start) ||
        !Number.isInteger(anchor.line_end) ||
        anchor.line_start < 1 ||
        anchor.line_end > TRUSTED_GOAL_SOURCE_LINES ||
        anchor.line_end < anchor.line_start ||
        anchor.reference !==
          `goal://${TRUSTED_GOAL_SOURCE_ID}#L${anchor.line_start}-L${anchor.line_end}`
      ) {
        issues.push(`${anchorLabel}: exact anchored goal reference and valid line range required`);
      }
      const key = canonicalJson({
        reference: anchor?.reference,
        line_start: anchor?.line_start,
        line_end: anchor?.line_end,
      });
      if (anchorKeys.has(key)) {
        issues.push(`${label}.goal_anchors: duplicate goal anchor`);
      }
      anchorKeys.add(key);
    }
    if (anchors.length === 0) issues.push(`${label}.goal_anchors: at least one anchor is required`);

    const targets = new Set(list(feature?.disposition?.targets));
    if (["retained", "config"].includes(feature?.classification) && targets.has("exclude")) {
      issues.push(`${label}.disposition: ${feature.classification} feature cannot target exclude`);
    }
    if (feature?.classification === "excluded" && (targets.size !== 1 || !targets.has("exclude"))) {
      issues.push(`${label}.disposition: excluded feature must target only exclude`);
    }
    if (feature?.classification === "config" && !targets.has("deployment_config")) {
      issues.push(`${label}.disposition: config feature must target deployment_config`);
    }
    if (targets.has("core") && list(feature?.disposition?.module_ids).length === 0) {
      issues.push(`${label}.disposition: core target needs a module id`);
    }
    if (
      targets.has("provider_contract") &&
      list(feature?.disposition?.provider_capability_ids).length === 0
    ) {
      issues.push(`${label}.disposition: provider contract target needs a capability id`);
    }
    if (
      targets.has("deployment_config") &&
      list(feature?.disposition?.configuration_keys).length === 0
    ) {
      issues.push(`${label}.disposition: deployment config target needs a configuration key`);
    }
    const policy = feature?.classification_policy ?? {};
    if (policy.fail_safe_behavior !== null && policy.fail_safe_behavior !== undefined) {
      issues.push(
        ...narrativeIssues(
          policy.fail_safe_behavior,
          `${label}.classification_policy.fail_safe_behavior`,
          { minimumLettersOrNumbers: 8 },
        ),
      );
    }
    if (
      ["excluded", "quarantined"].includes(feature?.classification) &&
      list(policy.negative_test_refs).length === 0
    ) {
      issues.push(`${label}.classification_policy: ${feature.classification} needs a negative test`);
    }
    if (
      ["excluded", "quarantined"].includes(feature?.classification) &&
      list(feature?.disposition?.exclusion_assertion_ids).length === 0
    ) {
      issues.push(`${label}.disposition: ${feature.classification} needs an exclusion assertion`);
    }
    if (
      ["retained", "config"].includes(feature?.classification) &&
      list(feature?.disposition?.exclusion_assertion_ids).length > 0
    ) {
      issues.push(`${label}.disposition: ${feature.classification} cannot declare exclusion assertions`);
    }
    if (feature?.classification === "quarantined" && !policy.fail_safe_behavior) {
      issues.push(`${label}.classification_policy: quarantined feature needs fail-safe behavior`);
    }
    if (feature?.classification === "unknown") {
      const unknown = policy.unknown_handling;
      if (!unknown) {
        issues.push(`${label}.classification_policy: unknown feature needs owner and fail-safe handling`);
      } else if (
        GATE_INDEX.get(unknown.resolution_gate) < GATE_INDEX.get(feature.first_gate) ||
        GATE_INDEX.get(unknown.resolution_gate) > GATE_INDEX.get(feature.acceptance_gate)
      ) {
        issues.push(`${label}.classification_policy: unknown resolution Gate is outside lifecycle`);
      }
      if (unknown) {
        if (!ROLE_ID.test(unknown.owner_role ?? "")) {
          issues.push(`${label}.classification_policy.unknown_handling: owner_role must be canonical`);
        }
        issues.push(
          ...narrativeIssues(
            unknown.impact,
            `${label}.classification_policy.unknown_handling.impact`,
            { minimumLettersOrNumbers: 8 },
          ),
          ...narrativeIssues(
            unknown.fail_safe,
            `${label}.classification_policy.unknown_handling.fail_safe`,
            { minimumLettersOrNumbers: 8 },
          ),
        );
      }
    } else if (policy.unknown_handling !== null) {
      issues.push(`${label}.classification_policy: non-unknown feature cannot declare unknown handling`);
    }

    for (const requirementId of list(feature?.requirement_ids)) {
      const requirement = requirementById.get(requirementId);
      if (!requirement) {
        issues.push(`${label}.requirement_ids: references unknown requirement ${requirementId}`);
        continue;
      }
      const owners = requirementOwners.get(requirementId) ?? [];
      owners.push(feature.feature_id);
      requirementOwners.set(requirementId, owners);
      if (requirement.feature_id !== feature.feature_id) {
        issues.push(`${label}.requirement_ids: ${requirementId} names feature ${requirement.feature_id}`);
      }
      if (
        !anchors.some(
          (anchor) =>
            Number.isInteger(anchor?.line_start) &&
            Number.isInteger(anchor?.line_end) &&
            requirement.source_line_start >= anchor.line_start &&
            requirement.source_line_end <= anchor.line_end,
        )
      ) {
        issues.push(`${label}.requirement_ids: ${requirementId} lies outside every feature goal anchor`);
      }
    }
    const featureSections = new Set(
      list(feature?.requirement_ids).flatMap((requirementId) => sectionOwners.get(requirementId) ?? []),
    );
    if (featureSections.size < 1) {
      issues.push(`${label}: a feature must cover at least one required goal section`);
    }
  }

  for (const requirement of requirements) {
    const owners = requirementOwners.get(requirement?.requirement_id) ?? [];
    if (owners.length !== 1) {
      issues.push(
        `inventory.requirements.${requirement?.requirement_id}: must be mapped exactly once; found ${owners.length}`,
      );
    }
    const sections = sectionOwners.get(requirement?.requirement_id) ?? [];
    if (sections.length !== 1) {
      issues.push(
        `inventory.requirements.${requirement?.requirement_id}: must belong to exactly one required section; found ${sections.length}`,
      );
    }
  }

  const expectedClassifications = {
    total_features: features.length,
    total_requirements: requirements.length,
    retained: features.filter((entry) => entry?.classification === "retained").length,
    config: features.filter((entry) => entry?.classification === "config").length,
    excluded: features.filter((entry) => entry?.classification === "excluded").length,
    quarantined: features.filter((entry) => entry?.classification === "quarantined").length,
    unknown: features.filter((entry) => entry?.classification === "unknown").length,
  };
  for (const [key, expected] of Object.entries(expectedClassifications)) {
    if (document.classification_counts?.[key] !== expected) {
      issues.push(`inventory.classification_counts.${key}: expected ${expected}`);
    }
  }
  for (const priority of ["P0", "P1", "P2", "P3"]) {
    const expected = features.filter((entry) => entry?.priority === priority).length;
    if (document.priority_counts?.[priority] !== expected) {
      issues.push(`inventory.priority_counts.${priority}: expected ${expected}`);
    }
  }

  if (document.lifecycle?.status === "draft") {
    if (document.review?.status !== "pending" || document.review?.independent_review !== false) {
      issues.push("inventory.lifecycle: draft inventory must remain pending and unapproved");
    }
  } else if (document.lifecycle?.status === "frozen") {
    if (document.review?.status !== "passed" || document.review?.independent_review !== true) {
      issues.push("inventory.lifecycle: frozen inventory needs a passed independent review");
    }
    if (document.lifecycle?.content_digest !== contentDigest(document, ["lifecycle", "content_digest"])) {
      issues.push("inventory.lifecycle: frozen content digest does not match the inventory");
    }
    const reviewedRequirementIds = list(document.review?.coverage?.requirement_ids);
    const reviewedFeatureIds = list(document.review?.coverage?.feature_ids);
    const reviewedChecks = list(document.review?.coverage?.checks);
    const exactSet = (actual, expected) =>
      canonicalJson([...new Set(actual)].sort()) === canonicalJson([...new Set(expected)].sort());
    if (!exactSet(reviewedRequirementIds, requirements.map((entry) => entry?.requirement_id))) {
      issues.push("inventory.review.coverage.requirement_ids: must exactly cover every requirement");
    }
    if (!exactSet(reviewedFeatureIds, features.map((entry) => entry?.feature_id))) {
      issues.push("inventory.review.coverage.feature_ids: must exactly cover every Feature");
    }
    if (!exactSet(reviewedChecks, REQUIRED_INVENTORY_REVIEW_CHECKS)) {
      issues.push("inventory.review.coverage.checks: must attest every required decomposition check");
    }
  }
  issues.push(
    ...chronologyIssues(
      document.lifecycle?.created_at,
      document.lifecycle?.updated_at,
      "inventory.lifecycle",
    ),
  );
  return issues;
}

function stateIssues(document) {
  const issues = [
    ...duplicateIdIssues(document.states, "state_id", "state.states"),
    ...duplicateIdIssues(document.commands, "command_id", "state.commands"),
    ...duplicateIdIssues(document.transitions, "transition_id", "state.transitions"),
    ...duplicateIdIssues(document.illegal_transitions, "assertion_id", "state.illegal_transitions"),
    ...duplicateIdIssues(document.invariants, "invariant_id", "state.invariants"),
    ...reviewIssues(document.review, "state.review"),
  ];
  const states = idSet(document.states, "state_id");
  const commands = idSet(document.commands, "command_id");
  const commandMap = new Map(list(document.commands).map((command) => [command.command_id, command]));
  const terminalStates = new Set(
    list(document.states)
      .filter((state) => state?.terminal === true)
      .map((state) => state.state_id),
  );
  const legalPairs = new Map();
  if (list(document.states).filter((state) => state?.initial === true).length !== 1) {
    issues.push("state.states: exactly one state must be initial");
  }
  for (const transition of list(document.transitions)) {
    const label = `state.transitions.${transition?.transition_id}`;
    if (list(transition?.from_state_ids).length === 0) {
      issues.push(`${label}.from_state_ids: at least one source state is required`);
    }
    issues.push(...missingRefIssues(transition?.from_state_ids, states, `${label}.from_state_ids`));
    issues.push(...missingRefIssues([transition?.to_state_id], states, `${label}.to_state_id`));
    issues.push(...missingRefIssues([transition?.command_id], commands, `${label}.command_id`));
    const declaredPermissions = new Set(list(commandMap.get(transition?.command_id)?.permission_ids));
    const transitionPermissions = new Set(list(transition?.permission_ids));
    if (
      declaredPermissions.size !== transitionPermissions.size ||
      [...declaredPermissions].some((permission) => !transitionPermissions.has(permission))
    ) {
      issues.push(`${label}.permission_ids: permissions must equal the command permission set`);
    }
    for (const stateId of list(transition?.from_state_ids)) {
      if (terminalStates.has(stateId)) {
        issues.push(`${label}: terminal state ${stateId} cannot have a legal transition`);
      }
      const pair = `${stateId}|${transition?.command_id}`;
      if (legalPairs.has(pair)) {
        issues.push(`${label}: ambiguous legal pair also declared by ${legalPairs.get(pair)}`);
      } else {
        legalPairs.set(pair, transition?.transition_id);
      }
    }
  }
  const illegalPairs = new Map();
  for (const assertion of list(document.illegal_transitions)) {
    const label = `state.illegal_transitions.${assertion?.assertion_id}`;
    if (list(assertion?.from_state_ids).length === 0) {
      issues.push(`${label}.from_state_ids: at least one source state is required`);
    }
    issues.push(...missingRefIssues(assertion?.from_state_ids, states, `${label}.from_state_ids`));
    issues.push(...missingRefIssues([assertion?.command_id], commands, `${label}.command_id`));
    for (const stateId of list(assertion?.from_state_ids)) {
      const pair = `${stateId}|${assertion?.command_id}`;
      if (legalPairs.has(pair)) {
        issues.push(`${label}: pair is both legal and illegal via ${legalPairs.get(pair)}`);
      }
      if (illegalPairs.has(pair)) {
        issues.push(`${label}: duplicate illegal pair also declared by ${illegalPairs.get(pair)}`);
      } else {
        illegalPairs.set(pair, assertion?.assertion_id);
      }
    }
  }
  if (document.review?.status === "passed") {
    if (list(document.source_evidence_ids).length === 0) {
      issues.push("state.source_evidence_ids: passed table needs source evidence");
    }
    for (const command of list(document.commands)) {
      if (list(command?.actor_types).length === 0 || list(command?.permission_ids).length === 0) {
        issues.push(`state.commands.${command?.command_id}: passed table needs actors and permissions`);
      }
    }
    for (const transition of list(document.transitions)) {
      if (
        list(transition?.guard_ids).length === 0 ||
        list(transition?.evidence_ids).length === 0 ||
        list(transition?.test_ids).length === 0
      ) {
        issues.push(
          `state.transitions.${transition?.transition_id}: passed table needs guards, evidence, and tests`,
        );
      }
    }
    for (const assertion of list(document.illegal_transitions)) {
      if (list(assertion?.test_ids).length === 0) {
        issues.push(`state.illegal_transitions.${assertion?.assertion_id}: passed table needs tests`);
      }
    }
    for (const invariant of list(document.invariants)) {
      if (list(invariant?.test_ids).length === 0) {
        issues.push(`state.invariants.${invariant?.invariant_id}: passed table needs tests`);
      }
    }
    if (list(document.concurrency?.test_ids).length === 0) {
      issues.push("state.concurrency: passed table needs concurrency tests");
    }
    for (const stateId of states) {
      for (const commandId of commands) {
        const pair = `${stateId}|${commandId}`;
        if (!legalPairs.has(pair) && !illegalPairs.has(pair)) {
          issues.push(`state.coverage: ${stateId} and ${commandId} is neither legal nor illegal`);
        }
      }
    }

    const initialState = list(document.states).find((state) => state?.initial === true)?.state_id;
    const reachable = new Set(initialState ? [initialState] : []);
    let changed = true;
    while (changed) {
      changed = false;
      for (const transition of list(document.transitions)) {
        if (list(transition?.from_state_ids).some((stateId) => reachable.has(stateId))) {
          if (!reachable.has(transition?.to_state_id)) {
            reachable.add(transition.to_state_id);
            changed = true;
          }
        }
      }
    }
    for (const stateId of states) {
      if (!reachable.has(stateId)) issues.push(`state.states.${stateId}: state is unreachable`);
    }
  }
  return issues;
}

function guardIssues(document) {
  const issues = [
    ...duplicateIdIssues(document.actor_types, "type_id", "guard.actor_types"),
    ...duplicateIdIssues(document.resource_types, "type_id", "guard.resource_types"),
    ...duplicateIdIssues(document.permissions, "permission_id", "guard.permissions"),
    ...duplicateIdIssues(document.guards, "guard_id", "guard.guards"),
    ...duplicateIdIssues(document.role_presets, "role_id", "guard.role_presets"),
    ...duplicateIdIssues(document.matrix, "entry_id", "guard.matrix"),
    ...duplicateIdIssues(document.state_combinations, "combination_id", "guard.state_combinations"),
    ...duplicateIdIssues(document.high_risk_actions, "action_id", "guard.high_risk_actions"),
    ...reviewIssues(document.review, "guard.review"),
  ];
  const actors = idSet(document.actor_types, "type_id");
  const resources = idSet(document.resource_types, "type_id");
  const permissions = idSet(document.permissions, "permission_id");
  const guards = idSet(document.guards, "guard_id");
  const permissionMap = new Map(
    list(document.permissions).map((permission) => [permission.permission_id, permission]),
  );

  for (const permission of list(document.permissions)) {
    issues.push(
      ...missingRefIssues(
        [permission?.resource_type_id],
        resources,
        `guard.permissions.${permission?.permission_id}.resource_type_id`,
      ),
    );
  }
  for (const role of list(document.role_presets)) {
    issues.push(
      ...missingRefIssues(
        role?.permission_ids,
        permissions,
        `guard.role_presets.${role?.role_id}.permission_ids`,
      ),
    );
  }

  const tuples = new Map();
  for (const entry of list(document.matrix)) {
    const label = `guard.matrix.${entry?.entry_id}`;
    issues.push(...missingRefIssues([entry?.actor_type_id], actors, `${label}.actor_type_id`));
    issues.push(...missingRefIssues([entry?.resource_type_id], resources, `${label}.resource_type_id`));
    issues.push(...missingRefIssues([entry?.permission_id], permissions, `${label}.permission_id`));
    issues.push(...missingRefIssues(entry?.guard_ids, guards, `${label}.guard_ids`));
    const permission = permissionMap.get(entry?.permission_id);
    if (permission && permission.resource_type_id !== entry?.resource_type_id) {
      issues.push(`${label}: resource does not match the permission resource`);
    }
    const tuple = `${entry?.actor_type_id}|${entry?.resource_type_id}|${entry?.permission_id}|${entry?.scope_rule}`;
    if (tuples.has(tuple)) {
      issues.push(`${label}: duplicate authorization tuple also declared by ${tuples.get(tuple)}`);
    } else {
      tuples.set(tuple, entry?.entry_id);
    }
  }

  for (const combination of list(document.state_combinations)) {
    const label = `guard.state_combinations.${combination?.combination_id}`;
    issues.push(...missingRefIssues([combination?.permission_id], permissions, `${label}.permission_id`));
    issues.push(...missingRefIssues(combination?.guard_ids, guards, `${label}.guard_ids`));
  }

  const coveredHighRisk = new Set();
  for (const action of list(document.high_risk_actions)) {
    const label = `guard.high_risk_actions.${action?.action_id}`;
    issues.push(...missingRefIssues([action?.permission_id], permissions, `${label}.permission_id`));
    issues.push(...missingRefIssues(action?.guard_ids, guards, `${label}.guard_ids`));
    if (action?.step_up_required !== true) issues.push(`${label}: step-up must be required`);
    if (coveredHighRisk.has(action?.permission_id)) {
      issues.push(`${label}: high-risk permission has more than one action policy`);
    }
    coveredHighRisk.add(action?.permission_id);
    if (permissionMap.has(action?.permission_id) && !permissionMap.get(action.permission_id).high_risk) {
      issues.push(`${label}: action policy refers to a permission not marked high-risk`);
    }
  }
  for (const permission of list(document.permissions)) {
    if (permission?.high_risk && !coveredHighRisk.has(permission.permission_id)) {
      issues.push(
        `guard.permissions.${permission.permission_id}: high-risk permission needs one action policy`,
      );
    }
  }
  if (document.review?.status === "passed") {
    if (list(document.source_evidence_ids).length === 0) {
      issues.push("guard.source_evidence_ids: passed matrix needs source evidence");
    }
    const matrixPermissions = new Set(list(document.matrix).map((entry) => entry?.permission_id));
    for (const permissionId of permissions) {
      if (!matrixPermissions.has(permissionId)) {
        issues.push(`guard.permissions.${permissionId}: passed matrix must cover the permission`);
      }
    }
    for (const guard of list(document.guards)) {
      if (
        list(guard?.evidence_ids).length === 0 ||
        list(guard?.positive_test_ids).length === 0 ||
        list(guard?.negative_test_ids).length === 0
      ) {
        issues.push(`guard.guards.${guard?.guard_id}: passed matrix needs evidence and positive/negative tests`);
      }
    }
    for (const entry of list(document.matrix)) {
      if (list(entry?.test_ids).length === 0) {
        issues.push(`guard.matrix.${entry?.entry_id}: passed matrix entry needs tests`);
      }
    }
    for (const combination of list(document.state_combinations)) {
      if (list(combination?.test_ids).length === 0) {
        issues.push(`guard.state_combinations.${combination?.combination_id}: passed combination needs tests`);
      }
    }
  }
  return issues;
}

function ledgerIssues(document) {
  const issues = [
    ...duplicateIdIssues(document.accounts, "account_id", "ledger.accounts"),
    ...duplicateIdIssues(document.accounts, "code", "ledger.accounts"),
    ...duplicateIdIssues(document.rounding_rules, "rounding_rule_id", "ledger.rounding_rules"),
    ...duplicateIdIssues(document.derived_amounts, "amount_id", "ledger.derived_amounts"),
    ...duplicateIdIssues(document.posting_rules, "posting_rule_id", "ledger.posting_rules"),
    ...duplicateIdIssues(document.manual_command_rules, "command_id", "ledger.manual_command_rules"),
    ...duplicateIdIssues(document.invariants, "invariant_id", "ledger.invariants"),
    ...duplicateIdIssues(document.concurrency_controls, "control_id", "ledger.concurrency_controls"),
    ...duplicateIdIssues(document.golden_vector_refs, "vector_id", "ledger.golden_vector_refs"),
    ...reviewIssues(document.review, "ledger.review"),
  ];
  const accounts = idSet(document.accounts, "account_id");
  const roundingRules = idSet(document.rounding_rules, "rounding_rule_id");
  const derivedAmounts = idSet(document.derived_amounts, "amount_id");
  const invariants = idSet(document.invariants, "invariant_id");
  const postingRules = idSet(document.posting_rules, "posting_rule_id");
  const invariantMap = new Map(
    list(document.invariants).map((invariant) => [invariant.invariant_id, invariant]),
  );

  for (const amount of list(document.derived_amounts)) {
    const label = `ledger.derived_amounts.${amount?.amount_id}`;
    issues.push(...missingRefIssues([amount?.rounding_rule_id], roundingRules, `${label}.rounding_rule_id`));
    issues.push(...missingRefIssues(amount?.invariant_ids, invariants, `${label}.invariant_ids`));
    const references = expressionReferenceSets(amount?.formula);
    issues.push(...references.issues.map((issue) => `${label}.formula: ${issue}`));
    issues.push(
      ...missingRefIssues([...references.inputs], new Set(list(amount?.input_ids)), `${label}.formula.inputs`),
      ...missingRefIssues(amount?.input_ids, references.inputs, `${label}.input_ids`),
      ...missingRefIssues([...references.amounts], derivedAmounts, `${label}.formula.amounts`),
      ...missingRefIssues(
        [...references.roundingRules],
        roundingRules,
        `${label}.formula.rounding_rules`,
      ),
    );
    for (const roundingRuleId of references.roundingRules) {
      if (roundingRuleId !== amount?.rounding_rule_id) {
        issues.push(`${label}.formula: executable rounding rule must match rounding_rule_id`);
      }
    }
  }
  const amountDependencies = new Map(
    list(document.derived_amounts).map((amount) => [
      amount?.amount_id,
      expressionReferenceSets(amount?.formula).amounts,
    ]),
  );
  const visitedAmounts = new Set();
  const visitingAmounts = new Set();
  const visitAmount = (amountId) => {
    if (visitingAmounts.has(amountId)) {
      issues.push(`ledger.derived_amounts.${amountId}: amount dependency graph contains a cycle`);
      return;
    }
    if (visitedAmounts.has(amountId)) return;
    visitingAmounts.add(amountId);
    for (const dependency of amountDependencies.get(amountId) ?? []) visitAmount(dependency);
    visitingAmounts.delete(amountId);
    visitedAmounts.add(amountId);
  };
  for (const amountId of amountDependencies.keys()) visitAmount(amountId);
  for (const rule of list(document.posting_rules)) {
    const label = `ledger.posting_rules.${rule?.posting_rule_id}`;
    issues.push(...duplicateIdIssues(rule?.lines, "line_id", `${label}.lines`));
    issues.push(...missingRefIssues([rule?.rounding_rule_id], roundingRules, `${label}.rounding_rule_id`));
    issues.push(...missingRefIssues(rule?.amount_source_ids, derivedAmounts, `${label}.amount_source_ids`));
    issues.push(...missingRefIssues(rule?.balance_invariant_ids, invariants, `${label}.balance_invariant_ids`));
    for (const line of list(rule?.lines)) {
      issues.push(...missingRefIssues([line?.account_id], accounts, `${label}.lines.${line?.line_id}.account_id`));
      issues.push(
        ...missingRefIssues(
          [line?.amount_id],
          new Set(list(rule?.amount_source_ids)),
          `${label}.lines.${line?.line_id}.amount_id`,
        ),
      );
    }
    if (
      !list(rule?.balance_invariant_ids).some(
        (invariantId) => invariantMap.get(invariantId)?.kind === "journal_balance",
      )
    ) {
      issues.push(`${label}: posting rule must reference a journal_balance invariant`);
    }
    issues.push(
      ...missingRefIssues(
        rule?.reversal?.follow_up_posting_rule_ids,
        postingRules,
        `${label}.reversal.follow_up_posting_rule_ids`,
      ),
    );
    if (
      ["compensating_journal", "linked_correction"].includes(rule?.reversal?.strategy) &&
      (rule.reversal.original_reference_required !== true || rule.reversal.reason_required !== true)
    ) {
      issues.push(`${label}.reversal: correction requires original reference and reason`);
    }
  }
  const coveredPostingRules = new Set();
  for (const vector of list(document.golden_vector_refs)) {
    const label = `ledger.golden_vector_refs.${vector?.vector_id}`;
    if (
      vector?.input_fixture_ref &&
      vector.input_fixture_ref === vector?.expected_postings_ref
    ) {
      issues.push(`${label}: input and expected postings must use distinct artifacts`);
    }
    if (vector?.content_digest !== contentDigest(vector, ["content_digest"])) {
      issues.push(`${label}.content_digest: vector digest does not match its references and byte digests`);
    }
    issues.push(
      ...missingRefIssues(
        vector?.covered_posting_rule_ids,
        postingRules,
        `${label}.covered_posting_rule_ids`,
      ),
    );
    issues.push(
      ...missingRefIssues(
        vector?.expected_invariant_ids,
        invariants,
        `${label}.expected_invariant_ids`,
      ),
    );
    for (const postingRuleId of list(vector?.covered_posting_rule_ids)) {
      coveredPostingRules.add(postingRuleId);
      const postingRule = list(document.posting_rules).find(
        (candidate) => candidate?.posting_rule_id === postingRuleId,
      );
      issues.push(
        ...missingRefIssues(
          postingRule?.balance_invariant_ids,
          new Set(list(vector?.expected_invariant_ids)),
          `${label}.expected_invariant_ids`,
        ),
      );
    }
  }
  for (const postingRuleId of postingRules) {
    if (!coveredPostingRules.has(postingRuleId)) {
      issues.push(`ledger.posting_rules.${postingRuleId}: posting rule needs a golden vector`);
    }
  }
  if (document.review?.status === "passed") {
    if (list(document.source_evidence_ids).length === 0) {
      issues.push("ledger.source_evidence_ids: passed matrix needs source evidence");
    }
    for (const rule of list(document.rounding_rules)) {
      if (rule?.mode === "asset_defined") {
        issues.push(
          `ledger.rounding_rules.${rule?.rounding_rule_id}: passed matrix needs a concrete executable rounding mode`,
        );
      }
    }
    for (const rule of list(document.posting_rules)) {
      if (list(rule?.evidence_ids).length === 0 || list(rule?.test_ids).length === 0) {
        issues.push(`ledger.posting_rules.${rule?.posting_rule_id}: passed matrix needs evidence and tests`);
      }
    }
    for (const amount of list(document.derived_amounts)) {
      if (list(amount?.evidence_ids).length === 0 || list(amount?.test_ids).length === 0) {
        issues.push(
          `ledger.derived_amounts.${amount?.amount_id}: passed matrix needs evidence and tests`,
        );
      }
      const requiredFormula = REQUIRED_DERIVED_AMOUNT_FORMULAS[amount?.amount_id];
      if (requiredFormula && canonicalJson(amount?.formula) !== canonicalJson(requiredFormula)) {
        issues.push(
          `ledger.derived_amounts.${amount?.amount_id}: formula does not match the frozen required derivation`,
        );
      }
    }
    for (const command of list(document.manual_command_rules)) {
      if (list(command?.evidence_ids).length === 0 || list(command?.test_ids).length === 0) {
        issues.push(
          `ledger.manual_command_rules.${command?.command_id}: passed matrix needs evidence and tests`,
        );
      }
      if (command?.step_up_required !== true) {
        issues.push(
          `ledger.manual_command_rules.${command?.command_id}: passed financial command needs step-up`,
        );
      }
      if (command?.command_id === "COMMAND-RECORD-MANUAL-PAYMENT") {
        issues.push(
          ...missingRequiredValues(
            list(command.required_input_fields),
            REQUIRED_MANUAL_PAYMENT_FIELDS,
            "ledger.manual_command_rules.COMMAND-RECORD-MANUAL-PAYMENT.required_input_fields",
          ),
          ...missingRequiredValues(
            list(command.permitted_destination_types),
            REQUIRED_MANUAL_PAYMENT_DESTINATIONS,
            "ledger.manual_command_rules.COMMAND-RECORD-MANUAL-PAYMENT.permitted_destination_types",
          ),
        );
      }
    }
    for (const control of list(document.concurrency_controls)) {
      if (list(control?.evidence_ids).length === 0 || list(control?.test_ids).length === 0) {
        issues.push(
          `ledger.concurrency_controls.${control?.control_id}: passed matrix needs evidence and tests`,
        );
      }
    }
  }
  return issues;
}

function oracleIssues(document) {
  const issues = [...reviewIssues(document.review, "oracle.review")];
  const seenArtifacts = new Set();
  for (const artifact of list(document.normative_artifacts)) {
    if (seenArtifacts.has(artifact?.reference)) {
      issues.push(`oracle.normative_artifacts: duplicate artifact reference ${artifact?.reference}`);
    }
    seenArtifacts.add(artifact?.reference);
  }
  if (
    document.review?.status === "passed" &&
    document.content_digest !== contentDigest(document, ["content_digest"])
  ) {
    issues.push("oracle.content_digest: passed oracle digest does not match the document");
  }
  return issues;
}

function ledgerArtifactIssues(document) {
  const issues = [];
  if (document.kind === "input") {
    issues.push(...duplicateIdIssues(document.inputs, "input_id", "ledgerArtifact.inputs"));
  }
  if (["expected", "attestation"].includes(document.kind)) {
    const vectors = document.kind === "attestation" ? list(document.vectors) : [document];
    if (document.kind === "attestation") {
      issues.push(...duplicateIdIssues(vectors, "vector_id", "ledgerArtifact.vectors"));
      if (
        document.summary?.total !== vectors.length ||
        document.summary?.passed !== vectors.length ||
        document.summary?.failed !== 0
      ) {
        issues.push("ledgerArtifact.summary: attestation summary must exactly match passed vectors");
      }
    }
    for (const vector of vectors) {
      const label = `ledgerArtifact.${vector?.vector_id}`;
      issues.push(...duplicateIdIssues(vector?.amounts, "amount_id", `${label}.amounts`));
      issues.push(...duplicateIdIssues(vector?.journals, "posting_rule_id", `${label}.journals`));
      for (const journal of list(vector?.journals)) {
        issues.push(
          ...duplicateIdIssues(
            journal?.postings,
            "line_id",
            `${label}.${journal?.posting_rule_id}.postings`,
          ),
        );
      }
    }
  }
  return issues;
}

function gateIssues(document) {
  const issues = [];
  const evidence = document.feature_evidence ?? {};
  const verification = document.verification ?? {};
  const commands = list(verification.commands);
  const passed = commands.filter((command) => command?.passed === true).length;
  const failed = commands.filter((command) => command?.passed === false).length;
  const summary = verification.summary ?? {};

  issues.push(...duplicateIdIssues(commands, "command_id", "gate.verification.commands"));
  issues.push(
    ...duplicateIdIssues(document.decision?.incomplete_items, "item_id", "gate.decision.incomplete_items"),
  );
  issues.push(
    ...duplicateIdIssues(Object.values(document.reviews ?? {}), "review_id", "gate.reviews"),
  );
  issues.push(
    ...duplicateIdIssues(
      document.feature_evidence?.card_artifacts,
      "evidence_id",
      "gate.feature_evidence.card_artifacts",
    ),
  );
  const cardReferences = list(document.feature_evidence?.card_artifacts).map(
    (artifact) => artifact?.reference,
  );
  if (new Set(cardReferences).size !== cardReferences.length) {
    issues.push("gate.feature_evidence.card_artifacts: duplicate Evidence Card reference");
  }
  if (evidence.classified > evidence.total) {
    issues.push("gate.feature_evidence: classified cannot exceed total");
  }
  if (evidence.frozen_total > evidence.total) {
    issues.push("gate.feature_evidence: frozen_total cannot exceed total");
  }
  if (evidence.retained_total > evidence.classified) {
    issues.push("gate.feature_evidence: retained_total cannot exceed classified");
  }
  if (evidence.due_for_acceptance > evidence.classified) {
    issues.push("gate.feature_evidence: due_for_acceptance cannot exceed classified");
  }
  if (evidence.due_verified > evidence.due_for_acceptance) {
    issues.push("gate.feature_evidence: due_verified cannot exceed due_for_acceptance");
  }
  if (evidence.p0_total > evidence.total) {
    issues.push("gate.feature_evidence: p0_total cannot exceed total");
  }
  if (evidence.p0_unexplained > evidence.p0_total) {
    issues.push("gate.feature_evidence: p0_unexplained cannot exceed p0_total");
  }
  if (
    evidence.coverage_complete === true &&
    (evidence.classified !== evidence.total || evidence.frozen_total !== evidence.total)
  ) {
    issues.push("gate.feature_evidence: complete coverage requires every card classified and frozen");
  }
  if (summary.passed !== passed || summary.failed !== failed) {
    issues.push("gate.verification.summary: passed and failed counts must equal command results");
  }
  if ((summary.skipped ?? 0) + passed + failed !== commands.length) {
    issues.push("gate.verification.summary: totals must equal the command count");
  }
  for (const command of commands) {
    if (command?.passed === true && list(command?.artifact_refs).length === 0) {
      issues.push(`gate.verification.commands.${command?.command_id}: passing command needs an artifact`);
    }
  }
  const recordedAt = Date.parse(document.recorded_at ?? "");
  const validationNow = Date.now();
  if (Number.isFinite(recordedAt) && recordedAt > validationNow + VALIDATION_CLOCK_SKEW_MS) {
    issues.push("gate.recorded_at: report time is too far in the future");
  }
  for (const risk of list(document.security?.accepted_risks)) {
    const dueAt = Date.parse(risk?.due_at ?? "");
    const expiresAt = Date.parse(risk?.expires_at ?? "");
    if (Number.isFinite(dueAt) && Number.isFinite(expiresAt) && dueAt > expiresAt) {
      issues.push(`gate.security.${risk?.risk_id}: due_at cannot be after expires_at`);
    }
    if (risk?.severity === "high") {
      if (!Number.isFinite(recordedAt) || !Number.isFinite(expiresAt)) {
        issues.push(`gate.security.${risk?.risk_id}: high risk needs valid recorded and expiry times`);
      } else {
        const lifetimeMs = expiresAt - recordedAt;
        if (lifetimeMs <= 0) issues.push(`gate.security.${risk?.risk_id}: high-risk acceptance is expired`);
        if (lifetimeMs > MAX_HIGH_RISK_ACCEPTANCE_MS) {
          issues.push(`gate.security.${risk?.risk_id}: high-risk acceptance exceeds 30 days`);
        }
      }
    }
  }
  const expectedNext = NEXT_GATE[document.gate];
  if (expectedNext && document.decision?.next_gate !== expectedNext) {
    issues.push(`gate.decision.next_gate: ${document.gate} must point to ${expectedNext}`);
  }
  if (document.decision?.outcome === "go") {
    if (list(document.decision?.incomplete_items).length !== 0) {
      issues.push("gate.decision: go cannot contain incomplete items");
    }
    if (evidence.classified !== evidence.total) {
      issues.push("gate.decision: go requires every evidence item to be classified");
    }
    if (evidence.frozen_total !== evidence.total) {
      issues.push("gate.decision: go requires every evidence item to be frozen");
    }
    if (!(evidence.total > 0)) {
      issues.push("gate.decision: go requires nonempty feature evidence");
    }
    if (list(evidence.card_artifacts).length !== evidence.total) {
      issues.push("gate.decision: Evidence Card artifact count must equal total");
    }
    if (evidence.due_verified !== evidence.due_for_acceptance) {
      issues.push("gate.decision: go requires every acceptance due at this Gate to be verified");
    }
    if (document.content_digest !== contentDigest(document, ["content_digest"])) {
      issues.push("gate.decision: content digest does not match the report");
    }
    for (const [slot, review] of Object.entries(document.reviews ?? {})) {
      if (review?.passed !== true || review?.independent_of_authors !== true) {
        issues.push(`gate.reviews.${slot}: go requires an independent passing review`);
      }
    }
    if (document.gate === "G0") {
      const seenOracleArtifacts = new Set();
      for (const [category, policy] of Object.entries(G0_ORACLE_CATEGORIES)) {
        const oracle = document.g0_oracles?.[category] ?? {};
        if (!(oracle.document_count > 0)) {
          issues.push(`gate.g0_oracles.${category}: G0 go requires at least one oracle document`);
        }
        if (
          oracle.passed_count !== oracle.document_count ||
          oracle.frozen_count !== oracle.document_count
        ) {
          issues.push(`gate.g0_oracles.${category}: every oracle must be passed and frozen`);
        }
        if (list(oracle.artifact_refs).length !== oracle.document_count) {
          issues.push(`gate.g0_oracles.${category}: artifact count must equal document count`);
        }
        for (const reference of list(oracle.artifact_refs)) {
          if (!reference.startsWith(`repo:${policy.pathPrefix}`)) {
            issues.push(
              `gate.g0_oracles.${category}: artifact must use ${policy.pathPrefix}`,
            );
          }
          if (seenOracleArtifacts.has(reference)) {
            issues.push(`gate.g0_oracles.${category}: oracle artifact is reused ${reference}`);
          }
          seenOracleArtifacts.add(reference);
        }
      }
    }
  }
  return issues;
}

export function validateSemantics(kind, document) {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    return [`${kind}: document must be an object`];
  }
  switch (kind) {
    case "evidence":
      return evidenceIssues(document);
    case "inventory":
      return inventoryIssues(document);
    case "deviation":
      return deviationIssues(document);
    case "state":
      return stateIssues(document);
    case "guard":
      return guardIssues(document);
    case "ledger":
      return ledgerIssues(document);
    case "ledgerArtifact":
      return ledgerArtifactIssues(document);
    case "oracle":
      return oracleIssues(document);
    case "gate":
      return gateIssues(document);
    default:
      return [`unknown specification kind: ${kind}`];
  }
}

function loadSchemas(root) {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validators = {};
  for (const [kind, file] of Object.entries(SCHEMA_FILES)) {
    const schemaFile = join(root, file);
    const metadata = lstatSync(schemaFile);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error(`${file}: schema must be a regular non-symlink file`);
    }
    const schema = parseJsonStrict(readFileSync(schemaFile, "utf8"));
    validators[kind] = ajv.compile(schema);
  }
  return validators;
}

function schemaErrorMessage(error) {
  return `${error.instancePath || "/"} ${error.message ?? "schema validation failed"}`;
}

export function validateDocument(kind, document, validators = loadSchemas(DEFAULT_ROOT)) {
  const validator = validators[kind];
  if (!validator) return [`unknown specification kind: ${kind}`];
  const valid = validator(document);
  const structural = valid ? [] : list(validator.errors).map(schemaErrorMessage);
  return [...structural, ...validateSemantics(kind, document)];
}

function walk(directory) {
  const files = [];
  if (!existsSync(directory)) return files;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if ([".git", "node_modules"].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(path));
    else files.push(path);
  }
  return files;
}

function collectKeys(value, keyName, path = [], matches = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectKeys(item, keyName, [...path, index], matches));
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (key === keyName) matches.push({ value: child, path: [...path, key].join(".") });
      collectKeys(child, keyName, [...path, key], matches);
    }
  }
  return matches;
}

function workflowTriggerIncludes(value, eventName) {
  if (typeof value === "string") return value === eventName;
  if (Array.isArray(value)) return value.includes(eventName);
  return Boolean(value && typeof value === "object" && Object.hasOwn(value, eventName));
}

function usesIssue(root, file, entry) {
  const label = `${relative(root, file)}:${entry.path}`;
  if (typeof entry.value !== "string") return `${label}: uses must be a literal string`;
  if (entry.value.startsWith("./")) {
    const target = resolve(root, entry.value);
    if (target !== root && !target.startsWith(`${root}${sep}`)) {
      return `${label}: local action escapes the repository`;
    }
    if (!existsSync(target)) return `${label}: local action does not exist`;
    if (
      /^jobs\.[^.]+\.uses$/.test(entry.path) &&
      [".yml", ".yaml"].includes(extname(target)) &&
      target.startsWith(`${resolve(root, ".github", "workflows")}${sep}`)
    ) {
      const metadata = lstatSync(target);
      return metadata.isSymbolicLink() || !metadata.isFile()
        ? `${label}: reusable workflow must be a regular non-symlink file`
        : null;
    }
    const actionsRoot = resolve(root, ".github", "actions");
    if (target === actionsRoot || !target.startsWith(`${actionsRoot}${sep}`)) {
      return `${label}: local actions must live under .github/actions/`;
    }
    const targetMetadata = lstatSync(target);
    if (targetMetadata.isSymbolicLink() || !targetMetadata.isDirectory()) {
      return `${label}: local action must be a regular non-symlink directory`;
    }
    const realActionsRoot = realpathSync(actionsRoot);
    const realTarget = realpathSync(target);
    if (realTarget === realActionsRoot || !realTarget.startsWith(`${realActionsRoot}${sep}`)) {
      return `${label}: local action resolves outside .github/actions/`;
    }
    const metadataFiles = [join(target, "action.yml"), join(target, "action.yaml")].filter(existsSync);
    if (metadataFiles.length !== 1) {
      return `${label}: local action has no action.yml or action.yaml`;
    }
    const metadata = lstatSync(metadataFiles[0]);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      return `${label}: local action metadata must be a regular non-symlink file`;
    }
    return null;
  }
  if (/^docker:\/\/[^\s@]+@sha256:[0-9a-f]{64}$/.test(entry.value)) return null;
  if (
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.+-]+)*@[0-9a-f]{40}$/.test(
      entry.value,
    )
  ) {
    return null;
  }
  return `${label}: remote action must be pinned to a full commit SHA or image digest`;
}

function permissionIssues(value, label) {
  if (value === undefined) return [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [`${label}: permissions must be an explicit read-only map`];
  }
  return Object.entries(value)
    .filter(([, level]) => !["read", "none"].includes(level))
    .map(([scope, level]) => `${label}.${scope}: forbidden permission level ${level}`);
}

function containerImageIssue(value, label) {
  const image = typeof value === "string" ? value : value?.image;
  if (typeof image !== "string") return `${label}: container image must be a literal string`;
  if (!/^[A-Za-z0-9._/:+-]+@sha256:[0-9a-f]{64}$/.test(image)) {
    return `${label}: container image must be pinned to a sha256 digest`;
  }
  return null;
}

function workflowRunnerIssue(value, label) {
  if (typeof value !== "string" || !TRUSTED_WORKFLOW_RUNNERS.has(value)) {
    return `${label}: workflow jobs must use an explicitly allowed GitHub-hosted runner`;
  }
  return null;
}

function numericProjectVersion(value) {
  if (typeof value !== "string") return null;
  const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.exec(value);
  if (!match) return null;
  return match.slice(1).map((part) => BigInt(part));
}

function compareNumericProjectVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return 0;
}

function projectVersionIssues(root, packageVersion) {
  const label = "VERSION";
  const file = join(root, label);
  const issues = [];
  let current;
  let currentParts;
  try {
    const metadata = lstatSync(file);
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error("not a regular file");
    const content = readFileSync(file, "utf8");
    const match = /^((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))\n$/.exec(
      content,
    );
    if (!match) throw new Error("must contain exactly one numeric major.minor.patch version and newline");
    current = match[1];
    currentParts = numericProjectVersion(current);
  } catch (error) {
    return [`${label}: project version policy cannot be loaded: ${error.message}`];
  }
  if (packageVersion !== current) {
    issues.push(`package.json.version: must exactly match VERSION (${current})`);
  }

  for (const [documentationPath, predicate, expectation] of [
    [
      "README.md",
      (content) =>
        content.split("\n").filter((line) => line === `Current project version: \`${current}\`.`)
          .length === 1,
      `must contain exactly one canonical current-version line for ${current}`,
    ],
    [
      "CHANGELOG.md",
      (content) =>
        content
          .split("\n")
          .some((line) => new RegExp(`^## \\[${current.replaceAll(".", "\\.")}\\] - [0-9]{4}-[0-9]{2}-[0-9]{2}$`).test(line)),
      `must contain a dated release heading for ${current}`,
    ],
  ]) {
    try {
      const documentationFile = join(root, documentationPath);
      const metadata = lstatSync(documentationFile);
      if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error("not a regular file");
      if (!predicate(readFileSync(documentationFile, "utf8"))) throw new Error(expectation);
    } catch (error) {
      issues.push(`${documentationPath}: project version is not synchronized: ${error.message}`);
    }
  }

  if (!existsSync(join(root, ".git"))) return issues;
  try {
    const versionPaths = ["VERSION", "package.json", "README.md", "CHANGELOG.md"];
    const commits = execFileSync(
      "git",
      [
        "rev-list",
        "--full-history",
        "--topo-order",
        "--reverse",
        "HEAD",
        "--",
        ...versionPaths,
      ],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    )
      .split("\n")
      .filter(Boolean);
    const snapshots = new Map();
    const snapshotAt = (commit) => {
      if (snapshots.has(commit)) return snapshots.get(commit);
      let snapshot;
      try {
        const contents = new Map();
        for (const repositoryPath of versionPaths) {
          const entry = execFileSync("git", ["ls-tree", commit, "--", repositoryPath], {
            cwd: root,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          }).trim();
          if (!/^100(?:644|755) blob [0-9a-f]{40,64}\t[^\n]+$/.test(entry)) {
            throw new Error(`${repositoryPath} is not a regular blob`);
          }
          contents.set(
            repositoryPath,
            execFileSync("git", ["show", `${commit}:${repositoryPath}`], {
              cwd: root,
              encoding: "utf8",
              stdio: ["ignore", "pipe", "pipe"],
            }),
          );
        }
        const match = /^((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))\n$/.exec(
          contents.get("VERSION"),
        );
        if (!match) throw new Error("noncanonical version bytes");
        const version = match[1];
        const historicalPackage = parseJsonStrict(contents.get("package.json"));
        if (historicalPackage.version !== version) {
          throw new Error(`package.json.version does not match VERSION ${version}`);
        }
        if (
          commit !== TRUSTED_BOOTSTRAP_COMMIT &&
          contents
            .get("README.md")
            .split("\n")
            .filter((line) => line === `Current project version: \`${version}\`.`).length !== 1
        ) {
          throw new Error(`README.md does not contain the canonical ${version} version line`);
        }
        const escapedVersion = version.replaceAll(".", "\\.");
        if (
          !contents
            .get("CHANGELOG.md")
            .split("\n")
            .some((line) =>
              new RegExp(`^## \\[${escapedVersion}\\] - [0-9]{4}-[0-9]{2}-[0-9]{2}$`).test(
                line,
              ),
            )
        ) {
          throw new Error(`CHANGELOG.md lacks a dated ${version} release heading`);
        }
        snapshot = {
          version,
          parts: numericProjectVersion(version),
          error: null,
        };
      } catch (error) {
        snapshot = { version: null, parts: null, error: error.message };
      }
      snapshots.set(commit, snapshot);
      return snapshot;
    };
    for (const commit of commits) {
      const historical = snapshotAt(commit);
      if (historical.error) {
        issues.push(`${label}: committed version bundle at ${commit} is invalid: ${historical.error}`);
        continue;
      }
      const parents = execFileSync("git", ["show", "-s", "--format=%P", commit], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      })
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      for (const parent of parents) {
        const previous = snapshotAt(parent);
        if (
          !previous.error &&
          compareNumericProjectVersions(historical.parts, previous.parts) < 0
        ) {
          issues.push(
            `${label}: committed project version ${historical.version} at ${commit} cannot regress below parent ${previous.version}`,
          );
        }
      }
    }
    const head = snapshotAt("HEAD");
    if (
      !head.error &&
      compareNumericProjectVersions(currentParts, head.parts) < 0
    ) {
      issues.push(
        `${label}: project version ${current} cannot regress below committed ${head.version}`,
      );
    }
  } catch (error) {
    issues.push(`${label}: committed project-version history could not be verified: ${error.message}`);
  }
  return issues;
}

function bootstrapPackageIssues(root) {
  const file = join(root, "package.json");
  const label = "package.json";
  let document;
  try {
    const metadata = lstatSync(file);
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error("not a regular file");
    document = parseJsonStrict(readFileSync(file, "utf8"));
  } catch (error) {
    return [`${label}: bootstrap package policy cannot be loaded: ${error.message}`];
  }
  const issues = [];
  if (
    document.name !== "opensales-system" ||
    document.private !== true ||
    document.license !== "AGPL-3.0-or-later" ||
    document.type !== "module" ||
    document.packageManager !== EXPECTED_PACKAGE_MANAGER ||
    canonicalJson(document.engines) !== canonicalJson({ node: "24.18.0" })
  ) {
    issues.push(`${label}: bootstrap identity, runtime, and package-manager pins must remain exact`);
  }
  issues.push(...projectVersionIssues(root, document.version));
  if (canonicalJson(document.scripts) !== canonicalJson(EXPECTED_PACKAGE_SCRIPTS)) {
    issues.push(
      `${label}: bootstrap scripts must remain exact and cannot add pre/post lifecycle aliases`,
    );
  }
  if (
    canonicalJson(document.devDependencies) !==
    canonicalJson(EXPECTED_BOOTSTRAP_DEPENDENCIES)
  ) {
    issues.push(`${label}: bootstrap validator dependencies must remain exact`);
  }
  if (document.dependencies !== undefined || document.optionalDependencies !== undefined) {
    issues.push(`${label}: bootstrap cannot add runtime or optional dependencies`);
  }
  return issues;
}

function bootstrapWorkflowIssues(root, file, document) {
  if (resolve(file) !== resolve(root, ".github/workflows/bootstrap-policy.yml")) return [];
  const issues = [];
  const label = relative(root, file);
  const actualDigest = sha256Bytes(Buffer.from(canonicalJson(document)));
  if (actualDigest !== EXPECTED_BOOTSTRAP_WORKFLOW_DIGEST) {
    issues.push(
      `${label}: normalized bootstrap workflow must match the reviewed fail-closed structure`,
    );
  }
  const job = document?.jobs?.["bootstrap-policy"];
  if (!job || job.name !== "bootstrap-policy") {
    issues.push(`${label}: required bootstrap-policy job and check name must remain stable`);
    return issues;
  }
  if (
    !workflowTriggerIncludes(document?.on, "pull_request") ||
    !list(document?.on?.push?.branches).includes("main")
  ) {
    issues.push(`${label}: required check must run for pull requests and pushes to main`);
  }
  if (canonicalJson(document?.permissions) !== canonicalJson({ contents: "read" })) {
    issues.push(`${label}: bootstrap workflow permissions must remain exactly contents: read`);
  }
  if (job["timeout-minutes"] !== 10) {
    issues.push(`${label}: bootstrap-policy timeout must remain exactly 10 minutes`);
  }
  const steps = list(job.steps);
  const uses = new Set(steps.map((step) => step?.uses).filter(Boolean));
  if (!uses.has("actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0")) {
    issues.push(`${label}: bootstrap-policy must use the approved pinned checkout action`);
  }
  if (!uses.has("actions/setup-node@820762786026740c76f36085b0efc47a31fe5020")) {
    issues.push(`${label}: bootstrap-policy must use the approved pinned setup-node action`);
  }
  const runLines = steps
    .flatMap((step) => (typeof step?.run === "string" ? step.run.split("\n") : []))
    .map((line) => line.trim());
  for (const requiredLine of [
    "pnpm install --frozen-lockfile --ignore-scripts",
    "node --test tools/validate-specifications.test.mjs",
    "node tools/validate-specifications.mjs",
  ]) {
    if (!runLines.includes(requiredLine)) {
      issues.push(`${label}: bootstrap-policy is missing required command ${requiredLine}`);
    }
  }
  const allRunText = runLines.join("\n");
  if (
    !allRunText.includes(
      "zricethezav/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f",
    )
  ) {
    issues.push(`${label}: bootstrap-policy is missing the approved pinned secret scanner`);
  }
  return issues;
}

function validateGitHubPolicy(root) {
  const issues = [...bootstrapPackageIssues(root)];
  const workflowFiles = walk(join(root, ".github", "workflows")).filter((file) =>
    [".yml", ".yaml"].includes(extname(file)),
  );
  const actionFiles = walk(join(root, ".github", "actions")).filter(
    (file) => ["action.yml", "action.yaml"].includes(file.split(sep).at(-1)),
  );
  const expectedWorkflow = resolve(root, ".github/workflows/bootstrap-policy.yml");
  if (
    workflowFiles.length !== 1 ||
    resolve(workflowFiles[0] ?? "") !== expectedWorkflow
  ) {
    issues.push(
      ".github/workflows: bootstrap phase permits only bootstrap-policy.yml",
    );
  }
  if (actionFiles.length > 0) {
    issues.push(".github/actions: bootstrap phase does not permit local actions");
  }
  for (const file of [...workflowFiles, ...actionFiles]) {
    const label = relative(root, file);
    const metadata = lstatSync(file);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      issues.push(`${label}: workflow and action metadata must be regular non-symlink files`);
      continue;
    }
    const parsed = YAML.parseDocument(readFileSync(file, "utf8"), { uniqueKeys: true });
    if (parsed.errors.length > 0) {
      issues.push(...parsed.errors.map((error) => `${label}: YAML error: ${error.message}`));
      continue;
    }
    let document;
    try {
      document = parsed.toJS({ maxAliasCount: 0 });
    } catch (error) {
      issues.push(`${label}: YAML aliases are forbidden: ${error.message}`);
      continue;
    }
    if (collectKeys(document, "<<").length > 0) {
      issues.push(`${label}: YAML merge keys are forbidden`);
    }
    for (const entry of collectKeys(document, "continue-on-error")) {
      if (entry.value !== false) {
        issues.push(
          `${label}:${entry.path}: continue-on-error must be the literal false value`,
        );
      }
    }
    for (const entry of collectKeys(document, "uses")) {
      const issue = usesIssue(root, file, entry);
      if (issue) issues.push(issue);
    }
    if (actionFiles.includes(file) && document?.runs?.using === "docker") {
      const image = document.runs?.image;
      if (typeof image !== "string" || !image.startsWith("docker://")) {
        issues.push(
          `${label}: Docker actions must use a docker:// image pinned to a sha256 digest; local Dockerfiles are not allowed`,
        );
      } else {
        const issue = containerImageIssue(image.slice("docker://".length), `${label}:runs.image`);
        if (issue) issues.push(issue);
      }
    }
    if (workflowFiles.includes(file)) {
      if (workflowTriggerIncludes(document?.on, "pull_request_target")) {
        issues.push(`${label}: pull_request_target is forbidden`);
      }
      if (document?.permissions === undefined) {
        issues.push(`${label}: workflow-level permissions must be explicit`);
      } else {
        issues.push(...permissionIssues(document.permissions, `${label}:permissions`));
      }
      const workflowText = canonicalJson(document);
      if (/\$\{\{[^}]*\b(?:secrets\b|github\.token\b)/.test(workflowText)) {
        issues.push(`${label}: bootstrap workflows must not reference secrets or github.token`);
      }
      for (const entry of collectKeys(document, "if")) {
        if (entry.value !== true) {
          issues.push(`${label}:${entry.path}: conditional workflow execution is fail-closed`);
        }
      }
      const untrustedTrigger = ["pull_request", "workflow_run", "issue_comment"].some((event) =>
        workflowTriggerIncludes(document?.on, event),
      );
      if (untrustedTrigger && /\$\{\{[^}]*\bsecrets\b/.test(workflowText)) {
        issues.push(`${label}: untrusted-trigger workflow must not reference repository secrets`);
      }
      for (const [jobId, job] of Object.entries(document?.jobs ?? {})) {
        issues.push(...permissionIssues(job?.permissions, `${label}:jobs.${jobId}.permissions`));
        const runnerIssue = workflowRunnerIssue(
          job?.["runs-on"],
          `${label}:jobs.${jobId}.runs-on`,
        );
        if (runnerIssue) issues.push(runnerIssue);
        if (job?.environment !== undefined) {
          issues.push(`${label}:jobs.${jobId}.environment: bootstrap workflows cannot use an environment`);
        }
        if (untrustedTrigger && job?.environment !== undefined) {
          issues.push(`${label}:jobs.${jobId}.environment: untrusted-trigger workflow cannot use an environment`);
        }
        if (job?.container !== undefined) {
          const issue = containerImageIssue(job.container, `${label}:jobs.${jobId}.container`);
          if (issue) issues.push(issue);
        }
        for (const [serviceId, service] of Object.entries(job?.services ?? {})) {
          const issue = containerImageIssue(
            service,
            `${label}:jobs.${jobId}.services.${serviceId}.image`,
          );
          if (issue) issues.push(issue);
        }
      }
      issues.push(...bootstrapWorkflowIssues(root, file, document));
    }
  }
  return issues;
}

function inferKind(file, document) {
  const schemaName = typeof document?.$schema === "string" ? document.$schema.split("/").at(-1) : "";
  const schemaEntry = schemaName
    ? Object.entries(SCHEMA_FILES).find(([, path]) => path.endsWith(schemaName))
    : undefined;
  if (schemaEntry) return schemaEntry[0];
  if (document?.report_id && document?.gate) return "gate";
  if (document?.decision_id && document?.decision_kind === "scope_deviation") return "deviation";
  if (document?.inventory_id && document?.gate === "G0" && document?.features) return "inventory";
  if (document?.table_id && document?.aggregate_id) return "state";
  if (document?.matrix_id && document?.actor_types && document?.permissions) return "guard";
  if (document?.matrix_id && document?.accounts && document?.posting_rules) return "ledger";
  if (document?.oracle_id && document?.oracle_kind && document?.normative_artifacts) {
    return "oracle";
  }
  if (document?.evidence_id && document?.classification) return "evidence";
  return null;
}

function parseDocument(file) {
  const text = readFileSync(file, "utf8");
  if (extname(file) === ".json") {
    return parseJsonStrict(text);
  }
  return YAML.parse(text);
}

function parseJsonStrict(text) {
  const duplicateKeyCheck = YAML.parseDocument(text, { schema: "json", uniqueKeys: true });
  if (duplicateKeyCheck.errors.length > 0) {
    throw new Error(duplicateKeyCheck.errors.map((error) => error.message).join("; "));
  }
  return JSON.parse(text);
}

export function repositoryReferenceIssues(root, references, label, requireRepositoryReference = false) {
  const issues = [];
  for (const reference of list(references)) {
    if (typeof reference !== "string" || !reference.startsWith("repo:")) {
      if (requireRepositoryReference) {
        issues.push(`${label}: acceptance evidence must use a resolvable repo: reference`);
      }
      continue;
    }
    const repositoryPath = reference.slice("repo:".length);
    const segments = repositoryPath.split("/");
    const target = resolve(root, repositoryPath);
    if (
      !repositoryPath ||
      repositoryPath.startsWith("/") ||
      repositoryPath.includes("\\") ||
      segments.includes("..") ||
      (target !== root && !target.startsWith(`${root}${sep}`))
    ) {
      issues.push(`${label}: invalid repository reference ${reference}`);
    } else if (!existsSync(target)) {
      issues.push(`${label}: repository reference does not exist ${reference}`);
    } else {
      const metadata = lstatSync(target);
      const realRoot = realpathSync(root);
      const realTarget = realpathSync(target);
      if (
        target === root ||
        metadata.isSymbolicLink() ||
        !metadata.isFile() ||
        (realTarget !== realRoot && !realTarget.startsWith(`${realRoot}${sep}`))
      ) {
        issues.push(`${label}: repository reference must resolve to a regular in-repository file ${reference}`);
      }
    }
  }
  return issues;
}

function sha256Bytes(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function repositoryContentDigestIssues(root, artifacts, label, wrapperFile) {
  const issues = [];
  for (const [index, artifact] of list(artifacts).entries()) {
    const artifactLabel = `${label}.${index}`;
    const referenceIssues = repositoryReferenceIssues(
      root,
      [artifact?.reference],
      `${artifactLabel}.reference`,
      true,
    );
    issues.push(...referenceIssues);
    if (referenceIssues.length > 0) continue;

    const repositoryPath = artifact.reference.slice("repo:".length);
    const target = resolve(root, repositoryPath);
    if (wrapperFile && resolve(wrapperFile) === target) {
      issues.push(`${artifactLabel}.reference: an oracle cannot declare itself as a normative artifact`);
      continue;
    }
    const actualDigest = sha256Bytes(readFileSync(target));
    if (artifact?.content_digest !== actualDigest) {
      issues.push(`${artifactLabel}.content_digest: does not match repository artifact bytes`);
    }
  }
  return issues;
}

function trustedLedgerRunnerIssues(root, record) {
  const document = record.document;
  if (document.review?.status !== "passed") return [];
  const issues = [];
  const label = relative(root, record.file);
  const runnerPath = join(root, "tools", "run-ledger-golden-vectors.mjs");
  const executable = document.golden_runner?.executable;
  const attestationArtifact = document.golden_runner?.attestation;
  if (
    !existsSync(runnerPath) ||
    lstatSync(runnerPath).isSymbolicLink() ||
    !lstatSync(runnerPath).isFile()
  ) {
    return [`${label}.golden_runner: trusted exact-ledger executable is missing`];
  }
  const runnerDigest = sha256Bytes(readFileSync(runnerPath));
  if (runnerDigest !== TRUSTED_LEDGER_RUNNER_DIGEST) {
    issues.push(`${label}.golden_runner.executable: source is not the reviewed trust-anchor runner`);
  }
  if (
    executable?.reference !== "repo:tools/run-ledger-golden-vectors.mjs" ||
    executable?.content_digest !== runnerDigest
  ) {
    issues.push(`${label}.golden_runner.executable: declaration does not bind executable bytes`);
  }
  issues.push(
    ...repositoryContentDigestIssues(
      root,
      [executable, attestationArtifact],
      `${label}.golden_runner.artifacts`,
      record.file,
    ),
  );
  if (issues.length > 0) return issues;

  if (!label.startsWith("docs/specifications/") || extname(label) !== ".json") {
    return [`${label}: passed ledger matrix must be JSON under docs/specifications/`];
  }
  let output;
  try {
    output = execFileSync(
      process.execPath,
      [
        runnerPath,
        "--protocol",
        "oss-ledger-exact/v1",
        "--root",
        root,
        "--matrix",
        label,
        "--format",
        "canonical-json",
      ],
      {
        cwd: root,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 10_000,
        maxBuffer: 16 * 1024 * 1024,
      },
    );
  } catch (error) {
    issues.push(`${label}.golden_runner: exact-ledger execution failed closed (${error.status ?? "error"})`);
    return issues;
  }
  let attestation;
  try {
    attestation = parseJsonStrict(output.toString("utf8"));
  } catch (error) {
    issues.push(`${label}.golden_runner: runner stdout is not one strict JSON attestation: ${error.message}`);
    return issues;
  }
  if (!output.equals(Buffer.from(`${canonicalJson(attestation)}\n`))) {
    issues.push(`${label}.golden_runner: runner stdout is not deterministic canonical JSON plus LF`);
  }
  for (const validationIssue of validateDocument("ledgerArtifact", attestation)) {
    issues.push(`${label}.golden_runner.attestation: ${validationIssue}`);
  }
  const attestationPath = resolve(root, attestationArtifact.reference.slice("repo:".length));
  if (!output.equals(readFileSync(attestationPath))) {
    issues.push(`${label}.golden_runner.attestation: stored bytes differ from fresh runner output`);
  }
  if (
    attestation.kind !== "attestation" ||
    attestation.protocol !== "oss-ledger-exact/v1" ||
    attestation.matrix_id !== document.matrix_id ||
    attestation.runner_digest !== runnerDigest ||
    attestation.matrix_semantic_digest !== ledgerMatrixSemanticDigest(document)
  ) {
    issues.push(`${label}.golden_runner.attestation: identity or semantic digest mismatch`);
  }
  const declaredVectors = list(document.golden_vector_refs);
  if (list(attestation.vectors).length !== declaredVectors.length) {
    issues.push(`${label}.golden_runner.attestation: vector count does not match the matrix`);
  }
  for (let index = 0; index < declaredVectors.length; index += 1) {
    const declared = declaredVectors[index];
    const actual = list(attestation.vectors)[index];
    if (
      actual?.vector_id !== declared?.vector_id ||
      actual?.vector_digest !== declared?.content_digest ||
      actual?.input_digest !== declared?.input_fixture_digest ||
      actual?.expected_digest !== declared?.expected_postings_digest ||
      actual?.result !== "passed"
    ) {
      issues.push(
        `${label}.golden_runner.attestation: vector ${declared?.vector_id} is missing, reordered, or not digest-bound`,
      );
    }
  }
  return issues;
}

function evidenceSupersessionIssues(root, evidenceRecords) {
  const issues = [];
  const byId = new Map();
  const successors = new Map();
  const activeByFeature = new Map();

  for (const record of evidenceRecords) {
    const document = record.document;
    if (document.evidence_id && !byId.has(document.evidence_id)) {
      byId.set(document.evidence_id, record);
    }
    if (document.lifecycle?.status !== "superseded" && document.feature_id) {
      const existing = activeByFeature.get(document.feature_id);
      if (existing) {
        issues.push(
          `${relative(root, record.file)}: feature ${document.feature_id} has multiple active evidence cards; first seen in ${relative(root, existing.file)}`,
        );
      } else {
        activeByFeature.set(document.feature_id, record);
      }
    }
  }

  for (const record of evidenceRecords) {
    const document = record.document;
    const predecessorId = document.lifecycle?.supersedes;
    if (!predecessorId) continue;
    const label = relative(root, record.file);
    const current = successors.get(predecessorId) ?? [];
    current.push(record);
    successors.set(predecessorId, current);
    if (predecessorId === document.evidence_id) {
      issues.push(`${label}: evidence card cannot supersede itself`);
      continue;
    }
    const predecessor = byId.get(predecessorId);
    if (!predecessor) {
      issues.push(`${label}: supersedes unresolved evidence ${predecessorId}`);
      continue;
    }
    const previous = predecessor.document;
    if (previous.lifecycle?.status !== "superseded") {
      issues.push(`${label}: superseded predecessor ${predecessorId} must have lifecycle status superseded`);
    }
    if (document.feature_id !== previous.feature_id) {
      issues.push(`${label}: supersession must preserve feature_id ${previous.feature_id}`);
    }
    if (document.lifecycle?.goal_scope !== previous.lifecycle?.goal_scope) {
      issues.push(`${label}: supersession cannot change goal_scope`);
    }
    if (document.lifecycle?.first_gate !== previous.lifecycle?.first_gate) {
      issues.push(`${label}: supersession cannot defer first_gate`);
    }
    if (
      GATE_INDEX.get(document.lifecycle?.acceptance_gate) >
      GATE_INDEX.get(previous.lifecycle?.acceptance_gate)
    ) {
      issues.push(`${label}: supersession cannot defer acceptance_gate`);
    }
    if (PRIORITY_INDEX.get(document.priority) > PRIORITY_INDEX.get(previous.priority)) {
      issues.push(`${label}: supersession cannot lower priority`);
    }
    if (document.lifecycle?.status === "draft") {
      issues.push(`${label}: a draft card cannot supersede frozen evidence`);
    }
    if (
      previous.classification?.status === "unknown" &&
      document.classification?.status === "unknown" &&
      GATE_INDEX.get(document.unknown_handling?.resolution_gate) >
        GATE_INDEX.get(previous.unknown_handling?.resolution_gate)
    ) {
      issues.push(`${label}: supersession cannot defer an unknown resolution_gate`);
    }
  }

  for (const record of evidenceRecords) {
    if (record.document.lifecycle?.status !== "superseded") continue;
    const successorCount = list(successors.get(record.document.evidence_id)).length;
    if (successorCount !== 1) {
      issues.push(
        `${relative(root, record.file)}: superseded evidence needs exactly one direct successor; found ${successorCount}`,
      );
    }
  }

  const reportedCycles = new Set();
  for (const start of evidenceRecords) {
    const trail = new Set();
    let cursor = start;
    while (cursor?.document.lifecycle?.supersedes) {
      const cursorId = cursor.document.evidence_id;
      if (trail.has(cursorId)) {
        const cycleKey = [...trail].sort().join("|");
        if (!reportedCycles.has(cycleKey)) {
          issues.push(`${relative(root, start.file)}: evidence supersession graph contains a cycle`);
          reportedCycles.add(cycleKey);
        }
        break;
      }
      trail.add(cursorId);
      cursor = byId.get(cursor.document.lifecycle.supersedes);
    }
  }
  return issues;
}

function frozenEvidenceProjection(document) {
  const traceability = document.traceability ?? {};
  const review = document.review ?? {};
  return {
    evidence_id: document.evidence_id,
    feature_id: document.feature_id,
    title: document.title,
    priority: document.priority,
    business_description: document.business_description,
    sources: list(document.sources).map(({ verification_status, observed_at, ...source }) => source),
    classification: document.classification,
    governance: document.governance,
    disposition: document.disposition,
    traceability: {
      aggregate_ids: traceability.aggregate_ids,
      command_ids: traceability.command_ids,
      state_transition_ids: traceability.state_transition_ids,
      guard_ids: traceability.guard_ids,
      permission_ids: traceability.permission_ids,
      ledger_vector_ids: traceability.ledger_vector_ids,
      contract_schema_ids: traceability.contract_schema_ids,
      test_refs: traceability.test_refs,
    },
    data_and_trust: document.data_and_trust,
    unknown_handling: document.unknown_handling,
    scenarios: document.scenarios,
    review: {
      author_role: review.author_role,
      reviewer_roles: review.reviewer_roles,
      independent_review: review.independent_review,
      status: review.status,
      reproduction_commands: review.reproduction_commands,
      findings: review.findings,
    },
    lifecycle: {
      goal_scope: document.lifecycle?.goal_scope,
      first_gate: document.lifecycle?.first_gate,
      acceptance_gate: document.lifecycle?.acceptance_gate,
      created_at: document.lifecycle?.created_at,
      supersedes: document.lifecycle?.supersedes,
    },
  };
}

function evidenceHistoryEdgeIssues(label, previous, current) {
  const issues = [];
  const previousLifecycle = previous?.lifecycle?.status;
  if (!FROZEN_EVIDENCE_STATUSES.includes(previousLifecycle)) return issues;
  const currentLifecycle = current?.lifecycle?.status;
  if (!FROZEN_EVIDENCE_STATUSES.includes(currentLifecycle)) {
    return [`${label}: frozen evidence history contains a deletion or draft downgrade`];
  }
  if (!EVIDENCE_LIFECYCLE_TRANSITIONS[previousLifecycle]?.has(currentLifecycle)) {
    issues.push(
      `${label}: frozen evidence lifecycle cannot regress from ${previousLifecycle} to ${currentLifecycle}`,
    );
  }
  if (
    Number.isFinite(Date.parse(previous.lifecycle?.updated_at ?? "")) &&
    Number.isFinite(Date.parse(current.lifecycle?.updated_at ?? "")) &&
    Date.parse(current.lifecycle.updated_at) < Date.parse(previous.lifecycle.updated_at)
  ) {
    issues.push(`${label}: frozen evidence updated_at cannot move backwards`);
  }
  const currentSources = new Map(
    list(current.sources).map((source) => [source?.source_id, source]),
  );
  for (const previousSource of list(previous.sources)) {
    const currentSource = currentSources.get(previousSource?.source_id);
    if (!currentSource) continue;
    if (
      !SOURCE_VERIFICATION_TRANSITIONS[previousSource?.verification_status]?.has(
        currentSource?.verification_status,
      )
    ) {
      issues.push(
        `${label}: source ${previousSource?.source_id} verification cannot change in place from ${previousSource?.verification_status} to ${currentSource?.verification_status}; create a successor card instead`,
      );
    }
  }
  const currentReviewReferences = new Set(list(current.review?.evidence_refs));
  for (const reference of list(previous.review?.evidence_refs)) {
    if (!currentReviewReferences.has(reference)) {
      issues.push(
        `${label}: frozen review evidence reference cannot be removed in place ${reference}`,
      );
    }
  }
  for (const field of ["implementation_refs", "artifact_refs"]) {
    const currentReferences = new Set(list(current.traceability?.[field]));
    for (const reference of list(previous.traceability?.[field])) {
      if (!currentReferences.has(reference)) {
        issues.push(
          `${label}: frozen traceability ${field} reference cannot be removed in place ${reference}`,
        );
      }
    }
  }
  return issues;
}

function frozenEvidenceHistoryIssues(root, record) {
  const document = record.document;
  if (
    !FROZEN_EVIDENCE_STATUSES.includes(document.lifecycle?.status) ||
    !existsSync(record.file)
  ) {
    return [];
  }
  const label = relative(root, record.file);
  const expectedPath = `docs/provenance/cards/${document.evidence_id}.yaml`;
  const issues = [];
  const metadata = lstatSync(record.file);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    return [`${label}: frozen evidence must be a regular non-symlink repository file`];
  }
  if (label !== expectedPath) {
    return [`${label}: frozen evidence must use stable path ${expectedPath}`];
  }
  if (!existsSync(join(root, ".git"))) {
    return [`${label}: frozen evidence history cannot be verified without Git`];
  }
  try {
    const commits = execFileSync(
      "git",
      ["rev-list", "--full-history", "--topo-order", "--reverse", "HEAD", "--", label],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    )
      .split("\n")
      .filter(Boolean);
    const snapshots = new Map();
    const snapshotAt = (commit) => {
      if (snapshots.has(commit)) return snapshots.get(commit);
      let snapshot = null;
      try {
        const content = execFileSync("git", ["show", `${commit}:${label}`], {
          cwd: root,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
        snapshot = extname(label) === ".json" ? parseJsonStrict(content) : YAML.parse(content);
      } catch {
        // A deletion, malformed snapshot, or missing path is represented as null.
      }
      snapshots.set(commit, snapshot);
      return snapshot;
    };
    let firstFrozen;
    const highLifecycleHistory = [];
    for (const commit of commits) {
      const historical = snapshotAt(commit);
      if (FROZEN_EVIDENCE_STATUSES.includes(historical?.lifecycle?.status)) {
        firstFrozen ??= historical;
        highLifecycleHistory.push(historical);
      }
      const parents = execFileSync("git", ["show", "-s", "--format=%P", commit], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      })
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      for (const parent of parents) {
        issues.push(...evidenceHistoryEdgeIssues(label, snapshotAt(parent), historical));
      }
    }
    if (!firstFrozen) {
      issues.push(`${label}: frozen evidence has no committed first-freeze snapshot`);
      return issues;
    }
    if (
      highLifecycleHistory.some(
        (snapshot) =>
          canonicalJson(frozenEvidenceProjection(snapshot)) !==
          canonicalJson(frozenEvidenceProjection(firstFrozen)),
      )
    ) {
      issues.push(`${label}: frozen evidence history contains an in-place decision rewrite`);
    }
    const headSnapshot = snapshotAt("HEAD");
    issues.push(...evidenceHistoryEdgeIssues(label, headSnapshot, document));
    if (firstFrozen.evidence_id !== document.evidence_id) {
      issues.push(`${label}: stable evidence path was previously frozen for another evidence id`);
    } else if (
      canonicalJson(frozenEvidenceProjection(firstFrozen)) !==
      canonicalJson(frozenEvidenceProjection(document))
    ) {
      issues.push(`${label}: frozen evidence decision changed in place; create a successor card instead`);
    }
  } catch {
    issues.push(`${label}: frozen evidence Git history could not be verified`);
  }
  return issues;
}

function frozenEvidenceInventoryIssues(root, evidenceRecords) {
  if (!existsSync(join(root, ".git"))) return [];
  try {
    execFileSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: root, stdio: "ignore" });
  } catch {
    return [];
  }
  const issues = [];
  const currentByPath = new Map(
    evidenceRecords.map((record) => [relative(root, record.file), record]),
  );
  try {
    const historicalPaths = new Set(
      execFileSync(
        "git",
        [
          "log",
          "--full-history",
          "--pretty=format:",
          "--name-only",
          "--diff-filter=AM",
          "HEAD",
          "--",
          "docs/provenance/cards",
        ],
        { cwd: root, encoding: "utf8" },
      )
        .split("\n")
        .filter((path) => path.startsWith("docs/provenance/cards/") && path.endsWith(".yaml")),
    );
    for (const path of historicalPaths) {
      const currentRecord = currentByPath.get(path);
      if (
        currentRecord &&
        FROZEN_EVIDENCE_STATUSES.includes(currentRecord.document.lifecycle?.status)
      ) {
        continue;
      }
      const commits = execFileSync("git", ["rev-list", "--full-history", "--topo-order", "--reverse", "HEAD", "--", path], {
        cwd: root,
        encoding: "utf8",
      })
        .split("\n")
        .filter(Boolean);
      for (const commit of commits) {
        try {
          const historical = YAML.parse(
            execFileSync("git", ["show", `${commit}:${path}`], {
              cwd: root,
              encoding: "utf8",
            }),
          );
          if (FROZEN_EVIDENCE_STATUSES.includes(historical?.lifecycle?.status)) {
            issues.push(
              currentRecord
                ? `${path}: frozen evidence cannot return to draft status`
                : `${path}: frozen evidence cannot be removed or renamed`,
            );
            break;
          }
        } catch {
          // A path can be absent in commits that record a deletion; continue to its first blob.
        }
      }
    }
  } catch {
    issues.push("docs/provenance/cards: frozen evidence inventory history could not be verified");
  }
  return issues;
}

function frozenInventoryHistoryIssues(root, record) {
  const document = record.document;
  if (document.lifecycle?.status !== "frozen" || !existsSync(record.file)) return [];
  const label = relative(root, record.file);
  const expectedPath = "docs/provenance/inventory.g0.json";
  const issues = [];
  const metadata = lstatSync(record.file);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    return [`${label}: frozen G0 Evidence Inventory must be a regular non-symlink repository file`];
  }
  if (label !== expectedPath) {
    return [`${label}: frozen G0 Evidence Inventory must use stable path ${expectedPath}`];
  }
  if (!existsSync(join(root, ".git"))) {
    return [`${label}: frozen inventory history cannot be verified without Git`];
  }
  try {
    const commits = execFileSync(
      "git",
      ["rev-list", "--full-history", "--topo-order", "--reverse", "HEAD", "--", label],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    )
      .split("\n")
      .filter(Boolean);
    const snapshots = new Map();
    const snapshotAt = (commit) => {
      if (snapshots.has(commit)) return snapshots.get(commit);
      let snapshot = null;
      try {
        snapshot = parseJsonStrict(
          execFileSync("git", ["show", `${commit}:${label}`], {
            cwd: root,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          }),
        );
      } catch {
        // Missing, deleted, or malformed snapshots remain null and fail on a frozen parent edge.
      }
      snapshots.set(commit, snapshot);
      return snapshot;
    };
    let firstFrozen = null;
    let downgradedOrDeleted = false;
    let rewritten = false;
    for (const commit of commits) {
      const historical = snapshotAt(commit);
      if (historical?.lifecycle?.status === "frozen") {
        firstFrozen ??= historical;
        if (canonicalJson(historical) !== canonicalJson(firstFrozen)) rewritten = true;
      }
      const parents = execFileSync("git", ["show", "-s", "--format=%P", commit], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      })
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      for (const parent of parents) {
        const previous = snapshotAt(parent);
        if (previous?.lifecycle?.status !== "frozen") continue;
        if (historical?.lifecycle?.status !== "frozen") {
          downgradedOrDeleted = true;
        } else if (canonicalJson(previous) !== canonicalJson(historical)) {
          rewritten = true;
        }
      }
    }
    if (!firstFrozen) {
      issues.push(`${label}: frozen inventory has no committed first-freeze snapshot`);
    } else {
      if (downgradedOrDeleted) {
        issues.push(`${label}: frozen inventory history contains a deletion or draft downgrade`);
      }
      if (rewritten) {
        issues.push(`${label}: frozen inventory history contains an in-place rewrite`);
      }
      if (firstFrozen.inventory_id !== document.inventory_id) {
        issues.push(`${label}: stable inventory path was previously frozen for another inventory id`);
      } else if (canonicalJson(firstFrozen) !== canonicalJson(document)) {
        issues.push(`${label}: frozen inventory changed in place; reopen G0 through reviewed policy`);
      }
    }
  } catch {
    issues.push(`${label}: frozen inventory Git history could not be verified`);
  }
  return issues;
}

function frozenInventorySetIssues(root, inventoryRecords) {
  if (!existsSync(join(root, ".git"))) return [];
  try {
    execFileSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: root, stdio: "ignore" });
  } catch {
    return [];
  }
  const expectedPath = "docs/provenance/inventory.g0.json";
  const current = inventoryRecords.find((record) => relative(root, record.file) === expectedPath);
  if (current?.document.lifecycle?.status === "frozen") return [];
  try {
    const commits = execFileSync(
      "git",
      ["rev-list", "--full-history", "--topo-order", "--reverse", "HEAD", "--", expectedPath],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    )
      .split("\n")
      .filter(Boolean);
    for (const commit of commits) {
      try {
        const historical = parseJsonStrict(
          execFileSync("git", ["show", `${commit}:${expectedPath}`], {
            cwd: root,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          }),
        );
        if (historical?.lifecycle?.status === "frozen") {
          return [
            current
              ? `${expectedPath}: frozen inventory cannot return to draft status`
              : `${expectedPath}: frozen inventory cannot be removed or renamed`,
          ];
        }
      } catch {
        // Continue to the first committed blob that can prove the freeze.
      }
    }
  } catch {
    return [`${expectedPath}: frozen inventory set could not be verified`];
  }
  return [];
}

function immutableDeviationHistoryIssues(root, deviationRecords) {
  const issues = [];
  const currentByPath = new Map();
  for (const record of deviationRecords) {
    const label = relative(root, record.file);
    const expectedPath = `docs/governance/decisions/${record.document.decision_id}.json`;
    if (label !== expectedPath) {
      issues.push(`${label}: deviation approval must use stable path ${expectedPath}`);
      continue;
    }
    if (!existsSync(record.file)) {
      issues.push(`${label}: deviation approval file is missing`);
      continue;
    }
    const metadata = lstatSync(record.file);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      issues.push(`${label}: frozen deviation approval must be a regular non-symlink file`);
      continue;
    }
    currentByPath.set(label, record);
  }
  if (!existsSync(join(root, ".git"))) return issues;
  try {
    execFileSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: root, stdio: "ignore" });
  } catch {
    return issues;
  }
  try {
    const historicalPaths = new Set(
      execFileSync(
        "git",
        [
          "log",
          "--full-history",
          "--pretty=format:",
          "--name-only",
          "--diff-filter=AM",
          "HEAD",
          "--",
          "docs/governance/decisions",
        ],
        { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      )
        .split("\n")
        .filter(
          (path) => path.startsWith("docs/governance/decisions/") && path.endsWith(".json"),
        ),
    );
    for (const path of historicalPaths) {
      const commits = execFileSync("git", ["rev-list", "--full-history", "--topo-order", "--reverse", "HEAD", "--", path], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      })
        .split("\n")
        .filter(Boolean);
      const snapshots = new Map();
      const snapshotAt = (commit) => {
        if (snapshots.has(commit)) return snapshots.get(commit);
        let snapshot = null;
        try {
          snapshot = parseJsonStrict(
            execFileSync("git", ["show", `${commit}:${path}`], {
              cwd: root,
              encoding: "utf8",
              stdio: ["ignore", "pipe", "pipe"],
            }),
          );
        } catch {
          // Missing, deleted, or malformed snapshots remain null for edge validation.
        }
        snapshots.set(commit, snapshot);
        return snapshot;
      };
      const isApproval = (document) =>
        document?.decision_kind === "scope_deviation" &&
        document?.lifecycle?.status === "frozen";
      let firstApproval;
      let rewritten = false;
      for (const commit of commits) {
        const historical = snapshotAt(commit);
        if (isApproval(historical)) {
          firstApproval ??= historical;
          if (canonicalJson(historical) !== canonicalJson(firstApproval)) rewritten = true;
        }
        const parents = execFileSync("git", ["show", "-s", "--format=%P", commit], {
          cwd: root,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        })
          .trim()
          .split(/\s+/)
          .filter(Boolean);
        for (const parent of parents) {
          const previous = snapshotAt(parent);
          if (
            isApproval(previous) &&
            (!isApproval(historical) || canonicalJson(previous) !== canonicalJson(historical))
          ) {
            rewritten = true;
          }
        }
      }
      if (!firstApproval) continue;
      const current = currentByPath.get(path);
      if (!current) {
        issues.push(`${path}: frozen deviation approval cannot be removed or renamed`);
      } else if (
        rewritten ||
        canonicalJson(firstApproval) !== canonicalJson(current.document)
      ) {
        issues.push(`${path}: frozen deviation approval cannot be rewritten in place`);
      }
    }
  } catch {
    issues.push("docs/governance/decisions: frozen deviation history could not be verified");
  }
  return issues;
}

function gateReportChainIssues(root, gateRecords) {
  const issues = [];
  const byId = new Map();
  const successors = new Map();
  for (const record of gateRecords) {
    const reportId = record.document.report_id;
    if (!reportId || byId.has(reportId)) continue;
    byId.set(reportId, record);
    const label = relative(root, record.file);
    const expectedPath = `docs/gates/reports/${reportId}.yaml`;
    if (label !== expectedPath) {
      issues.push(`${label}: Gate report must use append-only stable path ${expectedPath}`);
    }
  }
  for (const record of gateRecords) {
    const document = record.document;
    const predecessorId = document.supersedes_report_id;
    if (!predecessorId) continue;
    const label = relative(root, record.file);
    if (predecessorId === document.report_id) {
      issues.push(`${label}: Gate report cannot supersede itself`);
      continue;
    }
    const predecessor = byId.get(predecessorId);
    if (!predecessor) {
      issues.push(`${label}: supersedes unresolved Gate report ${predecessorId}`);
      continue;
    }
    if (predecessor.document.gate !== document.gate) {
      issues.push(`${label}: Gate report amendment cannot change Gate identity`);
    }
    const successorList = successors.get(predecessorId) ?? [];
    successorList.push(record);
    successors.set(predecessorId, successorList);
    if (
      Date.parse(document.recorded_at ?? "") <= Date.parse(predecessor.document.recorded_at ?? "")
    ) {
      issues.push(`${label}: Gate report amendment must have a later recorded_at`);
    }
  }
  for (const [predecessorId, successorList] of successors) {
    if (successorList.length !== 1) {
      issues.push(
        `${relative(root, byId.get(predecessorId).file)}: Gate report has ${successorList.length} direct amendments; exactly one is allowed`,
      );
    }
  }
  const reportedCycles = new Set();
  for (const start of gateRecords) {
    const trail = new Set();
    let cursor = start;
    while (cursor?.document.supersedes_report_id) {
      const reportId = cursor.document.report_id;
      if (trail.has(reportId)) {
        const cycle = [...trail].sort().join("|");
        if (!reportedCycles.has(cycle)) {
          issues.push(`${relative(root, start.file)}: Gate report amendment chain contains a cycle`);
          reportedCycles.add(cycle);
        }
        break;
      }
      trail.add(reportId);
      cursor = byId.get(cursor.document.supersedes_report_id);
    }
  }
  const activeRecords = gateRecords.filter(
    (record) => !successors.has(record.document.report_id),
  );
  return { issues, activeRecords };
}

function immutableGateReportHistoryIssues(root, gateRecords) {
  if (!existsSync(join(root, ".git"))) return [];
  try {
    execFileSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: root, stdio: "ignore" });
  } catch {
    return [];
  }
  const issues = [];
  const currentByPath = new Map(gateRecords.map((record) => [relative(root, record.file), record]));
  try {
    const historicalPaths = new Set(
      execFileSync(
        "git",
        ["log", "--full-history", "--pretty=format:", "--name-only", "--diff-filter=AM", "HEAD", "--", "docs/gates/reports"],
        { cwd: root, encoding: "utf8" },
      )
        .split("\n")
        .filter(
          (path) => path.startsWith("docs/gates/reports/") && path.endsWith(".yaml"),
        ),
    );
    for (const path of historicalPaths) {
      const commits = execFileSync("git", ["rev-list", "--full-history", "--topo-order", "--reverse", "HEAD", "--", path], {
        cwd: root,
        encoding: "utf8",
      })
        .split("\n")
        .filter(Boolean);
      const snapshots = new Map();
      const snapshotAt = (commit) => {
        if (snapshots.has(commit)) return snapshots.get(commit);
        let snapshot = { isReport: false, bytes: null };
        try {
          const entry = execFileSync("git", ["ls-tree", commit, "--", path], {
            cwd: root,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          }).trim();
          if (!/^100(?:644|755) blob [0-9a-f]{40,64}\t[^\n]+$/.test(entry)) {
            snapshots.set(commit, snapshot);
            return snapshot;
          }
          const bytes = execFileSync("git", ["show", `${commit}:${path}`], {
            cwd: root,
            maxBuffer: 16 * 1024 * 1024,
            stdio: ["ignore", "pipe", "pipe"],
          });
          const historical = parseYamlStrict(bytes.toString("utf8"));
          if (historical?.report_id && historical?.gate) {
            snapshot = { isReport: true, bytes };
          }
        } catch {
          // Missing, non-regular, or malformed snapshots are not valid reports.
        }
        snapshots.set(commit, snapshot);
        return snapshot;
      };
      const origins = [];
      const reportSnapshots = [];
      let changedInHistory = false;
      for (const commit of commits) {
        const historical = snapshotAt(commit);
        const parents = execFileSync("git", ["show", "-s", "--format=%P", commit], {
          cwd: root,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        })
          .trim()
          .split(/\s+/)
          .filter(Boolean);
        const reportParents = parents
          .map((parent) => snapshotAt(parent))
          .filter((snapshot) => snapshot.isReport);
        if (historical.isReport) {
          reportSnapshots.push(historical);
          if (reportParents.length === 0) origins.push({ commit, snapshot: historical });
          if (reportParents.some((parent) => !parent.bytes.equals(historical.bytes))) {
            changedInHistory = true;
          }
        } else if (reportParents.length > 0) {
          changedInHistory = true;
        }
      }
      if (reportSnapshots.length === 0) continue;
      if (origins.length !== 1) changedInHistory = true;
      const originBytes = origins[0]?.snapshot.bytes ?? reportSnapshots[0].bytes;
      if (reportSnapshots.some((snapshot) => !snapshot.bytes.equals(originBytes))) {
        changedInHistory = true;
      }
      const current = currentByPath.get(path);
      if (!current) {
        issues.push(`${path}: committed Gate report cannot be removed or renamed`);
      } else {
        let currentBytes = null;
        try {
          const metadata = lstatSync(current.file);
          if (!metadata.isSymbolicLink() && metadata.isFile()) {
            currentBytes = readFileSync(current.file);
          }
        } catch {
          // A missing or non-regular working-tree report fails the byte comparison.
        }
        if (changedInHistory || !currentBytes?.equals(originBytes)) {
          issues.push(`${path}: committed Gate report is append-only and cannot change in place`);
        }
      }
    }
  } catch {
    issues.push("docs/gates/reports: Gate report inventory history could not be verified");
  }
  return issues;
}

function gitHistoryCompletenessIssues(root) {
  if (!existsSync(join(root, ".git"))) return [];
  try {
    execFileSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: root, stdio: "ignore" });
  } catch {
    return [];
  }
  const issues = [];
  const replacementBase = process.env.GIT_REPLACE_REF_BASE;
  if (replacementBase !== undefined && replacementBase !== "refs/replace/") {
    issues.push(
      "git.history: non-default GIT_REPLACE_REF_BASE is forbidden during normative history validation",
    );
  }
  try {
    const shallow = execFileSync("git", ["rev-parse", "--is-shallow-repository"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (shallow !== "false") {
      issues.push("git.history: full reachable history is required; shallow repositories fail closed");
    }
  } catch {
    issues.push("git.history: repository history completeness could not be verified");
  }
  try {
    const replacements = execFileSync(
      "git",
      ["for-each-ref", "--format=%(refname)", "refs/replace/"],
      {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    )
      .split("\n")
      .filter(Boolean);
    if (replacements.length > 0) {
      issues.push("git.history: replace refs are forbidden during normative history validation");
    }
  } catch {
    issues.push("git.history: replace-ref state could not be verified");
  }
  try {
    const graftPath = execFileSync("git", ["rev-parse", "--git-path", "info/grafts"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    try {
      lstatSync(resolve(root, graftPath));
      issues.push("git.history: legacy graft files are forbidden during normative history validation");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  } catch {
    issues.push("git.history: graft state could not be verified");
  }
  return issues;
}

function gitRepositoryReferenceIssues(root, commit, references, label) {
  const issues = [];
  for (const reference of list(references)) {
    if (typeof reference !== "string" || !reference.startsWith("repo:")) {
      issues.push(`${label}: Gate evidence must use a repository reference captured by the report commit`);
      continue;
    }
    const repositoryPath = reference.slice("repo:".length);
    const segments = repositoryPath.split("/");
    if (
      !repositoryPath ||
      repositoryPath.startsWith("/") ||
      repositoryPath.includes("\\") ||
      segments.includes("..") ||
      segments.includes("")
    ) {
      issues.push(`${label}: invalid repository reference ${reference}`);
      continue;
    }
    try {
      const entry = execFileSync("git", ["ls-tree", commit, "--", repositoryPath], {
        cwd: root,
        encoding: "utf8",
      }).trim();
      if (!/^100(?:644|755) blob [0-9a-f]{40,64}\t[^\n]+$/.test(entry)) {
        throw new Error("not a regular blob");
      }
    } catch {
      issues.push(
        `${label}: repository evidence was not a regular file in report commit ${reference}`,
      );
    }
  }
  return issues;
}

function gitRepositoryContentDigestIssues(root, commit, artifacts, label) {
  const issues = [];
  for (const [index, artifact] of list(artifacts).entries()) {
    const artifactLabel = `${label}.${index}`;
    const referenceIssues = gitRepositoryReferenceIssues(
      root,
      commit,
      [artifact?.reference],
      `${artifactLabel}.reference`,
    );
    issues.push(...referenceIssues);
    if (referenceIssues.length > 0) continue;
    const repositoryPath = artifact.reference.slice("repo:".length);
    try {
      const bytes = execFileSync("git", ["show", `${commit}:${repositoryPath}`], {
        cwd: root,
        maxBuffer: 64 * 1024 * 1024,
      });
      if (artifact?.content_digest !== sha256Bytes(bytes)) {
        issues.push(
          `${artifactLabel}.content_digest: does not match artifact bytes in the Gate report commit`,
        );
      }
    } catch {
      issues.push(`${artifactLabel}.content_digest: Gate artifact digest could not be verified`);
    }
  }
  return issues;
}

function gitDocumentSnapshotIssues(root, commit, file, label) {
  const metadata = existsSync(file) ? lstatSync(file) : null;
  if (!metadata || metadata.isSymbolicLink() || !metadata.isFile()) {
    return [`${label}: captured document must be a regular non-symlink repository file`];
  }
  const repositoryPath = relative(root, file);
  if (
    !repositoryPath ||
    repositoryPath.startsWith("..") ||
    repositoryPath.includes("\\") ||
    repositoryPath.split("/").includes("")
  ) {
    return [`${label}: captured document path is not a valid repository path`];
  }
  try {
    const entry = execFileSync("git", ["ls-tree", commit, "--", repositoryPath], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    if (!/^100(?:644|755) blob [0-9a-f]{40,64}\t[^\n]+$/.test(entry)) {
      throw new Error("not a regular blob");
    }
    const committedBytes = execFileSync("git", ["show", `${commit}:${repositoryPath}`], {
      cwd: root,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (!committedBytes.equals(readFileSync(file))) {
      return [`${label}: validated document bytes do not match the report commit blob`];
    }
    return [];
  } catch {
    return [`${label}: document was not a regular immutable file in the report commit`];
  }
}

function gitPathOriginCommit(root, repositoryPath) {
  const commits = execFileSync(
    "git",
    [
      "rev-list",
      "--full-history",
      "--topo-order",
      "--reverse",
      "HEAD",
      "--",
      repositoryPath,
    ],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  )
    .split("\n")
    .filter(Boolean);
  const origins = [];
  const isRegularAt = (commit) => {
    try {
      const entry = execFileSync("git", ["ls-tree", commit, "--", repositoryPath], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
      return /^100(?:644|755) blob [0-9a-f]{40,64}\t[^\n]+$/.test(entry);
    } catch {
      return false;
    }
  };
  for (const commit of commits) {
    if (!isRegularAt(commit)) continue;
    const parents = execFileSync("git", ["show", "-s", "--format=%P", commit], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (parents.every((parent) => !isRegularAt(parent))) origins.push(commit);
  }
  if (origins.length !== 1) {
    throw new Error(`expected one immutable path origin, found ${origins.length}`);
  }
  return origins[0];
}

function gitProjectVersionIssues(root, commit, declaredVersion, label) {
  const issues = [];
  const bytesByPath = new Map();
  for (const repositoryPath of ["VERSION", "package.json", "README.md", "CHANGELOG.md"]) {
    try {
      const entry = execFileSync("git", ["ls-tree", commit, "--", repositoryPath], {
        cwd: root,
        encoding: "utf8",
      }).trim();
      if (!/^100(?:644|755) blob [0-9a-f]{40,64}\t[^\n]+$/.test(entry)) {
        throw new Error("not a regular blob");
      }
      bytesByPath.set(
        repositoryPath,
        execFileSync("git", ["show", `${commit}:${repositoryPath}`], {
          cwd: root,
          maxBuffer: 4 * 1024 * 1024,
        }),
      );
    } catch {
      issues.push(`${label}.${repositoryPath}: subject commit must contain a regular version artifact`);
    }
  }
  if (issues.length > 0) return issues;

  const versionBytes = bytesByPath.get("VERSION").toString("utf8");
  const versionMatch = /^((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))\n$/.exec(
    versionBytes,
  );
  if (!versionMatch) {
    return [`${label}.VERSION: subject commit has noncanonical project-version bytes`];
  }
  const subjectVersion = versionMatch[1];
  if (declaredVersion !== subjectVersion) {
    issues.push(
      `${label}.project_version: declared ${declaredVersion ?? "missing"} does not match subject VERSION ${subjectVersion}`,
    );
  }
  try {
    const packageDocument = parseJsonStrict(bytesByPath.get("package.json").toString("utf8"));
    if (packageDocument.version !== subjectVersion) {
      issues.push(`${label}.package.json: subject package version does not match VERSION`);
    }
  } catch (error) {
    issues.push(`${label}.package.json: subject package version cannot be parsed: ${error.message}`);
  }
  const readmeLines = bytesByPath.get("README.md").toString("utf8").split("\n");
  if (
    readmeLines.filter((line) => line === `Current project version: \`${subjectVersion}\`.`)
      .length !== 1
  ) {
    issues.push(`${label}.README.md: subject README version does not match VERSION`);
  }
  const escapedVersion = subjectVersion.replaceAll(".", "\\.");
  const changelogHeading = new RegExp(
    `^## \\[${escapedVersion}\\] - [0-9]{4}-[0-9]{2}-[0-9]{2}$`,
  );
  if (
    !bytesByPath
      .get("CHANGELOG.md")
      .toString("utf8")
      .split("\n")
      .some((line) => changelogHeading.test(line))
  ) {
    issues.push(`${label}.CHANGELOG.md: subject changelog version does not match VERSION`);
  }
  return issues;
}

function parseYamlStrict(text) {
  const parsed = YAML.parseDocument(text, { uniqueKeys: true });
  if (parsed.errors.length > 0) {
    throw new Error(parsed.errors.map((error) => error.message).join("; "));
  }
  return parsed.toJS({ maxAliasCount: 0 });
}

function gitEvidenceManifestSnapshot(root, commit, gateDocument, label) {
  const issues = [];
  const gateIndex = GATE_INDEX.get(gateDocument.gate);
  const declaredArtifacts = list(gateDocument.feature_evidence?.card_artifacts);
  const declaredByReference = new Map();

  for (const [index, artifact] of declaredArtifacts.entries()) {
    const artifactLabel = `${label}.feature_evidence.card_artifacts.${index}`;
    const referenceIssues = gitRepositoryReferenceIssues(
      root,
      commit,
      [artifact?.reference],
      `${artifactLabel}.reference`,
    );
    issues.push(...referenceIssues);
    if (referenceIssues.length > 0) continue;
    const repositoryPath = artifact.reference.slice("repo:".length);
    let bytes;
    let historical;
    try {
      bytes = execFileSync("git", ["show", `${commit}:${repositoryPath}`], {
        cwd: root,
        maxBuffer: 16 * 1024 * 1024,
      });
      historical = repositoryPath.endsWith(".json")
        ? parseJsonStrict(bytes.toString("utf8"))
        : parseYamlStrict(bytes.toString("utf8"));
    } catch (error) {
      issues.push(`${artifactLabel}: Evidence Card snapshot could not be parsed: ${error.message}`);
      continue;
    }
    if (artifact?.content_digest !== sha256Bytes(bytes)) {
      issues.push(`${artifactLabel}.content_digest: does not match the Evidence Card report-commit bytes`);
    }
    if (historical?.evidence_id !== artifact?.evidence_id) {
      issues.push(`${artifactLabel}.evidence_id: does not match the captured Evidence Card`);
    }
    const expectedPath = `docs/provenance/cards/${historical?.evidence_id}.yaml`;
    if (repositoryPath !== expectedPath) {
      issues.push(`${artifactLabel}.reference: Evidence Card must use stable path ${expectedPath}`);
    }
    for (const validationIssue of validateDocument("evidence", historical)) {
      issues.push(`${artifactLabel}: captured Evidence Card is invalid: ${validationIssue}`);
    }
    if (
      historical?.lifecycle?.goal_scope === "current_goal" &&
      FROZEN_EVIDENCE_STATUSES.includes(historical?.lifecycle?.status)
    ) {
      const expectedGoalReference = `goal://${TRUSTED_GOAL_SOURCE_ID}`;
      const expectedGoalDigest = `sha256:${TRUSTED_GOAL_SOURCE_SHA256}`;
      const goalSources = list(historical.sources).filter(
        (source) => source?.source_type === "goal_specification",
      );
      if (goalSources.length === 0) {
        issues.push(`${artifactLabel}: captured Evidence Card lacks the trusted goal source`);
      }
      for (const source of goalSources) {
        if (
          (source?.reference !== expectedGoalReference &&
            !source?.reference?.startsWith(`${expectedGoalReference}#`)) ||
          source?.content_digest !== expectedGoalDigest ||
          !["frozen", "verified"].includes(source?.verification_status)
        ) {
          issues.push(`${artifactLabel}: captured Evidence Card goal source is not trust-anchor bound`);
        }
      }
    }
    issues.push(
      ...gitRepositoryReferenceIssues(
        root,
        commit,
        [
          ...list(historical.review?.evidence_refs),
          ...list(historical.traceability?.implementation_refs),
          ...list(historical.traceability?.artifact_refs),
        ],
        `${artifactLabel}.acceptance_evidence`,
      ),
    );
    declaredByReference.set(artifact.reference, {
      artifact,
      artifactIndex: index,
      repositoryPath,
      bytes,
      document: historical,
    });
  }

  let historicalPaths = [];
  try {
    historicalPaths = execFileSync(
      "git",
      ["ls-tree", "-r", "--name-only", "-z", commit, "--", "docs/provenance/cards"],
      { cwd: root },
    )
      .toString("utf8")
      .split("\0")
      .filter(Boolean);
  } catch {
    issues.push(`${label}.feature_evidence: report-commit Evidence inventory could not be listed`);
    return { issues, cards: [...declaredByReference.values()], repositoryCards: [] };
  }

  const expected = [];
  const repositoryCards = [];
  for (const repositoryPath of historicalPaths) {
    const referenceIssues = gitRepositoryReferenceIssues(
      root,
      commit,
      [`repo:${repositoryPath}`],
      `${label}.feature_evidence.report_commit_cards.${repositoryPath}`,
    );
    issues.push(...referenceIssues);
    if (referenceIssues.length > 0) continue;
    let bytes;
    let historical;
    try {
      bytes = execFileSync("git", ["show", `${commit}:${repositoryPath}`], {
        cwd: root,
        maxBuffer: 16 * 1024 * 1024,
      });
      historical = repositoryPath.endsWith(".json")
        ? parseJsonStrict(bytes.toString("utf8"))
        : parseYamlStrict(bytes.toString("utf8"));
    } catch {
      issues.push(`${label}.feature_evidence: unparseable report-commit card ${repositoryPath}`);
      continue;
    }
    if (!historical?.evidence_id) continue;
    repositoryCards.push({ repositoryPath, bytes, document: historical });
    if (historical?.lifecycle?.goal_scope !== "current_goal") continue;
    if (historical.lifecycle?.status === "superseded") continue;
    if (GATE_INDEX.get(historical.lifecycle?.first_gate) > gateIndex) continue;
    expected.push({ reference: `repo:${repositoryPath}`, document: historical });
  }

  const expectedReferences = new Set(expected.map((entry) => entry.reference));
  for (const { reference } of expected) {
    if (!declaredByReference.has(reference)) {
      issues.push(`${label}.feature_evidence: missing report-commit Evidence Card ${reference}`);
    }
  }
  for (const reference of declaredByReference.keys()) {
    if (!expectedReferences.has(reference)) {
      issues.push(`${label}.feature_evidence: manifest includes an out-of-scope Evidence Card ${reference}`);
    }
  }

  const documents = expected.map((entry) => entry.document);
  for (const card of documents.filter(
    (candidate) =>
      candidate.classification?.status === "unknown" &&
      GATE_INDEX.get(candidate.unknown_handling?.resolution_gate) <= gateIndex,
  )) {
    issues.push(
      `${label}: report-commit evidence ${card.evidence_id} remained unresolved at ${card.unknown_handling?.resolution_gate}`,
    );
  }
  for (const card of documents.filter(
    (candidate) =>
      candidate.priority === "P0" && candidate.classification?.status === "unknown",
  )) {
    issues.push(`${label}: report-commit P0 evidence ${card.evidence_id} cannot remain unknown`);
  }
  const due = documents.filter(
    (card) => GATE_INDEX.get(card.lifecycle?.acceptance_gate) <= gateIndex,
  );
  const expectedCounts = {
    total: documents.length,
    classified: documents.length,
    frozen_total: documents.filter((card) =>
      ["frozen", "implemented", "verified"].includes(card.lifecycle?.status),
    ).length,
    retained_total: documents.filter((card) => card.classification?.status === "retained").length,
    due_for_acceptance: due.length,
    due_verified: due.filter((card) => card.lifecycle?.status === "verified").length,
    p0_total: documents.filter((card) => card.priority === "P0").length,
    p0_unexplained: documents.filter(
      (card) => card.priority === "P0" && card.classification?.status === "unknown",
    ).length,
  };
  for (const [key, value] of Object.entries(expectedCounts)) {
    if (gateDocument.feature_evidence?.[key] !== value) {
      issues.push(`${label}.feature_evidence.${key}: does not match the report-commit Evidence inventory`);
    }
  }
  return { issues, cards: [...declaredByReference.values()], repositoryCards };
}

function gitGateDeviationApprovalIssues(root, commit, cards, repositoryCards, label) {
  const issues = [];
  const approvals = new Map();
  for (const card of cards) {
    const document = card.document;
    const ownerDecisionSources = list(document.sources).filter(
      (source) => source?.source_type === "owner_decision",
    );
    issues.push(
      ...gitRepositoryContentDigestIssues(
        root,
        commit,
        ownerDecisionSources,
        `${label}.owner_decisions.${document.evidence_id}`,
      ),
    );
    const decisionId = document.governance?.approved_deviation_id;
    if (!decisionId) continue;
    const sourceMatches = list(document.sources).filter(
      (source) =>
        source?.source_id === decisionId && source?.source_type === "owner_decision",
    );
    const cardLabel = `${label}.approved_deviations.${document.evidence_id}`;
    if (sourceMatches.length !== 1) {
      issues.push(`${cardLabel}: captured card needs exactly one matching Owner decision source`);
      continue;
    }
    const source = sourceMatches[0];
    const expectedReference = `repo:docs/governance/decisions/${decisionId}.json`;
    if (
      source.reference !== expectedReference ||
      !["frozen", "verified"].includes(source.verification_status)
    ) {
      issues.push(`${cardLabel}: captured Owner decision source is not a frozen exact-path approval`);
      continue;
    }
    const projection = canonicalJson({
      reference: source.reference,
      content_digest: source.content_digest,
    });
    const existing = approvals.get(decisionId);
    if (existing && existing.projection !== projection) {
      issues.push(`${cardLabel}: captured deviation ${decisionId} resolves inconsistently`);
      continue;
    }
    if (existing) {
      existing.featureIds.add(document.feature_id);
      continue;
    }
    approvals.set(decisionId, {
      projection,
      source,
      featureIds: new Set([document.feature_id]),
    });
  }

  const reportCommitBindings = new Map();
  for (const card of repositoryCards) {
    const document = card.document;
    const decisionId = document.governance?.approved_deviation_id;
    if (!decisionId || !approvals.has(decisionId)) continue;
    const cardLabel = `${label}.approved_deviations.${decisionId}.cards.${document.evidence_id}`;
    const expectedPath = `docs/provenance/cards/${document.evidence_id}.yaml`;
    if (card.repositoryPath !== expectedPath) {
      issues.push(`${cardLabel}: deviation-bound card must use stable path ${expectedPath}`);
    }
    for (const validationIssue of validateDocument("evidence", document)) {
      issues.push(`${cardLabel}: report-commit deviation-bound card is invalid: ${validationIssue}`);
    }
    const matchingSources = list(document.sources).filter(
      (source) => source?.source_id === decisionId && source?.source_type === "owner_decision",
    );
    const expectedReference = `repo:docs/governance/decisions/${decisionId}.json`;
    if (
      matchingSources.length !== 1 ||
      matchingSources[0]?.reference !== expectedReference ||
      !["frozen", "verified"].includes(matchingSources[0]?.verification_status)
    ) {
      issues.push(`${cardLabel}: needs one exact frozen Owner decision source`);
      continue;
    }
    issues.push(
      ...gitRepositoryContentDigestIssues(
        root,
        commit,
        matchingSources,
        `${cardLabel}.owner_decision`,
      ),
    );
    const bindings = reportCommitBindings.get(decisionId) ?? new Set();
    bindings.add(document.feature_id);
    reportCommitBindings.set(decisionId, bindings);
  }

  let reportCommitTime = Number.NaN;
  try {
    reportCommitTime = Number(
      execFileSync("git", ["show", "-s", "--format=%ct", commit], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim(),
    ) * 1000;
  } catch {
    issues.push(`${label}.approved_deviations: report commit timestamp could not be verified`);
  }

  for (const [decisionId, approval] of approvals) {
    const approvalLabel = `${label}.approved_deviations.${decisionId}`;
    const repositoryPath = approval.source.reference.slice("repo:".length);
    let bytes;
    let document;
    try {
      const entry = execFileSync("git", ["ls-tree", commit, "--", repositoryPath], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
      if (!/^100(?:644|755) blob [0-9a-f]{40,64}\t[^\n]+$/.test(entry)) {
        throw new Error("not a regular blob");
      }
      bytes = execFileSync("git", ["show", `${commit}:${repositoryPath}`], {
        cwd: root,
        maxBuffer: 4 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      });
      document = parseJsonStrict(bytes.toString("utf8"));
    } catch (error) {
      issues.push(`${approvalLabel}: approval was not a regular typed file in the report commit: ${error.message}`);
      continue;
    }
    if (approval.source.content_digest !== sha256Bytes(bytes)) {
      issues.push(`${approvalLabel}: source digest does not match report-commit approval bytes`);
    }
    for (const validationIssue of validateDocument("deviation", document)) {
      issues.push(`${approvalLabel}: captured deviation approval is invalid: ${validationIssue}`);
    }
    if (document.decision_id !== decisionId) {
      issues.push(`${approvalLabel}: captured approval decision_id does not match its source`);
    }
    for (const featureId of approval.featureIds) {
      if (!list(document.feature_ids).includes(featureId)) {
        issues.push(`${approvalLabel}: captured approval does not authorize feature ${featureId}`);
      }
    }
    const declaredFeatureIds = new Set(list(document.feature_ids));
    const boundFeatureIds = reportCommitBindings.get(decisionId) ?? new Set();
    if (
      canonicalJson([...declaredFeatureIds].sort()) !==
      canonicalJson([...boundFeatureIds].sort())
    ) {
      issues.push(
        `${approvalLabel}.feature_ids: must exactly match every deviation-bound card in the report commit`,
      );
    }
    issues.push(
      ...gitRepositoryContentDigestIssues(
        root,
        commit,
        [document.scope_binding?.public_summary],
        `${approvalLabel}.scope_binding.public_summary`,
      ),
    );
    if (Number.isFinite(reportCommitTime)) {
      for (const [field, value] of [
        ["recorded_at", document.recorded_at],
        ["lifecycle.frozen_at", document.lifecycle?.frozen_at],
      ]) {
        const timestamp = Date.parse(value ?? "");
        if (Number.isFinite(timestamp) && timestamp > reportCommitTime + VALIDATION_CLOCK_SKEW_MS) {
          issues.push(`${approvalLabel}.${field}: cannot be later than the report commit`);
        }
      }
    }
  }
  return issues;
}

function isCanonicalEvidenceTemplate(document) {
  const zeroDigest = `sha256:${"0".repeat(64)}`;
  return (
    document?.schema_version === "1.1.0" &&
    document?.evidence_id === "EV-TEMPLATE-0001" &&
    document?.feature_id === "FEATURE-TEMPLATE-0001" &&
    document?.classification?.status === "unknown" &&
    document?.classification?.freeze_version === "draft" &&
    list(document?.disposition?.targets).length === 1 &&
    document.disposition.targets[0] === "exclude" &&
    list(document?.sources).every((source) => source?.verification_status === "unknown") &&
    document?.governance?.scope_summary?.reference === TRUSTED_SCOPE_SUMMARY_REFERENCE &&
    document?.governance?.scope_summary?.content_digest === TRUSTED_SCOPE_SUMMARY_DIGEST &&
    document?.governance?.private_scope_record_digest === TRUSTED_PRIVATE_SCOPE_RECORD_DIGEST &&
    document?.governance?.approved_deviation_id === null &&
    document?.review?.status === "pending" &&
    document?.review?.independent_review === false &&
    document?.lifecycle?.status === "draft" &&
    document?.lifecycle?.goal_scope === "current_goal" &&
    document?.lifecycle?.first_gate === "G0" &&
    document?.lifecycle?.acceptance_gate === "G9" &&
    document?.lifecycle?.content_digest === zeroDigest &&
    document?.lifecycle?.supersedes === null
  );
}

function isCanonicalGateTemplate(document) {
  const zeroDigest = `sha256:${"0".repeat(64)}`;
  const oracleSummaries = Object.values(document?.g0_oracles ?? {});
  return (
    document?.report_id === "gate.g0.example" &&
    document?.supersedes_report_id === null &&
    document?.gate === "G0" &&
    document?.release_identity?.source_commit === "0".repeat(40) &&
    document?.feature_evidence?.total === 0 &&
    document?.feature_evidence?.coverage_complete === false &&
    list(document?.feature_evidence?.card_artifacts).length === 0 &&
    oracleSummaries.length === Object.keys(G0_ORACLE_CATEGORIES).length &&
    oracleSummaries.every(
      (summary) =>
        summary?.document_count === 0 &&
        summary?.passed_count === 0 &&
        summary?.frozen_count === 0 &&
        list(summary?.artifact_refs).length === 0,
    ) &&
    Object.values(document?.reviews ?? {}).every((review) => review?.passed === false) &&
    document?.rollback?.verified === false &&
    document?.decision?.outcome === "no-go" &&
    list(document?.decision?.incomplete_items).length > 0 &&
    document?.assertions?.mock_only === true &&
    document?.content_digest === zeroDigest
  );
}

function missingRequiredValues(actualValues, requiredValues, label) {
  const actual = new Set(actualValues);
  return requiredValues
    .filter((required) => !actual.has(required))
    .map((required) => `${label}: missing mandatory G0 coverage ${required}`);
}

function goalSourceFreezeIssues(root, evidenceRecords) {
  const issues = [];
  const relevantEvidence = evidenceRecords.filter(
    (record) =>
      record.document.lifecycle?.goal_scope === "current_goal" &&
      FROZEN_EVIDENCE_STATUSES.includes(record.document.lifecycle?.status),
  );
  if (relevantEvidence.length === 0) return issues;
  const freezePath = join(root, "docs", "governance", "source-freeze.json");
  let freeze;
  try {
    const metadata = lstatSync(freezePath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error("not a regular file");
    freeze = parseJsonStrict(readFileSync(freezePath, "utf8"));
    if (
      typeof freeze?.source_id !== "string" ||
      !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(freeze.source_id) ||
      typeof freeze?.source_sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(freeze.source_sha256) ||
      freeze.source_id !== TRUSTED_GOAL_SOURCE_ID ||
      freeze.source_sha256 !== TRUSTED_GOAL_SOURCE_SHA256 ||
      freeze?.status !== "bootstrap-source-freeze"
    ) {
      throw new Error("invalid source freeze metadata");
    }
  } catch (error) {
    return [`docs/governance/source-freeze.json: trusted goal source freeze is invalid: ${error.message}`];
  }

  try {
    const scopePath = join(root, "docs", "governance", "scope-summary.json");
    const metadata = lstatSync(scopePath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error("scope summary must be a regular non-symlink file");
    }
    const scope = parseJsonStrict(readFileSync(scopePath, "utf8"));
    if (scope?.governing_prompt_sha256 !== TRUSTED_GOAL_SOURCE_SHA256) {
      throw new Error("scope summary does not match the trusted goal digest");
    }
  } catch (error) {
    issues.push(`docs/governance/scope-summary.json: ${error.message}`);
  }

  const expectedReference = `goal://${freeze.source_id}`;
  const expectedDigest = `sha256:${freeze.source_sha256}`;
  for (const record of relevantEvidence) {
    const document = record.document;
    const label = relative(root, record.file);
    const goalSources = list(document.sources).filter(
      (source) => source?.source_type === "goal_specification",
    );
    if (goalSources.length === 0) {
      issues.push(`${label}.sources: frozen current-goal evidence must cite the trusted goal source freeze`);
      continue;
    }
    for (const source of goalSources) {
      const sourceLabel = `${label}.sources.${source?.source_id}`;
      if (
        source?.reference !== expectedReference &&
        !source?.reference?.startsWith(`${expectedReference}#`)
      ) {
        issues.push(`${sourceLabel}.reference: does not match the trusted goal source id`);
      }
      if (source?.content_digest !== expectedDigest) {
        issues.push(`${sourceLabel}.content_digest: does not match the trusted goal source freeze`);
      }
      if (!["frozen", "verified"].includes(source?.verification_status)) {
        issues.push(`${sourceLabel}.verification_status: frozen evidence needs a frozen goal source`);
      }
    }
  }
  return issues;
}

function normalizedDisposition(disposition) {
  return {
    targets: [...list(disposition?.targets)].sort(),
    module_ids: [...list(disposition?.module_ids)].sort(),
    provider_capability_ids: [...list(disposition?.provider_capability_ids)].sort(),
    configuration_keys: [...list(disposition?.configuration_keys)].sort(),
    exclusion_assertion_ids: [...list(disposition?.exclusion_assertion_ids)].sort(),
  };
}

function evidenceInventoryCrossIssues(root, inventoryRecords, evidenceRecords) {
  const issues = [];
  if (inventoryRecords.length > 1) {
    issues.push(
      `${relative(root, inventoryRecords[1].file)}: G0 permits exactly one active Evidence Inventory`,
    );
  }

  const activeCards = evidenceRecords.filter(
    (record) =>
      record.document.lifecycle?.goal_scope === "current_goal" &&
      record.document.lifecycle?.status !== "superseded",
  );
  const inventoryRecord = inventoryRecords[0];
  if (!inventoryRecord) {
    if (activeCards.length > 0) {
      issues.push(
        `${relative(root, activeCards[0].file)}: active current-goal Evidence Cards require one G0 Evidence Inventory`,
      );
    }
    return issues;
  }

  const inventory = inventoryRecord.document;
  const inventoryLabel = relative(root, inventoryRecord.file);
  issues.push(
    ...repositoryContentDigestIssues(
      root,
      [inventory.scope_binding?.public_summary],
      `${inventoryLabel}.scope_binding.public_summary`,
      inventoryRecord.file,
    ),
  );
  if (inventory.review?.status === "passed") {
    issues.push(
      ...repositoryReferenceIssues(
        root,
        inventory.review?.evidence_refs,
        `${inventoryLabel}.review.evidence_refs`,
        true,
      ),
    );
  }

  const cardByEvidenceId = new Map(
    activeCards
      .filter((record) => record.document.evidence_id)
      .map((record) => [record.document.evidence_id, record]),
  );
  const features = list(inventory.features);
  const featureByEvidenceId = new Map(
    features.filter((feature) => feature?.evidence_id).map((feature) => [feature.evidence_id, feature]),
  );

  for (const feature of features) {
    const label = `${inventoryLabel}.features.${feature?.feature_id ?? "unknown"}`;
    const cardRecord = cardByEvidenceId.get(feature?.evidence_id);
    if (!cardRecord) {
      issues.push(`${label}: missing active Evidence Card ${feature?.evidence_id}`);
      continue;
    }
    const card = cardRecord.document;
    if (card.feature_id !== feature.feature_id) {
      issues.push(`${label}: Evidence Card feature_id mismatch`);
    }
    if (card.title !== feature.title) {
      issues.push(`${label}: Evidence Card title mismatch`);
    }
    if (card.priority !== feature.priority) {
      issues.push(`${label}: Evidence Card priority mismatch`);
    }
    if (card.classification?.status !== feature.classification) {
      issues.push(`${label}: Evidence Card classification mismatch`);
    }
    if (
      canonicalJson(normalizedDisposition(card.disposition)) !==
      canonicalJson(normalizedDisposition(feature.disposition))
    ) {
      issues.push(`${label}: Evidence Card disposition mismatch`);
    }
    if (
      card.lifecycle?.first_gate !== feature.first_gate ||
      card.lifecycle?.acceptance_gate !== feature.acceptance_gate
    ) {
      issues.push(`${label}: Evidence Card Gate lifecycle mismatch`);
    }
    const policy = feature.classification_policy ?? {};
    if ((card.governance?.approved_deviation_id ?? null) !== policy.approved_deviation_id) {
      issues.push(`${label}: Evidence Card approved deviation mismatch`);
    }
    if ((card.classification?.fail_safe_behavior ?? null) !== policy.fail_safe_behavior) {
      issues.push(`${label}: Evidence Card fail-safe behavior mismatch`);
    }
    if (
      canonicalJson([...list(card.classification?.negative_test_refs)].sort()) !==
      canonicalJson([...list(policy.negative_test_refs)].sort())
    ) {
      issues.push(`${label}: Evidence Card negative-test policy mismatch`);
    }
    if (
      canonicalJson(card.unknown_handling ?? null) !==
      canonicalJson(policy.unknown_handling ?? null)
    ) {
      issues.push(`${label}: Evidence Card unknown handling mismatch`);
    }
    const goalSources = list(card.sources).filter(
      (source) => source?.source_type === "goal_specification",
    );
    const normalizeGoalAnchor = (entry) => ({
      reference: entry?.reference,
      line_start: entry?.line_start,
      line_end: entry?.line_end,
    });
    const expectedAnchors = list(feature.goal_anchors)
      .map(normalizeGoalAnchor)
      .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
    const actualAnchors = goalSources
      .map(normalizeGoalAnchor)
      .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
    if (canonicalJson(actualAnchors) !== canonicalJson(expectedAnchors)) {
      issues.push(`${label}: Evidence Card goal anchor set mismatch`);
    }
    for (const source of goalSources) {
      if (
        source.content_digest !== `sha256:${TRUSTED_GOAL_SOURCE_SHA256}` ||
        source.authority_rank !== 1 ||
        source.reference !==
          `goal://${TRUSTED_GOAL_SOURCE_ID}#L${source.line_start}-L${source.line_end}` ||
        !["frozen", "verified"].includes(source.verification_status)
      ) {
        issues.push(`${label}: Evidence Card goal source is not trust-anchor frozen`);
      }
    }
  }

  for (const cardRecord of activeCards) {
    const card = cardRecord.document;
    if (!featureByEvidenceId.has(card.evidence_id)) {
      issues.push(
        `${relative(root, cardRecord.file)}: active Evidence Card ${card.evidence_id} is extra to the G0 inventory`,
      );
    }
  }
  return issues;
}

function g0RequiredInventoryIssues(byKind, label) {
  const issues = [];
  const passedStates = byKind("state").filter(
    (record) => record.document.review?.status === "passed",
  );
  const statesByAggregate = new Map(
    passedStates.map((record) => [record.document.aggregate_id, record.document]),
  );
  issues.push(
    ...missingRequiredValues(
      statesByAggregate.keys(),
      REQUIRED_STATE_AGGREGATE_IDS,
      `${label}.g0_inventory.state_transition_tables`,
    ),
  );
  for (const [aggregateId, requiredStates] of Object.entries(REQUIRED_STATES_BY_AGGREGATE)) {
    const actualStates = list(statesByAggregate.get(aggregateId)?.states).map(
      (state) => state?.state_id,
    );
    issues.push(
      ...missingRequiredValues(
        actualStates,
        requiredStates,
        `${label}.g0_inventory.${aggregateId}`,
      ),
    );
  }

  const passedGuards = byKind("guard").filter(
    (record) => record.document.review?.status === "passed",
  );
  issues.push(
    ...missingRequiredValues(
      passedGuards.flatMap((record) =>
        list(record.document.resource_types).map((resource) => resource?.type_id),
      ),
      REQUIRED_GUARD_RESOURCE_IDS,
      `${label}.g0_inventory.guard_resources`,
    ),
    ...missingRequiredValues(
      passedGuards.flatMap((record) =>
        list(record.document.state_combinations).map(
          (combination) => combination?.combination_id,
        ),
      ),
      REQUIRED_GUARD_COMBINATION_IDS,
      `${label}.g0_inventory.guard_state_combinations`,
    ),
  );

  const passedLedgers = byKind("ledger").filter(
    (record) => record.document.review?.status === "passed",
  );
  issues.push(
    ...missingRequiredValues(
      passedLedgers.flatMap((record) =>
        list(record.document.posting_rules).map((rule) => rule?.event_id),
      ),
      REQUIRED_LEDGER_EVENT_IDS,
      `${label}.g0_inventory.ledger_events`,
    ),
    ...missingRequiredValues(
      passedLedgers.flatMap((record) =>
        list(record.document.accounts).map((account) => account?.account_id),
      ),
      REQUIRED_LEDGER_ACCOUNT_IDS,
      `${label}.g0_inventory.ledger_accounts`,
    ),
    ...missingRequiredValues(
      passedLedgers.flatMap((record) =>
        list(record.document.derived_amounts).map((amount) => amount?.amount_id),
      ),
      REQUIRED_LEDGER_AMOUNT_IDS,
      `${label}.g0_inventory.ledger_amounts`,
    ),
    ...missingRequiredValues(
      passedLedgers.flatMap((record) =>
        list(record.document.manual_command_rules).map((command) => command?.command_id),
      ),
      REQUIRED_LEDGER_COMMAND_IDS,
      `${label}.g0_inventory.ledger_manual_commands`,
    ),
  );

  for (const [oracleKind, requiredCoverage] of Object.entries(
    REQUIRED_GENERIC_ORACLE_COVERAGE,
  )) {
    const actualCoverage = byKind("oracle")
      .filter(
        (record) =>
          record.document.review?.status === "passed" &&
          record.document.oracle_kind === oracleKind,
      )
      .flatMap((record) => list(record.document.coverage_ids));
    issues.push(
      ...missingRequiredValues(
        actualCoverage,
        requiredCoverage,
        `${label}.g0_inventory.${oracleKind}`,
      ),
    );
  }
  return issues;
}

export function globalSpecificationIssues(root, records) {
  const issues = [...gitHistoryCompletenessIssues(root)];
  const templatePolicies = new Map([
    [
      resolve(root, "docs/provenance/evidence-card.template.yaml"),
      { kind: "evidence", predicate: isCanonicalEvidenceTemplate },
    ],
    [
      resolve(root, "docs/gates/gate-exit-report.template.yaml"),
      { kind: "gate", predicate: isCanonicalGateTemplate },
    ],
  ]);
  const concrete = [];
  for (const record of records) {
    const policy = templatePolicies.get(resolve(record.file));
    if (!policy) {
      concrete.push(record);
      continue;
    }
    if (record.kind === policy.kind && policy.predicate(record.document)) continue;
    issues.push(
      `${relative(root, record.file)}: canonical template must remain an exact fail-closed ${policy.kind} template; treating it as a concrete record`,
    );
    concrete.push(record);
  }
  const byKind = (kind) => concrete.filter((record) => record.kind === kind);
  const gateRecords = byKind("gate");
  const gateChain = gateReportChainIssues(root, gateRecords);
  issues.push(...gateChain.issues, ...immutableGateReportHistoryIssues(root, gateRecords));
  const activeGateGroups = new Map();
  for (const record of gateChain.activeRecords) {
    const group = activeGateGroups.get(record.document.gate) ?? [];
    group.push(record);
    activeGateGroups.set(record.document.gate, group);
  }
  const authoritativeActiveGateRecords = [];
  for (const [gate, group] of activeGateGroups) {
    if (group.length !== 1) {
      issues.push(
        `${relative(root, group[0].file)}: Gate ${gate} has ${group.length} active report heads; amendments must form one chain`,
      );
    } else {
      authoritativeActiveGateRecords.push(group[0]);
    }
  }
  const goGateRecords = authoritativeActiveGateRecords.filter(
    (record) => record.document.decision?.outcome === "go",
  );
  const goByGate = new Map();
  const gateReportIds = new Map();
  for (const record of gateRecords) {
    const reportId = record.document.report_id;
    if (reportId) {
      const existing = gateReportIds.get(reportId);
      if (existing) {
        issues.push(
          `${relative(root, record.file)}: duplicate Gate report_id ${reportId}; first seen in ${relative(root, existing.file)}`,
        );
      } else {
        gateReportIds.set(reportId, record);
      }
    }
  }
  for (const record of goGateRecords) {
    const gate = record.document.gate;
    const existing = goByGate.get(gate);
    if (existing) {
      issues.push(
        `${relative(root, record.file)}: Gate ${gate} has multiple active go reports; first seen in ${relative(root, existing.file)}`,
      );
    } else {
      goByGate.set(gate, record);
    }
  }
  const validationNow = Date.now();
  for (const record of goGateRecords) {
    for (const risk of list(record.document.security?.accepted_risks)) {
      if (risk?.severity === "high" && Date.parse(risk?.expires_at ?? "") <= validationNow) {
        issues.push(
          `${relative(root, record.file)}.security.${risk?.risk_id}: active high-risk acceptance has expired at validation time`,
        );
      }
    }
  }
  for (const [gate, record] of goByGate) {
    const gateIndex = GATE_INDEX.get(gate);
    for (let index = 0; index < gateIndex; index += 1) {
      const predecessor = `G${index}`;
      if (!goByGate.has(predecessor)) {
        issues.push(`${relative(root, record.file)}: Gate ${gate} go is missing predecessor ${predecessor} go`);
      }
    }
  }
  const registries = {
    evidence: new Map(),
    deviation: new Map(),
    aggregate: new Map(),
    command: new Map(),
    transition: new Map(),
    actor: new Map(),
    permission: new Map(),
    guard: new Map(),
    ledgerVector: new Map(),
    oracle: new Map(),
    test: new Map(),
  };
  const add = (registry, id, file) => {
    if (!id) return;
    if (registry.has(id)) {
      issues.push(`${relative(root, file)}: globally duplicate id ${id}; first seen in ${relative(root, registry.get(id))}`);
    } else {
      registry.set(id, file);
    }
  };
  const addTests = (ids, file) =>
    list(ids).forEach((id) => {
      if (id && !registries.test.has(id)) registries.test.set(id, file);
    });

  const evidenceRecords = byKind("evidence");
  const inventoryRecords = byKind("inventory");
  const deviationRecords = byKind("deviation");
  for (const record of evidenceRecords) add(registries.evidence, record.document.evidence_id, record.file);
  for (const record of deviationRecords) {
    add(registries.deviation, record.document.decision_id, record.file);
    issues.push(
      ...repositoryContentDigestIssues(
        root,
        [record.document.scope_binding?.public_summary],
        `${relative(root, record.file)}.scope_binding.public_summary`,
        record.file,
      ),
    );
  }
  issues.push(...immutableDeviationHistoryIssues(root, deviationRecords));
  const supersessionIssues = evidenceSupersessionIssues(root, evidenceRecords);
  issues.push(...supersessionIssues);
  for (const record of evidenceRecords) {
    issues.push(...frozenEvidenceHistoryIssues(root, record));
  }
  for (const record of inventoryRecords) {
    issues.push(...frozenInventoryHistoryIssues(root, record));
  }
  issues.push(...frozenEvidenceInventoryIssues(root, evidenceRecords));
  issues.push(...frozenInventorySetIssues(root, inventoryRecords));
  issues.push(...goalSourceFreezeIssues(root, evidenceRecords));
  issues.push(...evidenceInventoryCrossIssues(root, inventoryRecords, evidenceRecords));
  const deviationDecisions = new Map();
  const deviationById = new Map(
    deviationRecords
      .filter((record) => record.document.decision_id)
      .map((record) => [record.document.decision_id, record]),
  );
  const deviationFeatureBindings = new Map();
  for (const record of evidenceRecords) {
    const approvedDeviationId = record.document.governance?.approved_deviation_id;
    const approvedDeviationSources = list(record.document.sources).filter(
      (source) =>
        approvedDeviationId &&
        source?.source_id === approvedDeviationId &&
        source?.source_type === "owner_decision",
    );
    for (const source of approvedDeviationSources) {
      const projection = canonicalJson({
        reference: source?.reference,
        content_digest: source?.content_digest,
      });
      const existing = deviationDecisions.get(approvedDeviationId);
      if (existing && existing.projection !== projection) {
        issues.push(
          `${relative(root, record.file)}.governance.approved_deviation: ${approvedDeviationId} resolves inconsistently with ${existing.label}`,
        );
      } else if (!existing) {
        deviationDecisions.set(approvedDeviationId, {
          projection,
          label: relative(root, record.file),
        });
      }
    }
    if (approvedDeviationId) {
      const decisionRecord = deviationById.get(approvedDeviationId);
      const expectedReference = `repo:docs/governance/decisions/${approvedDeviationId}.json`;
      if (approvedDeviationSources.length !== 1) {
        issues.push(
          `${relative(root, record.file)}.governance.approved_deviation: needs exactly one matching owner decision source`,
        );
      }
      if (!decisionRecord) {
        issues.push(
          `${relative(root, record.file)}.governance.approved_deviation: missing typed approval record ${approvedDeviationId}`,
        );
      } else {
        const decision = decisionRecord.document;
        if (
          decision.decision_kind !== "scope_deviation" ||
          decision.outcome !== "approved" ||
          decision.owner_role !== "project_owner" ||
          decision.authorization_basis !== "explicit_goal_owner_decision" ||
          decision.lifecycle?.status !== "frozen"
        ) {
          issues.push(
            `${relative(root, record.file)}.governance.approved_deviation: ${approvedDeviationId} is not a frozen Owner approval`,
          );
        }
        if (!list(decision.feature_ids).includes(record.document.feature_id)) {
          issues.push(
            `${relative(root, record.file)}.governance.approved_deviation: ${approvedDeviationId} does not authorize feature ${record.document.feature_id}`,
          );
        }
        const bound = deviationFeatureBindings.get(approvedDeviationId) ?? new Set();
        bound.add(record.document.feature_id);
        deviationFeatureBindings.set(approvedDeviationId, bound);
      }
      if (approvedDeviationSources[0]?.reference !== expectedReference) {
        issues.push(
          `${relative(root, record.file)}.governance.approved_deviation: source must reference ${expectedReference}`,
        );
      }
    }
    issues.push(
      ...repositoryContentDigestIssues(
        root,
        [record.document.governance?.scope_summary],
        `${relative(root, record.file)}.governance.scope_summary`,
        record.file,
      ),
      ...repositoryContentDigestIssues(
        root,
        approvedDeviationSources,
        `${relative(root, record.file)}.governance.approved_deviation`,
        record.file,
      ),
    );
  }
  for (const record of deviationRecords) {
    const decisionId = record.document.decision_id;
    const declaredFeatures = new Set(list(record.document.feature_ids));
    const boundFeatures = deviationFeatureBindings.get(decisionId) ?? new Set();
    for (const featureId of declaredFeatures) {
      if (!boundFeatures.has(featureId)) {
        issues.push(
          `${relative(root, record.file)}.feature_ids: ${featureId} has no Evidence Card bound to ${decisionId}`,
        );
      }
    }
    for (const featureId of boundFeatures) {
      if (!declaredFeatures.has(featureId)) {
        issues.push(
          `${relative(root, record.file)}.feature_ids: missing bound feature ${featureId}`,
        );
      }
    }
  }
  for (const record of concrete) {
    if (record.document.review?.status !== "passed") continue;
    const artifacts = record.document.review.evidence_refs ?? record.document.review.artifact_refs;
    issues.push(
      ...repositoryReferenceIssues(
        root,
        artifacts,
        `${relative(root, record.file)}.review.evidence_refs`,
        true,
      ),
    );
  }
  for (const record of byKind("state")) {
    const document = record.document;
    add(registries.aggregate, document.aggregate_id, record.file);
    list(document.commands).forEach((entry) => add(registries.command, entry?.command_id, record.file));
    list(document.transitions).forEach((entry) => {
      add(registries.transition, entry?.transition_id, record.file);
      addTests(entry?.test_ids, record.file);
    });
    list(document.illegal_transitions).forEach((entry) => addTests(entry?.test_ids, record.file));
    list(document.invariants).forEach((entry) => addTests(entry?.test_ids, record.file));
    addTests(document.concurrency?.test_ids, record.file);
  }
  for (const record of byKind("guard")) {
    const document = record.document;
    list(document.actor_types).forEach((entry) => add(registries.actor, entry?.type_id, record.file));
    list(document.permissions).forEach((entry) => add(registries.permission, entry?.permission_id, record.file));
    list(document.guards).forEach((entry) => {
      add(registries.guard, entry?.guard_id, record.file);
      addTests(entry?.positive_test_ids, record.file);
      addTests(entry?.negative_test_ids, record.file);
    });
    list(document.matrix).forEach((entry) => addTests(entry?.test_ids, record.file));
    list(document.state_combinations).forEach((entry) => addTests(entry?.test_ids, record.file));
    list(document.high_risk_actions).forEach((entry) => addTests(entry?.test_ids, record.file));
  }
  for (const record of byKind("ledger")) {
    const document = record.document;
    list(document.posting_rules).forEach((entry) => addTests(entry?.test_ids, record.file));
    list(document.manual_command_rules).forEach((entry) => addTests(entry?.test_ids, record.file));
    list(document.invariants).forEach((entry) => addTests(entry?.property_test_ids, record.file));
    list(document.concurrency_controls).forEach((entry) => addTests(entry?.test_ids, record.file));
    list(document.golden_vector_refs).forEach((entry) => {
      add(registries.ledgerVector, entry?.vector_id, record.file);
      addTests(entry?.property_test_ids, record.file);
    });
  }
  for (const record of byKind("oracle")) {
    add(registries.oracle, record.document.oracle_id, record.file);
  }

  const close = (values, registry, label) =>
    missingRefIssues(values, new Set(registry.keys()), label);

  for (const record of byKind("state")) {
    const document = record.document;
    if (document.review?.status !== "passed") continue;
    const label = relative(root, record.file);
    issues.push(...close(document.source_evidence_ids, registries.evidence, `${label}.source_evidence_ids`));
    for (const command of list(document.commands)) {
      issues.push(...close(command?.actor_types, registries.actor, `${label}.${command?.command_id}.actor_types`));
      issues.push(...close(command?.permission_ids, registries.permission, `${label}.${command?.command_id}.permission_ids`));
    }
    for (const transition of list(document.transitions)) {
      issues.push(...close(transition?.guard_ids, registries.guard, `${label}.${transition?.transition_id}.guard_ids`));
      issues.push(...close(transition?.permission_ids, registries.permission, `${label}.${transition?.transition_id}.permission_ids`));
      issues.push(...close(transition?.evidence_ids, registries.evidence, `${label}.${transition?.transition_id}.evidence_ids`));
    }
  }

  for (const record of byKind("guard")) {
    const document = record.document;
    if (document.review?.status !== "passed") continue;
    const label = relative(root, record.file);
    issues.push(...close(document.source_evidence_ids, registries.evidence, `${label}.source_evidence_ids`));
    for (const guard of list(document.guards)) {
      issues.push(...close(guard?.evidence_ids, registries.evidence, `${label}.${guard?.guard_id}.evidence_ids`));
    }
  }

  for (const record of byKind("ledger")) {
    const document = record.document;
    if (document.review?.status !== "passed") continue;
    const label = relative(root, record.file);
    issues.push(...trustedLedgerRunnerIssues(root, record));
    issues.push(...close(document.source_evidence_ids, registries.evidence, `${label}.source_evidence_ids`));
    for (const rule of list(document.posting_rules)) {
      issues.push(...close(rule?.evidence_ids, registries.evidence, `${label}.${rule?.posting_rule_id}.evidence_ids`));
    }
    for (const rule of list(document.manual_command_rules)) {
      issues.push(...close([rule?.command_id], registries.command, `${label}.${rule?.command_id}.command_id`));
    }
    for (const vector of list(document.golden_vector_refs)) {
      issues.push(
        ...repositoryContentDigestIssues(
          root,
          [
            {
              reference: vector?.input_fixture_ref,
              content_digest: vector?.input_fixture_digest,
            },
            {
              reference: vector?.expected_postings_ref,
              content_digest: vector?.expected_postings_digest,
            },
          ],
          `${label}.${vector?.vector_id}`,
          record.file,
        ),
      );
    }
  }

  for (const record of byKind("oracle")) {
    const document = record.document;
    if (document.review?.status !== "passed") continue;
    const label = relative(root, record.file);
    const oraclePolicy = G0_ORACLE_CATEGORIES[document.oracle_kind];
    for (const artifact of list(document.normative_artifacts)) {
      if (
        oraclePolicy &&
        !artifact?.reference?.startsWith(`repo:${oraclePolicy.pathPrefix}`)
      ) {
        issues.push(
          `${label}.normative_artifacts: ${document.oracle_kind} artifact must use ${oraclePolicy.pathPrefix}`,
        );
      }
    }
    issues.push(...close(document.source_evidence_ids, registries.evidence, `${label}.source_evidence_ids`));
    issues.push(
      ...repositoryContentDigestIssues(
        root,
        document.normative_artifacts,
        `${label}.normative_artifacts`,
        record.file,
      ),
      ...repositoryReferenceIssues(
        root,
        document.review?.evidence_refs,
        `${label}.review.evidence_refs`,
        true,
      ),
    );
  }

  for (const record of byKind("evidence")) {
    const document = record.document;
    const label = relative(root, record.file);
    if (document.lifecycle?.goal_scope === "post_goal") {
      issues.push(
        ...repositoryReferenceIssues(
          root,
          document.review?.evidence_refs,
          `${label}.review.evidence_refs`,
          true,
        ),
      );
    }
    if (document.lifecycle?.status !== "verified") continue;
    const traceability = document.traceability ?? {};
    issues.push(...close(traceability.aggregate_ids, registries.aggregate, `${label}.aggregate_ids`));
    issues.push(...close(traceability.command_ids, registries.command, `${label}.command_ids`));
    issues.push(...close(traceability.state_transition_ids, registries.transition, `${label}.state_transition_ids`));
    issues.push(...close(traceability.guard_ids, registries.guard, `${label}.guard_ids`));
    issues.push(...close(traceability.permission_ids, registries.permission, `${label}.permission_ids`));
    issues.push(...close(traceability.ledger_vector_ids, registries.ledgerVector, `${label}.ledger_vector_ids`));
    issues.push(...close(traceability.test_refs, registries.test, `${label}.test_refs`));
    issues.push(
      ...repositoryReferenceIssues(root, traceability.implementation_refs, `${label}.implementation_refs`, true),
      ...repositoryReferenceIssues(root, traceability.artifact_refs, `${label}.artifact_refs`, true),
      ...repositoryReferenceIssues(root, document.review?.evidence_refs, `${label}.review.evidence_refs`, true),
    );
  }

  const evidenceDocuments = evidenceRecords
    .map((record) => record.document)
    .filter(
      (card) =>
        card.lifecycle?.goal_scope === "current_goal" &&
        (card.lifecycle?.status !== "superseded" || supersessionIssues.length > 0),
    );
  const gateGitBindings = new Map();
  for (const record of goGateRecords) {
    const document = record.document;
    const label = relative(root, record.file);
    const reportMetadata = existsSync(record.file) ? lstatSync(record.file) : null;
    const reportIsRegular = Boolean(
      reportMetadata && !reportMetadata.isSymbolicLink() && reportMetadata.isFile(),
    );
    if (!reportIsRegular) {
      issues.push(`${label}: Gate report must be a regular non-symlink repository file`);
    }
    const gateIndex = GATE_INDEX.get(document.gate);
    const gateEvidence = evidenceDocuments.filter(
      (card) => GATE_INDEX.get(card.lifecycle?.first_gate) <= gateIndex,
    );
    const dueEvidence = gateEvidence.filter(
      (card) => GATE_INDEX.get(card.lifecycle?.acceptance_gate) <= gateIndex,
    );
    for (const card of gateEvidence.filter(
      (candidate) =>
        candidate.classification?.status === "unknown" &&
        GATE_INDEX.get(candidate.unknown_handling?.resolution_gate) <= gateIndex,
    )) {
      issues.push(
        `${label}: unresolved evidence ${card.evidence_id} passed its resolution Gate ${card.unknown_handling?.resolution_gate}`,
      );
    }
    for (const card of gateEvidence.filter(
      (candidate) =>
        candidate.priority === "P0" && candidate.classification?.status === "unknown",
    )) {
      issues.push(`${label}: P0 evidence ${card.evidence_id} cannot remain unknown at a go Gate`);
    }
    const expectedCounts = {
      total: gateEvidence.length,
      classified: gateEvidence.length,
      frozen_total: gateEvidence.filter((card) =>
        ["frozen", "implemented", "verified"].includes(card.lifecycle?.status),
      ).length,
      retained_total: gateEvidence.filter((card) => card.classification?.status === "retained").length,
      due_for_acceptance: dueEvidence.length,
      due_verified: dueEvidence.filter((card) => card.lifecycle?.status === "verified").length,
      p0_total: gateEvidence.filter((card) => card.priority === "P0").length,
      p0_unexplained: gateEvidence.filter(
        (card) => card.priority === "P0" && card.classification?.status === "unknown",
      ).length,
    };
    for (const [key, value] of Object.entries(expectedCounts)) {
      if (document.feature_evidence?.[key] !== value) {
        issues.push(`${label}.feature_evidence.${key}: declared count does not match evidence cards`);
      }
    }
    if (document.gate === "G0") {
      issues.push(...g0RequiredInventoryIssues(byKind, label));
      for (const [category, policy] of Object.entries(G0_ORACLE_CATEGORIES)) {
        if (!policy.recordKind) continue;
        const oracleRecords = byKind(policy.recordKind).filter(
          (oracleRecord) =>
            !policy.oracleKind || oracleRecord.document.oracle_kind === policy.oracleKind,
        );
        const passedRecords = oracleRecords.filter(
          (oracleRecord) => oracleRecord.document.review?.status === "passed",
        );
        const frozenRecords =
          policy.recordKind === "inventory"
            ? passedRecords.filter(
                (oracleRecord) => oracleRecord.document.lifecycle?.status === "frozen",
              )
            : passedRecords;
        const declared = document.g0_oracles?.[category] ?? {};
        if (declared.document_count !== oracleRecords.length) {
          issues.push(
            `${label}.g0_oracles.${category}.document_count: declared count does not match schema-backed documents`,
          );
        }
        if (
          declared.passed_count !== passedRecords.length ||
          declared.frozen_count !== frozenRecords.length
        ) {
          issues.push(
            `${label}.g0_oracles.${category}: passed/frozen counts do not match independently reviewed documents`,
          );
        }
        const declaredArtifacts = new Set(list(declared.artifact_refs));
        for (const oracleRecord of oracleRecords) {
          const requiredReference = `repo:${relative(root, oracleRecord.file)}`;
          if (!declaredArtifacts.has(requiredReference)) {
            issues.push(
              `${label}.g0_oracles.${category}: missing schema-backed oracle artifact ${requiredReference}`,
            );
          }
        }
      }
      const inventoryRecord = byKind("inventory")[0];
      if (inventoryRecord) {
        const expectedInventoryReference = `repo:${relative(root, inventoryRecord.file)}`;
        if (document.feature_evidence?.matrix_artifact !== expectedInventoryReference) {
          issues.push(
            `${label}.feature_evidence.matrix_artifact: G0 must bind the active Evidence Inventory`,
          );
        }
        if (
          inventoryRecord.document.classification_counts?.total_features !==
            expectedCounts.total ||
          inventoryRecord.document.classification_counts?.retained !==
            expectedCounts.retained_total ||
          inventoryRecord.document.priority_counts?.P0 !== expectedCounts.p0_total
        ) {
          issues.push(`${label}.feature_evidence: Gate counts do not match the Evidence Inventory`);
        }
      }
    }
    const gateReferenceSets = [
      [
        list(document.feature_evidence?.card_artifacts).map((artifact) => artifact?.reference),
        `${label}.feature_evidence.card_artifacts`,
      ],
      [[document.feature_evidence?.matrix_artifact], `${label}.matrix_artifact`],
      [document.verification?.artifact_refs, `${label}.verification.artifacts`],
      [
        list(document.verification?.commands).flatMap((command) => list(command?.artifact_refs)),
        `${label}.verification.commands`,
      ],
      [
        Object.values(document.reviews ?? {}).map((review) => review?.artifact_ref),
        `${label}.reviews`,
      ],
      [[document.rollback?.procedure_ref], `${label}.rollback`],
      [
        list(document.security?.accepted_risks).map((risk) => risk?.artifact_ref).filter(Boolean),
        `${label}.accepted_risks`,
      ],
    ];
    if (document.gate === "G0") {
      gateReferenceSets.push([
        Object.values(document.g0_oracles ?? {}).flatMap((oracle) =>
          list(oracle?.artifact_refs),
        ),
        `${label}.g0_oracles`,
      ]);
      gateReferenceSets.push([
        ["inventory", "state", "guard", "ledger"].flatMap((kind) =>
          byKind(kind).flatMap((oracleRecord) =>
            list(
              oracleRecord.document.review?.artifact_refs ??
                oracleRecord.document.review?.evidence_refs,
            ),
          ),
        ),
        `${label}.g0_oracle_reviews`,
      ]);
      gateReferenceSets.push([
        [
          "repo:tools/run-ledger-golden-vectors.mjs",
          ...byKind("ledger").flatMap((ledgerRecord) => [
            ledgerRecord.document.golden_runner?.attestation?.reference,
            ...list(ledgerRecord.document.golden_vector_refs).flatMap((vector) => [
              vector?.input_fixture_ref,
              vector?.expected_postings_ref,
            ]),
          ]),
        ],
        `${label}.g0_ledger_evidence`,
      ]);
      gateReferenceSets.push([
        byKind("oracle").flatMap((oracleRecord) => [
          ...list(oracleRecord.document.normative_artifacts).map(
            (artifact) => artifact?.reference,
          ),
          ...list(oracleRecord.document.review?.evidence_refs),
        ]),
        `${label}.g0_oracle_nested_evidence`,
      ]);
    }
    if (!existsSync(join(root, ".git"))) {
      issues.push(`${label}.release_identity.source_commit: Git binding cannot be verified`);
    } else if (!reportIsRegular) {
      // The explicit regular-file issue above is already fail-closed. Never follow a symlink here.
    } else {
      try {
        const reportCommit = gitPathOriginCommit(root, relative(root, record.file));
        const snapshotIssues = gitDocumentSnapshotIssues(
          root,
          reportCommit,
          record.file,
          `${label}.release_identity.source_commit`,
        );
        issues.push(...snapshotIssues);
        if (snapshotIssues.length > 0) throw new Error("report snapshot mismatch");
        const evidenceManifest = gitEvidenceManifestSnapshot(
          root,
          reportCommit,
          document,
          label,
        );
        issues.push(
          ...evidenceManifest.issues,
          ...gitGateDeviationApprovalIssues(
            root,
            reportCommit,
            evidenceManifest.cards,
            evidenceManifest.repositoryCards,
            label,
          ),
        );
        const parentFields = execFileSync("git", ["rev-list", "--parents", "-n", "1", reportCommit], {
          cwd: root,
          encoding: "utf8",
        })
          .trim()
          .split(/\s+/);
        if (parentFields.length !== 2) throw new Error("report commit must have exactly one parent");
        const subjectCommit = parentFields[1];
        if (subjectCommit !== document.release_identity?.source_commit) throw new Error("parent mismatch");
        issues.push(
          ...gitProjectVersionIssues(
            root,
            subjectCommit,
            document.release_identity?.project_version,
            `${label}.release_identity`,
          ),
        );
        const changedFiles = execFileSync(
          "git",
          ["diff", "--name-only", subjectCommit, reportCommit, "--"],
          { cwd: root, encoding: "utf8" },
        )
          .split("\n")
          .filter(Boolean);
        if (
          changedFiles.some(
            (path) => !path.startsWith("docs/gates/") && !path.startsWith("docs/reviews/"),
          )
        ) {
          throw new Error("report commit contains subject changes");
        }
        for (const [references, referenceLabel] of gateReferenceSets) {
          issues.push(
            ...gitRepositoryReferenceIssues(root, reportCommit, references, referenceLabel),
          );
        }
        if (document.gate === "G0") {
          for (const oracleRecord of ["inventory", "state", "guard", "ledger", "oracle"].flatMap(
            (kind) => byKind(kind),
          )) {
            const oracleSnapshotIssues = gitDocumentSnapshotIssues(
              root,
              reportCommit,
              oracleRecord.file,
              `${label}.g0_oracles.${relative(root, oracleRecord.file)}`,
            );
            issues.push(...oracleSnapshotIssues);
          }
          for (const oracleRecord of byKind("oracle")) {
            issues.push(
              ...gitRepositoryContentDigestIssues(
                root,
                reportCommit,
                oracleRecord.document.normative_artifacts,
                `${label}.g0_oracle_artifacts.${oracleRecord.document.oracle_id}`,
              ),
            );
          }
          for (const inventoryRecord of byKind("inventory")) {
            issues.push(
              ...gitRepositoryContentDigestIssues(
                root,
                reportCommit,
                [inventoryRecord.document.scope_binding?.public_summary],
                `${label}.g0_inventory_scope.${inventoryRecord.document.inventory_id}`,
              ),
            );
          }
          for (const ledgerRecord of byKind("ledger")) {
            issues.push(
              ...gitRepositoryContentDigestIssues(
                root,
                reportCommit,
                [
                  ledgerRecord.document.golden_runner?.executable,
                  ledgerRecord.document.golden_runner?.attestation,
                ],
                `${label}.g0_ledger_artifacts.${ledgerRecord.document.matrix_id}`,
              ),
            );
            for (const vector of list(ledgerRecord.document.golden_vector_refs)) {
              issues.push(
                ...gitRepositoryContentDigestIssues(
                  root,
                  reportCommit,
                  [
                    {
                      reference: vector?.input_fixture_ref,
                      content_digest: vector?.input_fixture_digest,
                    },
                    {
                      reference: vector?.expected_postings_ref,
                      content_digest: vector?.expected_postings_digest,
                    },
                  ],
                  `${label}.g0_ledger_vectors.${vector?.vector_id}`,
                ),
              );
            }
          }
        }
        if (!gateGitBindings.has(document.gate)) {
          gateGitBindings.set(document.gate, { reportCommit, subjectCommit, label });
        }
      } catch {
        issues.push(
          `${label}.release_identity.source_commit: report must be in a dedicated evidence commit whose parent is the subject commit`,
        );
      }
    }
  }
  for (let index = 1; index <= 9; index += 1) {
    const predecessor = gateGitBindings.get(`G${index - 1}`);
    const current = gateGitBindings.get(`G${index}`);
    if (!predecessor || !current) continue;
    try {
      execFileSync(
        "git",
        ["merge-base", "--is-ancestor", predecessor.reportCommit, current.subjectCommit],
        { cwd: root, stdio: "ignore" },
      );
    } catch {
      issues.push(
        `${current.label}.release_identity.source_commit: Gate G${index} subject must descend from the G${index - 1} report commit`,
      );
    }
  }
  return issues;
}

export function validateRepository(root = DEFAULT_ROOT) {
  let validators;
  try {
    validators = loadSchemas(root);
  } catch (error) {
    return [`schema load error: ${error.message}`];
  }
  const issues = [...validateGitHubPolicy(root)];
  const records = [];
  const schemaPaths = new Set(Object.values(SCHEMA_FILES).map((file) => resolve(root, file)));
  for (const file of walk(join(root, "docs"))) {
    if (schemaPaths.has(resolve(file)) || ![".json", ".yaml", ".yml"].includes(extname(file))) continue;
    const metadata = lstatSync(file);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      issues.push(`${relative(root, file)}: normative document must be a regular non-symlink file`);
      continue;
    }
    let document;
    try {
      document = parseDocument(file);
    } catch (error) {
      issues.push(`${relative(root, file)}: parse error: ${error.message}`);
      continue;
    }
    const kind = inferKind(file, document);
    if (!kind) {
      const repositoryPath = relative(root, file);
      if (
        [
          "docs/provenance/",
          "docs/specifications/",
          "docs/gates/",
          "docs/governance/decisions/",
        ].some((prefix) =>
          repositoryPath.startsWith(prefix),
        )
      ) {
        issues.push(`${repositoryPath}: unrecognized normative document`);
      }
      continue;
    }
    records.push({ kind, document, file });
    for (const issue of validateDocument(kind, document, validators)) {
      issues.push(`${relative(root, file)}: ${issue}`);
    }
  }
  issues.push(...globalSpecificationIssues(root, records));
  return issues;
}

function main() {
  const root = process.argv[2] ? resolve(process.argv[2]) : DEFAULT_ROOT;
  const issues = validateRepository(root);
  if (issues.length > 0) {
    console.error(issues.map((issue) => `ERROR ${issue}`).join("\n"));
    process.exitCode = 1;
    return;
  }
  console.log(`Validated ${Object.keys(SCHEMA_FILES).length} schemas and all recognized specification documents.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
