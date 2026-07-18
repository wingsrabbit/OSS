// SPDX-License-Identifier: AGPL-3.0-or-later
// NOT FOR PRODUCTION — MOCK PROVIDERS ONLY

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import YAML from "yaml";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(HERE, "..");

const SCHEMA_FILES = Object.freeze({
  evidence: "docs/provenance/evidence-card.schema.json",
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
const TRUSTED_WORKFLOW_RUNNERS = new Set(["ubuntu-24.04", "windows-2025", "macos-15"]);
const EXPECTED_BOOTSTRAP_WORKFLOW_DIGEST =
  "sha256:9397a19b2445d86115f63980d65adfad93b46074b39b18fd094fe862fa6357af";
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
  unknown: new Set(["unknown", "frozen", "verified"]),
  not_authorized_to_verify: new Set(["not_authorized_to_verify", "frozen", "verified"]),
  frozen: new Set(["frozen", "verified"]),
  verified: new Set(["verified"]),
});
const G0_ORACLE_CATEGORIES = Object.freeze({
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
  if (review?.status !== "passed") return [];
  const issues = [];
  if (review.independent_review !== true) {
    issues.push(`${label}: passed review must be independent`);
  }
  if (list(review.reviewer_roles).includes(review.author_role)) {
    issues.push(`${label}: author role cannot also be a reviewer role`);
  }
  if (list(review.reproduction_commands).length === 0) {
    issues.push(`${label}: passed review needs a reproduction command`);
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
    if (!document.classification?.approved_deviation_id) {
      issues.push("evidence.lifecycle: post-goal evidence needs an approved deviation id");
    }
    if (
      !list(document.sources).some(
        (source) =>
          source?.source_type === "owner_decision" &&
          ["frozen", "verified"].includes(source?.verification_status),
      )
    ) {
      issues.push("evidence.lifecycle: post-goal evidence needs a frozen owner decision source");
    }
  }
  if (status === "unknown") {
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
  }
  const scenarios = Object.values(document.scenarios ?? {}).flatMap(list);
  issues.push(...duplicateIdIssues(scenarios, "scenario_id", "evidence.scenarios"));
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
    const schema = parseJsonStrict(readFileSync(join(root, file), "utf8"));
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
    document.version !== "0.0.0" ||
    document.private !== true ||
    document.license !== "AGPL-3.0-or-later" ||
    document.type !== "module" ||
    document.packageManager !== EXPECTED_PACKAGE_MANAGER ||
    canonicalJson(document.engines) !== canonicalJson({ node: "24.18.0" })
  ) {
    issues.push(`${label}: bootstrap identity, runtime, and package-manager pins must remain exact`);
  }
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
  return {
    evidence_id: document.evidence_id,
    feature_id: document.feature_id,
    title: document.title,
    priority: document.priority,
    business_description: document.business_description,
    sources: list(document.sources).map(({ verification_status, observed_at, ...source }) => source),
    classification: document.classification,
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
    lifecycle: {
      goal_scope: document.lifecycle?.goal_scope,
      first_gate: document.lifecycle?.first_gate,
      acceptance_gate: document.lifecycle?.acceptance_gate,
      supersedes: document.lifecycle?.supersedes,
    },
  };
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
  if (label !== expectedPath) {
    issues.push(`${label}: frozen evidence must use stable path ${expectedPath}`);
    return issues;
  }
  if (!existsSync(join(root, ".git"))) {
    issues.push(`${label}: frozen evidence history cannot be verified without Git`);
    return issues;
  }
  try {
    const commits = execFileSync(
      "git",
      ["log", "--format=%H", "--reverse", "--", label],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    )
      .split("\n")
      .filter(Boolean);
    let firstFrozen;
    let lifecycleDowngrade = false;
    const highLifecycleHistory = [];
    for (const commit of commits) {
      let historical;
      try {
        const content = execFileSync("git", ["show", `${commit}:${label}`], {
          cwd: root,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
        historical = extname(label) === ".json" ? parseJsonStrict(content) : YAML.parse(content);
      } catch {
        if (firstFrozen) lifecycleDowngrade = true;
        continue;
      }
      if (FROZEN_EVIDENCE_STATUSES.includes(historical?.lifecycle?.status)) {
        firstFrozen ??= historical;
        highLifecycleHistory.push(historical);
      } else if (firstFrozen) {
        lifecycleDowngrade = true;
      }
    }
    if (!firstFrozen) {
      issues.push(`${label}: frozen evidence has no committed first-freeze snapshot`);
    } else {
      if (lifecycleDowngrade) {
        issues.push(`${label}: frozen evidence history contains a deletion or draft downgrade`);
      }
      if (
        highLifecycleHistory.some(
          (snapshot) =>
            canonicalJson(frozenEvidenceProjection(snapshot)) !==
            canonicalJson(frozenEvidenceProjection(firstFrozen)),
        )
      ) {
        issues.push(
          `${label}: frozen evidence history contains an in-place decision rewrite`,
        );
      }
      const snapshots = [...highLifecycleHistory, document];
      for (let index = 1; index < snapshots.length; index += 1) {
        const previous = snapshots[index - 1];
        const current = snapshots[index];
        const previousLifecycle = previous.lifecycle?.status;
        const currentLifecycle = current.lifecycle?.status;
        if (!EVIDENCE_LIFECYCLE_TRANSITIONS[previousLifecycle]?.has(currentLifecycle)) {
          issues.push(
            `${label}: frozen evidence lifecycle cannot regress from ${previousLifecycle} to ${currentLifecycle}`,
          );
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
              `${label}: source ${previousSource?.source_id} verification cannot regress from ${previousSource?.verification_status} to ${currentSource?.verification_status}`,
            );
          }
        }
      }
      if (firstFrozen.evidence_id !== document.evidence_id) {
        issues.push(`${label}: stable evidence path was previously frozen for another evidence id`);
      } else if (
        canonicalJson(frozenEvidenceProjection(firstFrozen)) !==
        canonicalJson(frozenEvidenceProjection(document))
      ) {
        issues.push(
          `${label}: frozen evidence decision changed in place; create a successor card instead`,
        );
      }
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
          "--pretty=format:",
          "--name-only",
          "--diff-filter=AM",
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
      const commits = execFileSync("git", ["log", "--format=%H", "--reverse", "--", path], {
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
        ["log", "--pretty=format:", "--name-only", "--diff-filter=AM", "--", "docs/gates/reports"],
        { cwd: root, encoding: "utf8" },
      )
        .split("\n")
        .filter(
          (path) => path.startsWith("docs/gates/reports/") && path.endsWith(".yaml"),
        ),
    );
    for (const path of historicalPaths) {
      const commits = execFileSync("git", ["log", "--format=%H", "--reverse", "--", path], {
        cwd: root,
        encoding: "utf8",
      })
        .split("\n")
        .filter(Boolean);
      let firstReport;
      let changedInHistory = false;
      for (const commit of commits) {
        try {
          const historical = parseYamlStrict(
            execFileSync("git", ["show", `${commit}:${path}`], {
              cwd: root,
              encoding: "utf8",
              stdio: ["ignore", "pipe", "pipe"],
            }),
          );
          if (!historical?.report_id || !historical?.gate) continue;
          if (!firstReport) firstReport = historical;
          else if (canonicalJson(firstReport) !== canonicalJson(historical)) changedInHistory = true;
        } catch {
          if (firstReport) changedInHistory = true;
        }
      }
      if (!firstReport) continue;
      const current = currentByPath.get(path);
      if (!current) {
        issues.push(`${path}: committed Gate report cannot be removed or renamed`);
      } else if (
        changedInHistory ||
        canonicalJson(firstReport) !== canonicalJson(current.document)
      ) {
        issues.push(`${path}: committed Gate report is append-only and cannot change in place`);
      }
    }
  } catch {
    issues.push("docs/gates/reports: Gate report inventory history could not be verified");
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

function parseYamlStrict(text) {
  const parsed = YAML.parseDocument(text, { uniqueKeys: true });
  if (parsed.errors.length > 0) {
    throw new Error(parsed.errors.map((error) => error.message).join("; "));
  }
  return parsed.toJS({ maxAliasCount: 0 });
}

function gitEvidenceManifestIssues(root, commit, gateDocument, label) {
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
    declaredByReference.set(artifact.reference, historical);
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
    return issues;
  }

  const expected = [];
  for (const repositoryPath of historicalPaths) {
    let historical;
    try {
      const bytes = execFileSync("git", ["show", `${commit}:${repositoryPath}`], {
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
    if (!historical?.evidence_id || historical?.lifecycle?.goal_scope !== "current_goal") continue;
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
  return issues;
}

function isCanonicalEvidenceTemplate(document) {
  const zeroDigest = `sha256:${"0".repeat(64)}`;
  return (
    document?.evidence_id === "EV-TEMPLATE-0001" &&
    document?.feature_id === "FEATURE-TEMPLATE-0001" &&
    document?.classification?.status === "unknown" &&
    document?.classification?.freeze_version === "draft" &&
    list(document?.disposition?.targets).length === 1 &&
    document.disposition.targets[0] === "exclude" &&
    list(document?.sources).every((source) => source?.verification_status === "unknown") &&
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
    const scope = parseJsonStrict(readFileSync(scopePath, "utf8"));
    if (
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      scope?.governing_prompt_sha256 !== TRUSTED_GOAL_SOURCE_SHA256
    ) {
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
  const issues = [];
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
  for (const record of evidenceRecords) add(registries.evidence, record.document.evidence_id, record.file);
  const supersessionIssues = evidenceSupersessionIssues(root, evidenceRecords);
  issues.push(...supersessionIssues);
  for (const record of evidenceRecords) {
    issues.push(...frozenEvidenceHistoryIssues(root, record));
  }
  issues.push(...frozenEvidenceInventoryIssues(root, evidenceRecords));
  issues.push(...goalSourceFreezeIssues(root, evidenceRecords));
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
        const declared = document.g0_oracles?.[category] ?? {};
        if (declared.document_count !== oracleRecords.length) {
          issues.push(
            `${label}.g0_oracles.${category}.document_count: declared count does not match schema-backed documents`,
          );
        }
        if (
          declared.passed_count !== passedRecords.length ||
          declared.frozen_count !== passedRecords.length
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
        ["state", "guard", "ledger"].flatMap((kind) =>
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
        const reportCommit = execFileSync(
          "git",
          ["log", "-1", "--format=%H", "--", relative(root, record.file)],
          { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
        ).trim();
        const snapshotIssues = gitDocumentSnapshotIssues(
          root,
          reportCommit,
          record.file,
          `${label}.release_identity.source_commit`,
        );
        issues.push(...snapshotIssues);
        if (snapshotIssues.length > 0) throw new Error("report snapshot mismatch");
        issues.push(...gitEvidenceManifestIssues(root, reportCommit, document, label));
        const parentFields = execFileSync("git", ["rev-list", "--parents", "-n", "1", reportCommit], {
          cwd: root,
          encoding: "utf8",
        })
          .trim()
          .split(/\s+/);
        if (parentFields.length !== 2) throw new Error("report commit must have exactly one parent");
        const subjectCommit = parentFields[1];
        if (subjectCommit !== document.release_identity?.source_commit) throw new Error("parent mismatch");
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
          for (const oracleRecord of ["state", "guard", "ledger", "oracle"].flatMap(
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
        ["docs/provenance/", "docs/specifications/", "docs/gates/"].some((prefix) =>
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
