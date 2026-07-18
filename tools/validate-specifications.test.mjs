// SPDX-License-Identifier: AGPL-3.0-or-later
// NOT FOR PRODUCTION — MOCK PROVIDERS ONLY

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

import {
  contentDigest,
  globalSpecificationIssues,
  repositoryReferenceIssues,
  validateDocument,
  validateRepository,
  validateSemantics,
} from "./validate-specifications.mjs";
import { runMatrix } from "./run-ledger-golden-vectors.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const G0_STATE_AGGREGATE_IDS = [
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
];

const G0_STATES_BY_AGGREGATE = {
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
};

const G0_GENERIC_COVERAGE = {
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
};

function stateFixturePath(aggregateId) {
  return `docs/specifications/state.${aggregateId.toLowerCase()}.fixture.yaml`;
}

function hasIssue(issues, fragment) {
  assert.ok(
    issues.some((issue) => issue.includes(fragment)),
    `expected an issue containing ${JSON.stringify(fragment)}; got ${JSON.stringify(issues)}`,
  );
}

function lacksIssue(issues, fragment) {
  assert.ok(
    !issues.some((issue) => issue.includes(fragment)),
    `expected no issue containing ${JSON.stringify(fragment)}; got ${JSON.stringify(issues)}`,
  );
}

function git(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function initializeGit(root) {
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.name", "Specification Test"]);
  git(root, ["config", "user.email", "specification-test@example.invalid"]);
  copyGoalTrustAnchors(root);
}

function copyGoalTrustAnchors(root) {
  const governance = join(root, "docs/governance");
  mkdirSync(governance, { recursive: true });
  cpSync(resolve(ROOT, "docs/governance/source-freeze.json"), join(governance, "source-freeze.json"));
  cpSync(resolve(ROOT, "docs/governance/scope-summary.json"), join(governance, "scope-summary.json"));
}

function commitAll(root, message) {
  git(root, ["add", "."]);
  git(root, ["-c", "commit.gpgsign=false", "commit", "-m", message]);
  return git(root, ["rev-parse", "HEAD"]);
}

function byteDigest(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

const LEDGER_ARTIFACT_SCHEMA =
  "https://opensales.system/schemas/ledger-golden-artifact.schema.json";

function canonicalJsonFixture(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJsonFixture).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJsonFixture(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function requiredLedgerAmounts() {
  return [
    {
      amount_id: "AMOUNT-COLLECTIBLE-TOTAL",
      name: "Collectible total",
      formula: {
        op: "sum",
        values: [
          { op: "input", input_id: "INPUT-ACTIVE-LINE-SNAPSHOT-TOTAL" },
          { op: "input", input_id: "INPUT-APPEND-ONLY-CORRECTION-TOTAL" },
        ],
      },
      input_ids: [
        "INPUT-ACTIVE-LINE-SNAPSHOT-TOTAL",
        "INPUT-APPEND-ONLY-CORRECTION-TOTAL",
      ],
      rounding_rule_id: "ROUND-USD",
      invariant_ids: ["INVARIANT-JOURNAL-BALANCE"],
      evidence_ids: ["EV-GATE-0001"],
      test_ids: ["TEST-COLLECTIBLE-TOTAL"],
    },
    {
      amount_id: "AMOUNT-ALLOCATED-TOTAL",
      name: "Allocated total",
      formula: {
        op: "sum",
        values: [
          {
            op: "input",
            input_id: "INPUT-SETTLED-UNREVERSED-PAYMENT-ALLOCATION-TOTAL",
          },
          {
            op: "input",
            input_id: "INPUT-SETTLED-UNREVERSED-CREDIT-ALLOCATION-TOTAL",
          },
        ],
      },
      input_ids: [
        "INPUT-SETTLED-UNREVERSED-PAYMENT-ALLOCATION-TOTAL",
        "INPUT-SETTLED-UNREVERSED-CREDIT-ALLOCATION-TOTAL",
      ],
      rounding_rule_id: "ROUND-USD",
      invariant_ids: ["INVARIANT-JOURNAL-BALANCE"],
      evidence_ids: ["EV-GATE-0001"],
      test_ids: ["TEST-ALLOCATED-TOTAL"],
    },
    {
      amount_id: "AMOUNT-OUTSTANDING",
      name: "Outstanding",
      formula: {
        op: "clamp_min_zero",
        value: {
          op: "subtract",
          left: { op: "amount", amount_id: "AMOUNT-COLLECTIBLE-TOTAL" },
          right: { op: "amount", amount_id: "AMOUNT-ALLOCATED-TOTAL" },
        },
      },
      input_ids: [],
      rounding_rule_id: "ROUND-USD",
      invariant_ids: ["INVARIANT-JOURNAL-BALANCE"],
      evidence_ids: ["EV-GATE-0001"],
      test_ids: ["TEST-OUTSTANDING"],
    },
  ];
}

function writeLedgerAttestation(root, matrixPath, matrixDocument) {
  const runnerPath = join(root, "tools/run-ledger-golden-vectors.mjs");
  mkdirSync(dirname(runnerPath), { recursive: true });
  cpSync(resolve(ROOT, "tools/run-ledger-golden-vectors.mjs"), runnerPath);
  matrixDocument.golden_runner.executable.content_digest = byteDigest(readFileSync(runnerPath));
  writeFileSync(matrixPath, `${JSON.stringify(matrixDocument, null, 2)}\n`);
  const args = [
    runnerPath,
    "--protocol",
    "oss-ledger-exact/v1",
    "--root",
    root,
    "--matrix",
    relative(root, matrixPath),
    "--format",
    "canonical-json",
  ];
  let output = execFileSync(process.execPath, args);
  const attestationPath = join(
    root,
    matrixDocument.golden_runner.attestation.reference.slice("repo:".length),
  );
  mkdirSync(dirname(attestationPath), { recursive: true });
  matrixDocument.golden_runner.attestation.content_digest = byteDigest(output);
  writeFileSync(matrixPath, `${JSON.stringify(matrixDocument, null, 2)}\n`);
  output = execFileSync(process.execPath, args);
  writeFileSync(attestationPath, output);
  return output;
}

function ledgerVectorFixture(
  inputReference,
  expectedReference,
  inputBytes = '{"input":true}\n',
  expectedBytes = '{"balanced":true}\n',
  coveredPostingRuleIds = [],
  expectedInvariantIds = [],
) {
  const vector = {
    vector_id: "VECTOR-FIXTURE-0001",
    input_fixture_ref: inputReference,
    input_fixture_digest: byteDigest(inputBytes),
    expected_postings_ref: expectedReference,
    expected_postings_digest: byteDigest(expectedBytes),
    content_digest: `sha256:${"0".repeat(64)}`,
    covered_posting_rule_ids: coveredPostingRuleIds,
    expected_invariant_ids: expectedInvariantIds,
    property_test_ids: ["TEST-VECTOR-FIXTURE-0001"],
  };
  vector.content_digest = contentDigest(vector, ["content_digest"]);
  return vector;
}

function globalEvidence(overrides = {}) {
  return {
    evidence_id: "EV-GATE-0001",
    feature_id: "FEATURE-GATE-0001",
    priority: "P1",
    sources: [
      {
        source_id: "SRC-GOAL-0001",
        source_type: "goal_specification",
        reference: "goal://cloud-termrat-core-goal-prompt#synthetic-global-fixture",
        authority_rank: 1,
        verification_status: "frozen",
        content_digest:
          "sha256:9cd354eacdc194b94d03ced6e986687da71f8cb58bdb50450c2ff91bca843392",
      },
    ],
    classification: { status: "retained" },
    lifecycle: {
      status: "frozen",
      goal_scope: "current_goal",
      first_gate: "G0",
      acceptance_gate: "G9",
      supersedes: null,
    },
    ...overrides,
  };
}

function frozenEvidenceFixture() {
  const document = YAML.parse(
    readFileSync(resolve(ROOT, "docs/provenance/evidence-card.template.yaml"), "utf8"),
  );
  document.evidence_id = "EV-GATE-0001";
  document.feature_id = "FEATURE-GATE-0001";
  document.title = "Synthetic independently reviewed Gate evidence";
  document.business_description = "A synthetic capability used only to test immutable Gate evidence.";
  document.sources[0] = {
    source_id: "SRC-GATE-0001",
    source_type: "goal_specification",
    reference: "goal://cloud-termrat-core-goal-prompt#synthetic-gate-fixture",
    authority_rank: 1,
    verification_status: "verified",
    observed_at: "2026-07-18T00:00:00Z",
    content_digest:
      "sha256:9cd354eacdc194b94d03ced6e986687da71f8cb58bdb50450c2ff91bca843392",
    notes: "Synthetic test fixture.",
  };
  document.classification = {
    status: "retained",
    rationale: "Retained solely for the synthetic Gate fixture.",
    freeze_version: "1.0.0",
    fail_safe_behavior: "Keep the synthetic capability unavailable on validation failure.",
    negative_test_refs: [],
  };
  document.disposition = {
    targets: ["core"],
    module_ids: ["MODULE-CORE-0001"],
    provider_capability_ids: [],
    configuration_keys: [],
    exclusion_assertion_ids: [],
  };
  document.review = {
    author_role: "evidence_author",
    reviewer_roles: ["evidence_reviewer"],
    independent_review: true,
    status: "passed",
    reproduction_commands: ["node tools/validate-specifications.mjs"],
    evidence_refs: ["repo:docs/reviews/gate-evidence.txt"],
    findings: [],
  };
  document.lifecycle.status = "frozen";
  document.lifecycle.content_digest = contentDigest(document, ["lifecycle", "content_digest"]);
  return document;
}

function globalGate(sourceCommit, artifact = "repo:docs/reviews/gate-evidence.txt") {
  const evidenceBytes = YAML.stringify(frozenEvidenceFixture());
  return {
    schema_version: 1,
    report_id: "gate.g0.fixture",
    supersedes_report_id: null,
    gate: "G0",
    release_identity: { source_commit: sourceCommit },
    feature_evidence: {
      total: 1,
      classified: 1,
      frozen_total: 1,
      retained_total: 1,
      due_for_acceptance: 0,
      due_verified: 0,
      p0_total: 0,
      p0_unexplained: 0,
      card_artifacts: [
        {
          evidence_id: "EV-GATE-0001",
          reference: "repo:docs/provenance/cards/EV-GATE-0001.yaml",
          content_digest: byteDigest(evidenceBytes),
        },
      ],
      matrix_artifact: artifact,
    },
    g0_oracles: {
      state_transition_tables: {
        document_count: G0_STATE_AGGREGATE_IDS.length,
        passed_count: G0_STATE_AGGREGATE_IDS.length,
        frozen_count: G0_STATE_AGGREGATE_IDS.length,
        artifact_refs: G0_STATE_AGGREGATE_IDS.map(
          (aggregateId) => `repo:${stateFixturePath(aggregateId)}`,
        ),
      },
      guard_rbac_matrices: {
        document_count: 1,
        passed_count: 1,
        frozen_count: 1,
        artifact_refs: ["repo:docs/specifications/guard.fixture.yaml"],
      },
      ledger_posting_matrices: {
        document_count: 1,
        passed_count: 1,
        frozen_count: 1,
        artifact_refs: ["repo:docs/specifications/ledger.fixture.json"],
      },
      transport_contracts: {
        document_count: 1,
        passed_count: 1,
        frozen_count: 1,
        artifact_refs: ["repo:docs/contracts/transport/transport.fixture.yaml"],
      },
      provider_contracts: {
        document_count: 1,
        passed_count: 1,
        frozen_count: 1,
        artifact_refs: ["repo:docs/contracts/providers/provider.fixture.yaml"],
      },
      data_retention_models: {
        document_count: 1,
        passed_count: 1,
        frozen_count: 1,
        artifact_refs: ["repo:docs/governance/data-retention/retention.fixture.yaml"],
      },
      threat_models: {
        document_count: 1,
        passed_count: 1,
        frozen_count: 1,
        artifact_refs: ["repo:docs/threat-model/threat.fixture.yaml"],
      },
      test_strategies: {
        document_count: 1,
        passed_count: 1,
        frozen_count: 1,
        artifact_refs: ["repo:docs/testing/strategy.fixture.yaml"],
      },
    },
    verification: {
      artifact_refs: [artifact],
      commands: [{ artifact_refs: [artifact] }],
    },
    reviews: { evidence_audit: { artifact_ref: artifact } },
    rollback: { procedure_ref: artifact },
    security: { accepted_risks: [] },
    decision: { outcome: "go" },
  };
}

function writeG0OracleFixture(root, ledgerArtifact = "repo:docs/reviews/gate-evidence.txt") {
  copyGoalTrustAnchors(root);
  const statePaths = G0_STATE_AGGREGATE_IDS.map(stateFixturePath);
  const paths = [
    ...statePaths,
    "docs/specifications/guard.fixture.yaml",
    "docs/specifications/ledger.fixture.json",
    "docs/contracts/transport/transport.fixture.yaml",
    "docs/contracts/providers/provider.fixture.yaml",
    "docs/governance/data-retention/retention.fixture.yaml",
    "docs/threat-model/threat.fixture.yaml",
    "docs/testing/strategy.fixture.yaml",
  ];
  const normativePaths = [
    "docs/contracts/transport/transport.normative.yaml",
    "docs/contracts/providers/provider.normative.yaml",
    "docs/governance/data-retention/retention.normative.yaml",
    "docs/threat-model/threat.normative.yaml",
    "docs/testing/strategy.normative.yaml",
  ];
  for (const path of [...paths, ...normativePaths]) {
    const absolutePath = join(root, path);
    mkdirSync(dirname(absolutePath), { recursive: true });
  }
  for (const path of normativePaths) {
    writeFileSync(join(root, path), "normative oracle fixture\n");
  }
  const ledgerInputReference = "repo:docs/reviews/ledger-vector-input.json";
  const ledgerExpectedReference = "repo:docs/reviews/ledger-vector-expected.json";
  const ledgerAttestationReference = "repo:docs/reviews/ledger-attestation.json";
  mkdirSync(join(root, "docs/reviews"), { recursive: true });
  const ledgerEventIds = [
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
  ];
  const postingRules = ledgerEventIds.map((eventId, index) => {
    const suffix = String(index + 1).padStart(2, "0");
    return {
      posting_rule_id: `POSTING-RULE-FIXTURE-${suffix}`,
      event_id: eventId,
      amount_source_ids: ["AMOUNT-OUTSTANDING"],
      balance_invariant_ids: ["INVARIANT-JOURNAL-BALANCE"],
      evidence_ids: ["EV-GATE-0001"],
      test_ids: [`TEST-POSTING-FIXTURE-${suffix}`],
      lines: [
        {
          line_id: `LINE-FIXTURE-${suffix}-DEBIT`,
          side: "debit",
          account_id: "ACCOUNT-PROCESSOR-CLEARING",
          amount_id: "AMOUNT-OUTSTANDING",
        },
        {
          line_id: `LINE-FIXTURE-${suffix}-CREDIT`,
          side: "credit",
          account_id: "ACCOUNT-REVENUE",
          amount_id: "AMOUNT-OUTSTANDING",
        },
      ],
    };
  });
  const inputDocument = {
    $schema: LEDGER_ARTIFACT_SCHEMA,
    kind: "input",
    protocol: "oss-ledger-exact/v1",
    matrix_id: "MATRIX-LEDGER-CORE",
    vector_id: "VECTOR-FIXTURE-0001",
    inputs: [
      {
        input_id: "INPUT-ACTIVE-LINE-SNAPSHOT-TOTAL",
        asset_id: "ASSET-USD",
        atoms: "100",
      },
      {
        input_id: "INPUT-APPEND-ONLY-CORRECTION-TOTAL",
        asset_id: "ASSET-USD",
        atoms: "0",
      },
      {
        input_id: "INPUT-SETTLED-UNREVERSED-PAYMENT-ALLOCATION-TOTAL",
        asset_id: "ASSET-USD",
        atoms: "0",
      },
      {
        input_id: "INPUT-SETTLED-UNREVERSED-CREDIT-ALLOCATION-TOTAL",
        asset_id: "ASSET-USD",
        atoms: "0",
      },
    ],
    evaluate_amount_ids: [
      "AMOUNT-COLLECTIBLE-TOTAL",
      "AMOUNT-ALLOCATED-TOTAL",
      "AMOUNT-OUTSTANDING",
    ],
    posting_rule_ids: postingRules.map((rule) => rule.posting_rule_id),
  };
  const expectedDocument = {
    $schema: LEDGER_ARTIFACT_SCHEMA,
    kind: "expected",
    protocol: "oss-ledger-exact/v1",
    matrix_id: "MATRIX-LEDGER-CORE",
    vector_id: "VECTOR-FIXTURE-0001",
    amounts: [
      { amount_id: "AMOUNT-COLLECTIBLE-TOTAL", asset_id: "ASSET-USD", atoms: "100" },
      { amount_id: "AMOUNT-ALLOCATED-TOTAL", asset_id: "ASSET-USD", atoms: "0" },
      { amount_id: "AMOUNT-OUTSTANDING", asset_id: "ASSET-USD", atoms: "100" },
    ],
    journals: postingRules.map((rule) => ({
      posting_rule_id: rule.posting_rule_id,
      postings: rule.lines.map((line) => ({
        line_id: line.line_id,
        account_id: line.account_id,
        side: line.side,
        asset_id: "ASSET-USD",
        atoms: "100",
      })),
    })),
  };
  const inputBytes = `${JSON.stringify(inputDocument, null, 2)}\n`;
  const expectedBytes = `${JSON.stringify(expectedDocument, null, 2)}\n`;
  writeFileSync(join(root, ledgerInputReference.slice("repo:".length)), inputBytes);
  writeFileSync(join(root, ledgerExpectedReference.slice("repo:".length)), expectedBytes);
  const vector = ledgerVectorFixture(
    ledgerInputReference,
    ledgerExpectedReference,
    inputBytes,
    expectedBytes,
    postingRules.map((rule) => rule.posting_rule_id),
    ["INVARIANT-JOURNAL-BALANCE"],
  );
  const ledgerDocument = {
    matrix_id: "MATRIX-LEDGER-CORE",
    review: { status: "passed", artifact_refs: [ledgerArtifact] },
    source_evidence_ids: [],
    accounts: [
      "ACCOUNT-REVENUE",
      "ACCOUNT-DEFERRED-REVENUE",
      "ACCOUNT-TAX-PAYABLE",
      "ACCOUNT-PROCESSOR-CLEARING",
      "ACCOUNT-CUSTOMER-CREDIT-LIABILITY",
      "ACCOUNT-UNAPPLIED-FUNDS-LIABILITY",
    ].map((accountId) => ({ account_id: accountId })),
    rounding_rules: [{ rounding_rule_id: "ROUND-USD", mode: "half_up" }],
    derived_amounts: requiredLedgerAmounts(),
    invariants: [{ invariant_id: "INVARIANT-JOURNAL-BALANCE", kind: "journal_balance" }],
    posting_rules: postingRules,
    manual_command_rules: [
      "COMMAND-RECORD-MANUAL-PAYMENT",
      "COMMAND-RECORD-MANUAL-TOPUP",
      "COMMAND-RECORD-MANUAL-REFUND",
      "COMMAND-RECORD-MANUAL-CORRECTION",
    ].map((commandId) => ({ command_id: commandId })),
    golden_vector_refs: [vector],
    golden_runner: {
      protocol: "oss-ledger-exact/v1",
      executable: {
        reference: "repo:tools/run-ledger-golden-vectors.mjs",
        content_digest: `sha256:${"0".repeat(64)}`,
      },
      attestation: {
        reference: ledgerAttestationReference,
        content_digest: `sha256:${"0".repeat(64)}`,
      },
    },
  };
  const records = [
    ...G0_STATE_AGGREGATE_IDS.map((aggregateId, index) => ({
      kind: "state",
      file: join(root, statePaths[index]),
      document: {
        aggregate_id: aggregateId,
        review: { status: "passed", artifact_refs: [ledgerArtifact] },
        source_evidence_ids: [],
        states:
          G0_STATES_BY_AGGREGATE[aggregateId]?.map((stateId) => ({ state_id: stateId })) ??
          [{ state_id: `STATE-${aggregateId.slice("AGGREGATE-".length)}-INITIAL` }],
        commands:
          aggregateId === "AGGREGATE-PAYMENT"
            ? [
                { command_id: "COMMAND-RECORD-MANUAL-PAYMENT" },
                { command_id: "COMMAND-RECORD-MANUAL-TOPUP" },
                { command_id: "COMMAND-RECORD-MANUAL-REFUND" },
                { command_id: "COMMAND-RECORD-MANUAL-CORRECTION" },
              ]
            : [],
        transitions: [],
      },
    })),
    {
      kind: "guard",
      file: join(root, "docs/specifications/guard.fixture.yaml"),
      document: {
        review: { status: "passed", artifact_refs: [ledgerArtifact] },
        source_evidence_ids: [],
        resource_types: [
          "RESOURCE-USER",
          "RESOURCE-CLIENT-ACCOUNT",
          "RESOURCE-MEMBERSHIP",
          "RESOURCE-STAFF",
          "RESOURCE-PROVIDER",
        ].map((typeId) => ({ type_id: typeId })),
        state_combinations: [
          "COMBINATION-OWNER-RESTRICTED-MEMBER-ACTIVE",
          "COMBINATION-CLIENT-ACCOUNT-RESTRICTED",
          "COMBINATION-CLIENT-ACCOUNT-RESTORED",
        ].map((combinationId) => ({ combination_id: combinationId })),
        guards: [],
      },
    },
    {
      kind: "ledger",
      file: join(root, "docs/specifications/ledger.fixture.json"),
      document: ledgerDocument,
    },
    ...[
      "transport_contracts",
      "provider_contracts",
      "data_retention_models",
      "threat_models",
      "test_strategies",
    ].map((oracleKind, index) => ({
      kind: "oracle",
      file: join(root, paths[statePaths.length + index + 2]),
      document: {
        oracle_id: `ORACLE-FIXTURE-000${index + 1}`,
        oracle_kind: oracleKind,
        source_evidence_ids: ["EV-GATE-0001"],
        coverage_ids: G0_GENERIC_COVERAGE[oracleKind],
        normative_artifacts: [
          {
            reference: `repo:${normativePaths[index]}`,
            content_digest: byteDigest("normative oracle fixture\n"),
          },
        ],
        review: { status: "passed", evidence_refs: [ledgerArtifact] },
      },
    })),
  ];
  for (const record of records) {
    if (record.kind !== "ledger") writeFileSync(record.file, YAML.stringify(record.document));
  }
  writeLedgerAttestation(
    root,
    join(root, "docs/specifications/ledger.fixture.json"),
    ledgerDocument,
  );
  return records;
}

test("repository schemas compile and checked templates are valid", () => {
  assert.deepEqual(validateRepository(ROOT), []);
});

test("evidence template is structurally and semantically valid as a fail-closed draft", () => {
  const template = YAML.parse(
    readFileSync(resolve(ROOT, "docs/provenance/evidence-card.template.yaml"), "utf8"),
  );
  assert.deepEqual(validateDocument("evidence", template), []);
});

test("G0 generic oracle wrapper requires reproducible independent review", () => {
  const document = {
    $schema: "./g0-oracle.schema.json",
    schema_version: "1.0.0",
    oracle_id: "ORACLE-TRANSPORT-0001",
    oracle_kind: "transport_contracts",
    title: "Synthetic transport oracle",
    version: "1.0.0",
    source_evidence_ids: ["EV-TRANSPORT-0001"],
    coverage_ids: G0_GENERIC_COVERAGE.transport_contracts,
    normative_artifacts: [
      {
        reference: "repo:docs/contracts/transport/transport.yaml",
        content_digest: byteDigest("synthetic transport contract\n"),
      },
    ],
    review: {
      author_role: "oracle_author",
      reviewer_roles: ["oracle_reviewer"],
      independent_review: true,
      status: "passed",
      reproduction_commands: ["node tools/validate-specifications.mjs"],
      evidence_refs: ["repo:docs/reviews/transport.txt"],
      findings: [],
    },
    content_digest: `sha256:${"0".repeat(64)}`,
  };
  document.content_digest = contentDigest(document, ["content_digest"]);
  assert.deepEqual(validateDocument("oracle", document), []);

  document.review.reviewer_roles = ["oracle_author"];
  hasIssue(validateDocument("oracle", document), "author role cannot also be a reviewer role");

  document.review.reviewer_roles = ["oracle_reviewer"];
  document.normative_artifacts.push({
    reference: document.normative_artifacts[0].reference,
    content_digest: byteDigest("different bytes\n"),
  });
  hasIssue(validateDocument("oracle", document), "duplicate artifact reference");
});

test("G0 oracle artifacts bind regular repository bytes and cannot reference their wrapper", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "oss-oracle-digests-"));
  try {
    const wrapperPath = join(temporaryRoot, "docs/contracts/transport/transport.fixture.yaml");
    const artifactPath = join(temporaryRoot, "docs/contracts/transport/transport.yaml");
    const reviewPath = join(temporaryRoot, "docs/reviews/transport.txt");
    mkdirSync(dirname(wrapperPath), { recursive: true });
    mkdirSync(dirname(reviewPath), { recursive: true });
    writeFileSync(wrapperPath, "oracle wrapper\n");
    writeFileSync(artifactPath, "contract version one\n");
    writeFileSync(reviewPath, "independent review fixture\n");
    const document = {
      oracle_id: "ORACLE-BYTES-0001",
      oracle_kind: "transport_contracts",
      source_evidence_ids: [],
      normative_artifacts: [
        {
          reference: "repo:docs/contracts/transport/transport.yaml",
          content_digest: byteDigest("contract version one\n"),
        },
      ],
      review: {
        status: "passed",
        evidence_refs: ["repo:docs/reviews/transport.txt"],
      },
    };
    const record = { kind: "oracle", file: wrapperPath, document };
    assert.deepEqual(globalSpecificationIssues(temporaryRoot, [record]), []);

    writeFileSync(artifactPath, "contract version two\n");
    hasIssue(
      globalSpecificationIssues(temporaryRoot, [record]),
      "does not match repository artifact bytes",
    );

    document.normative_artifacts = [
      {
        reference: "repo:docs/contracts/transport/transport.fixture.yaml",
        content_digest: byteDigest("oracle wrapper\n"),
      },
    ];
    hasIssue(globalSpecificationIssues(temporaryRoot, [record]), "cannot declare itself");
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("ledger golden vectors and runner evidence bind each referenced file's bytes", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "oss-ledger-digests-"));
  try {
    mkdirSync(join(temporaryRoot, "docs/reviews"), { recursive: true });
    writeFileSync(join(temporaryRoot, "docs/reviews/gate-evidence.txt"), "evidence\n");
    const records = writeG0OracleFixture(temporaryRoot);
    const ledgerRecord = records.find((record) => record.kind === "ledger");
    const allRecords = [
      {
        kind: "evidence",
        file: join(temporaryRoot, "docs/provenance/cards/EV-GATE-0001.yaml"),
        document: globalEvidence(),
      },
      ...records,
    ];
    assert.deepEqual(globalSpecificationIssues(temporaryRoot, allRecords), []);

    const inputPath = join(temporaryRoot, "docs/reviews/ledger-vector-input.json");
    const changedInput = `${JSON.stringify({ changed: true })}\n`;
    writeFileSync(inputPath, changedInput);
    hasIssue(
      globalSpecificationIssues(temporaryRoot, allRecords),
      "does not match repository artifact bytes",
    );
    ledgerRecord.document.golden_vector_refs[0].input_fixture_digest = byteDigest(changedInput);
    hasIssue(
      validateSemantics("ledger", ledgerRecord.document),
      "vector digest does not match",
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("exact-ledger runner uses BigInt, concrete rounding, asset isolation, and exact postings", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "oss-ledger-runner-v1-"));
  try {
    const inputReference = "repo:docs/reviews/exact-input.json";
    const expectedReference = "repo:docs/reviews/exact-expected.json";
    const matrixPath = join(temporaryRoot, "docs/specifications/exact-ledger.json");
    const inputPath = join(temporaryRoot, inputReference.slice("repo:".length));
    const expectedPath = join(temporaryRoot, expectedReference.slice("repo:".length));
    for (const path of [matrixPath, inputPath, expectedPath]) {
      mkdirSync(dirname(path), { recursive: true });
    }
    const input = {
      $schema: LEDGER_ARTIFACT_SCHEMA,
      kind: "input",
      protocol: "oss-ledger-exact/v1",
      matrix_id: "MATRIX-EXACT-RUNNER",
      vector_id: "VECTOR-EXACT-RUNNER",
      inputs: [
        { input_id: "INPUT-HALF-UP", asset_id: "ASSET-USD", atoms: "100" },
        { input_id: "INPUT-HALF-EVEN", asset_id: "ASSET-USD", atoms: "300" },
        {
          input_id: "INPUT-BIGINT",
          asset_id: "ASSET-USD",
          atoms: "90071992547409931234567890",
        },
      ],
      evaluate_amount_ids: [
        "AMOUNT-HALF-UP",
        "AMOUNT-HALF-EVEN",
        "AMOUNT-BIGINT",
      ],
      posting_rule_ids: ["POSTING-EXACT-RUNNER"],
    };
    const expected = {
      $schema: LEDGER_ARTIFACT_SCHEMA,
      kind: "expected",
      protocol: "oss-ledger-exact/v1",
      matrix_id: "MATRIX-EXACT-RUNNER",
      vector_id: "VECTOR-EXACT-RUNNER",
      amounts: [
        { amount_id: "AMOUNT-HALF-UP", asset_id: "ASSET-USD", atoms: "4" },
        { amount_id: "AMOUNT-HALF-EVEN", asset_id: "ASSET-USD", atoms: "10" },
        {
          amount_id: "AMOUNT-BIGINT",
          asset_id: "ASSET-USD",
          atoms: "90071992547409931234567890",
        },
      ],
      journals: [
        {
          posting_rule_id: "POSTING-EXACT-RUNNER",
          postings: [
            {
              line_id: "LINE-EXACT-DEBIT",
              account_id: "ACCOUNT-CASH",
              side: "debit",
              asset_id: "ASSET-USD",
              atoms: "4",
            },
            {
              line_id: "LINE-EXACT-CREDIT",
              account_id: "ACCOUNT-REVENUE",
              side: "credit",
              asset_id: "ASSET-USD",
              atoms: "4",
            },
          ],
        },
      ],
    };
    const inputBytes = `${JSON.stringify(input, null, 2)}\n`;
    const expectedBytes = `${JSON.stringify(expected, null, 2)}\n`;
    writeFileSync(inputPath, inputBytes);
    writeFileSync(expectedPath, expectedBytes);
    const vector = ledgerVectorFixture(
      inputReference,
      expectedReference,
      inputBytes,
      expectedBytes,
      ["POSTING-EXACT-RUNNER"],
      ["INVARIANT-JOURNAL-BALANCE"],
    );
    vector.vector_id = "VECTOR-EXACT-RUNNER";
    vector.content_digest = contentDigest(vector, ["content_digest"]);
    const matrix = {
      matrix_id: "MATRIX-EXACT-RUNNER",
      rounding_rules: [
        { rounding_rule_id: "ROUND-HALF-UP", mode: "half_up" },
        { rounding_rule_id: "ROUND-HALF-EVEN", mode: "half_even" },
      ],
      derived_amounts: [
        {
          amount_id: "AMOUNT-HALF-UP",
          formula: {
            op: "multiply_ratio_round",
            value: { op: "input", input_id: "INPUT-HALF-UP" },
            numerator: "7",
            denominator: "200",
            rounding_rule_id: "ROUND-HALF-UP",
          },
        },
        {
          amount_id: "AMOUNT-HALF-EVEN",
          formula: {
            op: "multiply_ratio_round",
            value: { op: "input", input_id: "INPUT-HALF-EVEN" },
            numerator: "7",
            denominator: "200",
            rounding_rule_id: "ROUND-HALF-EVEN",
          },
        },
        {
          amount_id: "AMOUNT-BIGINT",
          formula: { op: "input", input_id: "INPUT-BIGINT" },
        },
      ],
      posting_rules: [
        {
          posting_rule_id: "POSTING-EXACT-RUNNER",
          lines: [
            {
              line_id: "LINE-EXACT-DEBIT",
              account_id: "ACCOUNT-CASH",
              side: "debit",
              amount_id: "AMOUNT-HALF-UP",
            },
            {
              line_id: "LINE-EXACT-CREDIT",
              account_id: "ACCOUNT-REVENUE",
              side: "credit",
              amount_id: "AMOUNT-HALF-UP",
            },
          ],
        },
      ],
      golden_vector_refs: [vector],
      golden_runner: {
        protocol: "oss-ledger-exact/v1",
        executable: {
          reference: "repo:tools/run-ledger-golden-vectors.mjs",
          content_digest: byteDigest(
            readFileSync(resolve(ROOT, "tools/run-ledger-golden-vectors.mjs")),
          ),
        },
        attestation: {
          reference: "repo:docs/reviews/not-used.json",
          content_digest: `sha256:${"1".repeat(64)}`,
        },
      },
    };
    writeFileSync(matrixPath, `${JSON.stringify(matrix, null, 2)}\n`);
    const result = runMatrix(temporaryRoot, "docs/specifications/exact-ledger.json");
    assert.deepEqual(
      result.vectors[0].amounts.map((amount) => amount.atoms),
      ["4", "10", "90071992547409931234567890"],
    );
    assert.equal(result.vectors[0].balance_checks[0].balanced, true);

    expected.journals[0].postings[1].atoms = "5";
    const mismatchedBytes = `${JSON.stringify(expected, null, 2)}\n`;
    writeFileSync(expectedPath, mismatchedBytes);
    vector.expected_postings_digest = byteDigest(mismatchedBytes);
    vector.content_digest = contentDigest(vector, ["content_digest"]);
    writeFileSync(matrixPath, `${JSON.stringify(matrix, null, 2)}\n`);
    assert.throws(
      () => runMatrix(temporaryRoot, "docs/specifications/exact-ledger.json"),
      /do not match expected artifact/,
    );

    input.inputs[1].asset_id = "ASSET-EUR";
    input.evaluate_amount_ids = ["AMOUNT-CROSS-ASSET"];
    const crossAssetBytes = `${JSON.stringify(input, null, 2)}\n`;
    writeFileSync(inputPath, crossAssetBytes);
    matrix.derived_amounts.push({
      amount_id: "AMOUNT-CROSS-ASSET",
      formula: {
        op: "sum",
        values: [
          { op: "input", input_id: "INPUT-HALF-UP" },
          { op: "input", input_id: "INPUT-HALF-EVEN" },
        ],
      },
    });
    vector.input_fixture_digest = byteDigest(crossAssetBytes);
    vector.content_digest = contentDigest(vector, ["content_digest"]);
    writeFileSync(matrixPath, `${JSON.stringify(matrix, null, 2)}\n`);
    assert.throws(
      () => runMatrix(temporaryRoot, "docs/specifications/exact-ledger.json"),
      /mixes assets/,
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("evidence rejects authority lies, contradictory targets, and fake freezes", () => {
  const document = {
    sources: [
      {
        source_id: "source.owner",
        source_type: "owner_decision",
        authority_rank: 4,
        line_start: 20,
        line_end: 10,
      },
    ],
    classification: { status: "retained", negative_test_refs: [] },
    disposition: { targets: ["core", "exclude"] },
    review: { status: "pending" },
    lifecycle: { status: "frozen", content_digest: `sha256:${"0".repeat(64)}` },
  };
  const issues = validateSemantics("evidence", document);
  hasIssue(issues, "authority rank 1");
  hasIssue(issues, "line_end precedes");
  hasIssue(issues, "cannot target exclude");
  hasIssue(issues, "needs a passed review");
  hasIssue(issues, "content digest does not match");
});

test("untrusted sources and self-review cannot impersonate high-authority evidence", () => {
  const issues = validateSemantics("evidence", {
    sources: [
      {
        source_id: "SRC-OTHER-0001",
        source_type: "other",
        authority_rank: 1,
        verification_status: "verified",
      },
    ],
    classification: { status: "unknown" },
    disposition: { targets: ["exclude"] },
    review: {
      status: "passed",
      author_role: "same_role",
      reviewer_roles: ["same_role"],
      independent_review: true,
      reproduction_commands: ["verify"],
      evidence_refs: ["repo:evidence"],
    },
    lifecycle: { status: "draft" },
  });
  hasIssue(issues, "other must use authority rank 4");
  hasIssue(issues, "other source needs an explicit note");
  hasIssue(issues, "verified source needs observed_at");
  hasIssue(issues, "author role cannot also be a reviewer role");
});

test("current-goal evidence cannot hide outside the G0-G9 denominator", () => {
  const issues = validateSemantics("evidence", {
    sources: [],
    classification: { status: "retained" },
    disposition: { targets: ["core"], module_ids: ["MODULE-CORE-0001"] },
    review: { status: "pending" },
    lifecycle: {
      status: "draft",
      goal_scope: "current_goal",
      first_gate: "POST_GOAL",
      acceptance_gate: "POST_GOAL",
    },
  });
  hasIssue(issues, "current-goal evidence starts at G0 and must be accepted by G9");
});

test("post-goal evidence requires a frozen owner-approved deviation", () => {
  const hiddenDraft = {
    sources: [],
    classification: { status: "retained" },
    disposition: { targets: ["core"], module_ids: ["MODULE-CORE-0001"] },
    review: { status: "pending" },
    lifecycle: {
      status: "draft",
      goal_scope: "post_goal",
      first_gate: "POST_GOAL",
      acceptance_gate: "POST_GOAL",
    },
  };
  const issues = validateSemantics("evidence", hiddenDraft);
  hasIssue(issues, "post-goal evidence must be frozen");
  hasIssue(issues, "approved deviation id");
  hasIssue(issues, "frozen owner decision source");

  const approved = YAML.parse(
    readFileSync(resolve(ROOT, "docs/provenance/evidence-card.template.yaml"), "utf8"),
  );
  approved.sources[0] = {
    source_id: "SRC-OWNER-0001",
    source_type: "owner_decision",
    reference: "owner://approved-future-scope",
    authority_rank: 1,
    verification_status: "frozen",
    content_digest: `sha256:${"1".repeat(64)}`,
  };
  approved.classification.approved_deviation_id = "DEVIATION-OWNER-0001";
  approved.unknown_handling.resolution_gate = "POST_GOAL";
  approved.review = {
    author_role: "evidence_author",
    reviewer_roles: ["independent_reviewer"],
    independent_review: true,
    status: "passed",
    reproduction_commands: ["node tools/validate-specifications.mjs"],
    evidence_refs: ["repo:docs/reviews/evidence-review.txt"],
    findings: [],
  };
  approved.lifecycle.status = "frozen";
  approved.lifecycle.goal_scope = "post_goal";
  approved.lifecycle.first_gate = "POST_GOAL";
  approved.lifecycle.acceptance_gate = "POST_GOAL";
  approved.lifecycle.content_digest = contentDigest(approved, ["lifecycle", "content_digest"]);
  assert.deepEqual(validateDocument("evidence", approved), []);
});

test("post-goal approval evidence must resolve to a repository file", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "oss-post-goal-approval-"));
  try {
    const issues = globalSpecificationIssues(temporaryRoot, [
      {
        kind: "evidence",
        file: join(temporaryRoot, "post-goal.yaml"),
        document: {
          ...globalEvidence(),
          lifecycle: {
            status: "frozen",
            goal_scope: "post_goal",
            first_gate: "POST_GOAL",
            acceptance_gate: "POST_GOAL",
            supersedes: null,
          },
          review: { evidence_refs: ["approval-without-repository-binding"] },
        },
      },
    ]);
    hasIssue(issues, "acceptance evidence must use a resolvable repo: reference");
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("unknown resolution deadline is independent from the later acceptance deadline", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "oss-unknown-deadline-"));
  try {
    const evidence = globalEvidence({
      classification: { status: "unknown" },
      unknown_handling: { resolution_gate: "G0" },
    });
    const gate = globalGate("0".repeat(40));
    gate.feature_evidence.retained_total = 0;
    const issues = globalSpecificationIssues(temporaryRoot, [
      { kind: "evidence", file: join(temporaryRoot, "unknown.yaml"), document: evidence },
      { kind: "gate", file: join(temporaryRoot, "g0.yaml"), document: gate },
    ]);
    hasIssue(issues, "passed its resolution Gate G0");

    evidence.unknown_handling.resolution_gate = "G1";
    const p1Issues = globalSpecificationIssues(temporaryRoot, [
        { kind: "evidence", file: join(temporaryRoot, "unknown.yaml"), document: evidence },
        { kind: "gate", file: join(temporaryRoot, "g0.yaml"), document: gate },
      ]);
    lacksIssue(p1Issues, "passed its resolution Gate");
    lacksIssue(p1Issues, "cannot remain unknown at a go Gate");

    evidence.priority = "P0";
    gate.feature_evidence.p0_total = 1;
    hasIssue(
      globalSpecificationIssues(temporaryRoot, [
        { kind: "evidence", file: join(temporaryRoot, "unknown.yaml"), document: evidence },
        { kind: "gate", file: join(temporaryRoot, "g0.yaml"), document: gate },
      ]),
      "P0 evidence EV-GATE-0001 cannot remain unknown at a go Gate",
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("state oracle closes references and command permissions", () => {
  const document = {
    states: [
      { state_id: "state.draft", initial: true },
      { state_id: "state.done", initial: false },
    ],
    commands: [{ command_id: "command.finish", permission_ids: ["permission.finish"] }],
    transitions: [
      {
        transition_id: "transition.finish",
        from_state_ids: ["state.missing"],
        to_state_id: "state.done",
        command_id: "command.finish",
        permission_ids: ["permission.admin"],
      },
    ],
    illegal_transitions: [
      {
        assertion_id: "assertion.no-reopen",
        from_state_ids: ["state.done"],
        command_id: "command.missing",
      },
    ],
    invariants: [],
    review: { status: "pending" },
  };
  const issues = validateSemantics("state", document);
  hasIssue(issues, "unresolved reference state.missing");
  hasIssue(issues, "permissions must equal the command permission set");
  hasIssue(issues, "unresolved reference command.missing");
});

test("state oracle rejects terminal transitions and legal-illegal overlap", () => {
  const issues = validateSemantics("state", {
    source_evidence_ids: [],
    states: [{ state_id: "STATE-DONE", initial: true, terminal: true }],
    commands: [
      {
        command_id: "COMMAND-REOPEN",
        actor_types: [],
        permission_ids: ["PERMISSION-REOPEN"],
      },
    ],
    transitions: [
      {
        transition_id: "TRANSITION-REOPEN",
        from_state_ids: ["STATE-DONE"],
        to_state_id: "STATE-DONE",
        command_id: "COMMAND-REOPEN",
        permission_ids: [],
        guard_ids: [],
        evidence_ids: [],
        test_ids: [],
      },
    ],
    illegal_transitions: [
      {
        assertion_id: "ASSERTION-NO-REOPEN",
        from_state_ids: ["STATE-DONE"],
        command_id: "COMMAND-REOPEN",
        test_ids: [],
      },
    ],
    invariants: [],
    concurrency: { test_ids: [] },
    review: {
      status: "passed",
      author_role: "state_author",
      reviewer_roles: ["state_reviewer"],
      independent_review: true,
      reproduction_commands: ["verify"],
      artifact_refs: ["repo:artifact"],
    },
  });
  hasIssue(issues, "terminal state STATE-DONE cannot have a legal transition");
  hasIssue(issues, "pair is both legal and illegal");
  hasIssue(issues, "permissions must equal the command permission set");
  hasIssue(issues, "passed table needs guards, evidence, and tests");
});

test("guard oracle rejects dangling and conflicting authorization policies", () => {
  const document = {
    actor_types: [{ type_id: "actor.staff" }],
    resource_types: [{ type_id: "resource.invoice" }],
    permissions: [
      {
        permission_id: "permission.refund",
        resource_type_id: "resource.invoice",
        high_risk: true,
      },
    ],
    guards: [{ guard_id: "guard.owner" }],
    role_presets: [{ role_id: "role.agent", permission_ids: ["permission.missing"] }],
    matrix: [
      {
        entry_id: "entry.allow",
        actor_type_id: "actor.staff",
        resource_type_id: "resource.invoice",
        permission_id: "permission.refund",
        scope_rule: "own",
        guard_ids: ["guard.owner"],
      },
      {
        entry_id: "entry.deny",
        actor_type_id: "actor.staff",
        resource_type_id: "resource.invoice",
        permission_id: "permission.refund",
        scope_rule: "own",
        guard_ids: ["guard.owner"],
      },
    ],
    state_combinations: [],
    high_risk_actions: [],
    review: {
      status: "passed",
      author_role: "ledger_author",
      reviewer_roles: ["ledger_reviewer"],
      independent_review: true,
      reproduction_commands: ["verify"],
      artifact_refs: ["repo:artifact"],
    },
  };
  const issues = validateSemantics("guard", document);
  hasIssue(issues, "unresolved reference permission.missing");
  hasIssue(issues, "duplicate authorization tuple");
  hasIssue(issues, "high-risk permission needs one action policy");
});

test("ledger oracle closes posting, account, invariant, and vector references", () => {
  const document = {
    accounts: [{ account_id: "account.cash", code: "1000" }],
    rounding_rules: [{ rounding_rule_id: "round.currency" }],
    derived_amounts: [],
    posting_rules: [
      {
        posting_rule_id: "posting.capture",
        rounding_rule_id: "round.currency",
        lines: [{ line_id: "line.debit", account_id: "account.missing" }],
        balance_invariant_ids: ["invariant.projection"],
        reversal: { follow_up_posting_rule_ids: ["posting.missing"] },
      },
    ],
    manual_command_rules: [],
    invariants: [{ invariant_id: "invariant.projection", kind: "projection" }],
    concurrency_controls: [],
    golden_vector_refs: [
      {
        vector_id: "vector.capture",
        covered_posting_rule_ids: ["posting.missing"],
        expected_invariant_ids: ["invariant.missing"],
      },
    ],
    review: {
      status: "passed",
      author_role: "ledger_author",
      reviewer_roles: ["ledger_reviewer"],
      independent_review: true,
      reproduction_commands: ["verify"],
      artifact_refs: ["repo:artifact"],
    },
  };
  const issues = validateSemantics("ledger", document);
  hasIssue(issues, "unresolved reference account.missing");
  hasIssue(issues, "journal_balance invariant");
  hasIssue(issues, "unresolved reference posting.missing");
  hasIssue(issues, "unresolved reference invariant.missing");
  hasIssue(issues, "posting rule needs a golden vector");
  hasIssue(issues, "line.debit.amount_id");
});

test("Gate oracle rejects arithmetic, sequencing, and false-go claims", () => {
  const document = {
    gate: "G2",
    feature_evidence: {
      total: 2,
      classified: 3,
      frozen_total: 3,
      retained_total: 3,
      due_for_acceptance: 3,
      due_verified: 4,
      p0_total: 999,
      p0_unexplained: 1000,
      coverage_complete: true,
    },
    verification: {
      commands: [{ command_id: "verify.one", passed: true, artifact_refs: [] }],
      summary: { passed: 0, failed: 1, skipped: 0 },
    },
    reviews: {
      red_team: { passed: true, independent_of_authors: false },
    },
    recorded_at: "2026-07-18T00:00:00Z",
    security: {
      accepted_risks: [
        {
          risk_id: "risk.high",
          severity: "high",
          due_at: "2026-08-20T00:00:00Z",
          expires_at: "2030-01-01T00:00:00Z",
        },
      ],
    },
    decision: {
      outcome: "go",
      incomplete_items: [{ item_id: "incomplete.one" }],
      next_gate: "G9",
    },
  };
  const issues = validateSemantics("gate", document);
  hasIssue(issues, "classified cannot exceed total");
  hasIssue(issues, "frozen_total cannot exceed total");
  hasIssue(issues, "due_verified cannot exceed due_for_acceptance");
  hasIssue(issues, "p0_unexplained cannot exceed p0_total");
  hasIssue(issues, "p0_total cannot exceed total");
  hasIssue(issues, "counts must equal command results");
  hasIssue(issues, "passing command needs an artifact");
  hasIssue(issues, "high-risk acceptance exceeds 30 days");
  hasIssue(issues, "G2 must point to G3");
  hasIssue(issues, "go cannot contain incomplete items");
  hasIssue(issues, "requires an independent passing review");
});

test("G0 go requires every mandatory oracle category to be present, passed, and frozen", () => {
  const missingManifest = globalGate("1".repeat(40));
  delete missingManifest.g0_oracles;
  hasIssue(
    validateSemantics("gate", missingManifest),
    "G0 go requires at least one oracle document",
  );

  const temporaryRoot = mkdtempSync(join(tmpdir(), "oss-g0-oracles-"));
  try {
    const oracleRecords = writeG0OracleFixture(temporaryRoot);
    oracleRecords[0].document.review.status = "pending";
    const issues = globalSpecificationIssues(temporaryRoot, [
      {
        kind: "evidence",
        file: join(temporaryRoot, "evidence.yaml"),
        document: globalEvidence(),
      },
      {
        kind: "gate",
        file: join(temporaryRoot, "g0.yaml"),
        document: globalGate("1".repeat(40)),
      },
      ...oracleRecords,
    ]);
    hasIssue(
      issues,
      "state_transition_tables: passed/frozen counts do not match independently reviewed documents",
    );
    hasIssue(issues, "missing mandatory G0 coverage AGGREGATE-USER");

    oracleRecords[0].document.review.status = "passed";
    const transportRecord = oracleRecords.find(
      (record) => record.document.oracle_kind === "transport_contracts",
    );
    transportRecord.document.coverage_ids = transportRecord.document.coverage_ids.filter(
      (coverageId) => coverageId !== "COVERAGE-IDEMPOTENCY",
    );
    hasIssue(
      globalSpecificationIssues(temporaryRoot, [
        {
          kind: "evidence",
          file: join(temporaryRoot, "evidence.yaml"),
          document: globalEvidence(),
        },
        {
          kind: "gate",
          file: join(temporaryRoot, "g0.yaml"),
          document: globalGate("1".repeat(40)),
        },
        ...oracleRecords,
      ]),
      "missing mandatory G0 coverage COVERAGE-IDEMPOTENCY",
    );
    transportRecord.document.normative_artifacts[0] = {
      reference: "repo:docs/reviews/gate-evidence.txt",
      content_digest: byteDigest("evidence\n"),
    };
    hasIssue(
      globalSpecificationIssues(temporaryRoot, [
        {
          kind: "evidence",
          file: join(temporaryRoot, "evidence.yaml"),
          document: globalEvidence(),
        },
        {
          kind: "gate",
          file: join(temporaryRoot, "g0.yaml"),
          document: globalGate("1".repeat(40)),
        },
        ...oracleRecords,
      ]),
      "transport_contracts artifact must use docs/contracts/transport/",
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("expired high-risk acceptance automatically re-blocks a Gate", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "oss-gate-expired-risk-"));
  const document = {
    report_id: "gate.g0.expired",
    supersedes_report_id: null,
    gate: "G0",
    recorded_at: "2026-01-01T00:00:00Z",
    feature_evidence: {},
    verification: { commands: [], summary: {} },
    security: {
      accepted_risks: [
        {
          risk_id: "risk.expired",
          severity: "high",
          due_at: "2026-01-10T00:00:00Z",
          expires_at: "2026-01-20T00:00:00Z",
        },
      ],
    },
    decision: { outcome: "go", incomplete_items: [], next_gate: "G1" },
  };
  try {
    const issues = globalSpecificationIssues(temporaryRoot, [
      {
        kind: "gate",
        file: join(temporaryRoot, "docs/gates/reports/gate.g0.expired.yaml"),
        document,
      },
    ]);
    hasIssue(issues, "active high-risk acceptance has expired at validation time");
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("Gate reports reject independent active heads for the same Gate", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "oss-gate-heads-"));
  try {
    const first = {
      report_id: "gate.g0.head-a",
      supersedes_report_id: null,
      gate: "G0",
      recorded_at: "2026-07-18T00:00:00Z",
      feature_evidence: {},
      verification: { commands: [], summary: {} },
      security: { accepted_risks: [] },
      decision: { outcome: "no-go", incomplete_items: ["blocked"], next_gate: "G1" },
    };
    const second = {
      ...first,
      report_id: "gate.g0.head-b",
      recorded_at: "2026-07-18T00:01:00Z",
      decision: { outcome: "go", incomplete_items: [], next_gate: "G1" },
    };
    hasIssue(
      globalSpecificationIssues(temporaryRoot, [
        {
          kind: "gate",
          file: join(temporaryRoot, "docs/gates/reports/gate.g0.head-a.yaml"),
          document: first,
        },
        {
          kind: "gate",
          file: join(temporaryRoot, "docs/gates/reports/gate.g0.head-b.yaml"),
          document: second,
        },
      ]),
      "Gate G0 has 2 active report heads; amendments must form one chain",
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("Gate report files are immutable while a later amendment can retire an expired go", () => {
  const mutationRoot = mkdtempSync(join(tmpdir(), "oss-gate-history-"));
  const amendmentRoot = mkdtempSync(join(tmpdir(), "oss-gate-amendment-"));
  const report = (reportId, supersedesReportId, recordedAt, outcome, acceptedRisks = []) => ({
    report_id: reportId,
    supersedes_report_id: supersedesReportId,
    gate: "G0",
    recorded_at: recordedAt,
    release_identity: { source_commit: "0".repeat(40) },
    feature_evidence: {},
    verification: { commands: [], summary: {} },
    security: { accepted_risks: acceptedRisks },
    decision: {
      outcome,
      incomplete_items: outcome === "go" ? [] : ["superseded expired acceptance"],
      next_gate: "G1",
    },
  });
  try {
    initializeGit(mutationRoot);
    const original = report(
      "gate.g0.immutable",
      null,
      "2026-01-01T00:00:00Z",
      "no-go",
    );
    const originalPath = join(
      mutationRoot,
      "docs/gates/reports/gate.g0.immutable.yaml",
    );
    mkdirSync(dirname(originalPath), { recursive: true });
    writeFileSync(originalPath, YAML.stringify(original));
    commitAll(mutationRoot, "record immutable Gate report");

    const mutated = {
      ...original,
      decision: { outcome: "go", incomplete_items: [], next_gate: "G1" },
    };
    writeFileSync(originalPath, YAML.stringify(mutated));
    commitAll(mutationRoot, "attempt in-place Gate report mutation");
    hasIssue(
      globalSpecificationIssues(mutationRoot, [
        { kind: "gate", file: originalPath, document: mutated },
      ]),
      "committed Gate report is append-only and cannot change in place",
    );

    rmSync(originalPath);
    commitAll(mutationRoot, "attempt Gate report deletion");
    hasIssue(
      globalSpecificationIssues(mutationRoot, []),
      "committed Gate report cannot be removed or renamed",
    );

    initializeGit(amendmentRoot);
    const expired = report(
      "gate.g0.expired-head",
      null,
      "2026-01-01T00:00:00Z",
      "go",
      [
        {
          risk_id: "risk.expired-head",
          severity: "high",
          due_at: "2026-01-10T00:00:00Z",
          expires_at: "2026-01-20T00:00:00Z",
        },
      ],
    );
    const expiredPath = join(
      amendmentRoot,
      "docs/gates/reports/gate.g0.expired-head.yaml",
    );
    mkdirSync(dirname(expiredPath), { recursive: true });
    writeFileSync(expiredPath, YAML.stringify(expired));
    commitAll(amendmentRoot, "record expired go");

    const amendment = report(
      "gate.g0.expired-head.amendment-1",
      expired.report_id,
      "2026-07-18T00:00:00Z",
      "no-go",
    );
    const amendmentPath = join(
      amendmentRoot,
      "docs/gates/reports/gate.g0.expired-head.amendment-1.yaml",
    );
    writeFileSync(amendmentPath, YAML.stringify(amendment));
    commitAll(amendmentRoot, "retire expired go with append-only amendment");
    const amendmentIssues = globalSpecificationIssues(amendmentRoot, [
      { kind: "gate", file: expiredPath, document: expired },
      { kind: "gate", file: amendmentPath, document: amendment },
    ]);
    lacksIssue(amendmentIssues, "active high-risk acceptance has expired at validation time");
    lacksIssue(amendmentIssues, "active report heads");
    lacksIssue(amendmentIssues, "committed Gate report is append-only");
  } finally {
    rmSync(mutationRoot, { recursive: true, force: true });
    rmSync(amendmentRoot, { recursive: true, force: true });
  }
});

test("future-dated reports cannot create long-lived high-risk acceptances", () => {
  const issues = validateSemantics("gate", {
    gate: "G0",
    recorded_at: "2100-01-01T00:00:00Z",
    feature_evidence: {},
    verification: { commands: [], summary: {} },
    security: {
      accepted_risks: [
        {
          risk_id: "risk.future",
          severity: "high",
          due_at: "2100-01-10T00:00:00Z",
          expires_at: "2100-01-30T00:00:00Z",
        },
      ],
    },
    decision: { outcome: "no-go", incomplete_items: [], next_gate: "G1" },
  });
  hasIssue(issues, "report time is too far in the future");
});

test("a go report cannot skip predecessor Gates", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "oss-gate-sequence-"));
  try {
    const gate = globalGate("0".repeat(40));
    gate.gate = "G9";
    const issues = globalSpecificationIssues(temporaryRoot, [
      {
        kind: "evidence",
        file: join(temporaryRoot, "evidence.yaml"),
        document: globalEvidence(),
      },
      { kind: "gate", file: join(temporaryRoot, "g9.yaml"), document: gate },
    ]);
    hasIssue(issues, "Gate G9 go is missing predecessor G0 go");
    hasIssue(issues, "Gate G9 go is missing predecessor G8 go");
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("frozen evidence digest is deterministic and author/reviewer roles stay distinct", () => {
  const document = YAML.parse(
    readFileSync(resolve(ROOT, "docs/provenance/evidence-card.template.yaml"), "utf8"),
  );
  document.sources[0].verification_status = "frozen";
  document.sources[0].content_digest = `sha256:${"0".repeat(64)}`;
  hasIssue(validateDocument("evidence", document), "frozen source digest cannot be a placeholder");

  document.sources[0].verification_status = "verified";
  document.sources[0].observed_at = "2026-07-18T00:00:00Z";
  document.sources[0].content_digest = `sha256:${"1".repeat(64)}`;
  document.review = {
    author_role: "evidence_author",
    reviewer_roles: ["evidence_reviewer"],
    independent_review: true,
    status: "passed",
    reproduction_commands: ["node tools/validate-specifications.mjs"],
    evidence_refs: ["repo:docs/reviews/evidence-review.txt"],
    findings: [],
  };
  document.lifecycle.status = "frozen";
  document.lifecycle.content_digest = contentDigest(document, ["lifecycle", "content_digest"]);
  assert.deepEqual(validateDocument("evidence", document), []);

  document.review.reviewer_roles = ["evidence_author"];
  hasIssue(validateDocument("evidence", document), "author role cannot also be a reviewer role");
});

test("unknown normative documents fail closed", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "oss-spec-policy-"));
  try {
    cpSync(resolve(ROOT, "docs"), join(temporaryRoot, "docs"), { recursive: true });
    cpSync(resolve(ROOT, ".github"), join(temporaryRoot, ".github"), { recursive: true });
    writeFileSync(
      join(temporaryRoot, "docs/specifications/evading-document.yaml"),
      "schema_version: 1\nkind_typo: state\n",
    );
    hasIssue(validateRepository(temporaryRoot), "unrecognized normative document");
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("template-like filenames cannot bypass global duplicate detection", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "oss-template-policy-"));
  try {
    cpSync(resolve(ROOT, "docs"), join(temporaryRoot, "docs"), { recursive: true });
    cpSync(resolve(ROOT, ".github"), join(temporaryRoot, ".github"), { recursive: true });
    const template = readFileSync(
      resolve(ROOT, "docs/provenance/evidence-card.template.yaml"),
      "utf8",
    );
    writeFileSync(join(temporaryRoot, "docs/provenance/hidden-a.template.yaml"), template);
    writeFileSync(join(temporaryRoot, "docs/provenance/hidden-b.template.yaml"), template);
    hasIssue(validateRepository(temporaryRoot), "globally duplicate id EV-TEMPLATE-0001");
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("canonical template paths are excluded only while their records remain fail closed", () => {
  hasIssue(
    globalSpecificationIssues(ROOT, [
      {
        kind: "evidence",
        file: resolve(ROOT, "docs/provenance/evidence-card.template.yaml"),
        document: globalEvidence(),
      },
    ]),
    "canonical template must remain an exact fail-closed evidence template",
  );
  hasIssue(
    globalSpecificationIssues(ROOT, [
      {
        kind: "gate",
        file: resolve(ROOT, "docs/gates/gate-exit-report.template.yaml"),
        document: globalGate("0".repeat(40)),
      },
    ]),
    "canonical template must remain an exact fail-closed gate template",
  );
});

test("superseded evidence requires one frozen successor and an acyclic stable-feature chain", () => {
  const malicious = YAML.parse(
    readFileSync(resolve(ROOT, "docs/provenance/evidence-card.template.yaml"), "utf8"),
  );
  malicious.lifecycle.status = "superseded";
  hasIssue(validateDocument("evidence", malicious), "superseded evidence needs a passed review");

  const temporaryRoot = mkdtempSync(join(tmpdir(), "oss-supersession-policy-"));
  try {
    copyGoalTrustAnchors(temporaryRoot);
    const predecessor = globalEvidence({
      evidence_id: "EV-SUPERSEDED-0001",
      feature_id: "FEATURE-SUPERSESSION-0001",
      lifecycle: {
        status: "superseded",
        goal_scope: "current_goal",
        first_gate: "G0",
        acceptance_gate: "G9",
        supersedes: null,
      },
    });
    const predecessorRecord = {
      kind: "evidence",
      file: join(temporaryRoot, "predecessor.yaml"),
      document: predecessor,
    };
    hasIssue(
      globalSpecificationIssues(temporaryRoot, [predecessorRecord]),
      "superseded evidence needs exactly one direct successor; found 0",
    );

    const successor = globalEvidence({
      evidence_id: "EV-SUCCESSOR-0001",
      feature_id: "FEATURE-SUPERSESSION-0001",
      lifecycle: {
        status: "frozen",
        goal_scope: "current_goal",
        first_gate: "G0",
        acceptance_gate: "G9",
        supersedes: "EV-SUPERSEDED-0001",
      },
    });
    assert.deepEqual(
      globalSpecificationIssues(temporaryRoot, [
        predecessorRecord,
        {
          kind: "evidence",
          file: join(temporaryRoot, "successor.yaml"),
          document: successor,
        },
      ]),
      [],
    );

    const cycleA = {
      ...predecessor,
      evidence_id: "EV-CYCLE-A-0001",
      lifecycle: { ...predecessor.lifecycle, supersedes: "EV-CYCLE-B-0001" },
    };
    const cycleB = {
      ...predecessor,
      evidence_id: "EV-CYCLE-B-0001",
      lifecycle: { ...predecessor.lifecycle, supersedes: "EV-CYCLE-A-0001" },
    };
    hasIssue(
      globalSpecificationIssues(temporaryRoot, [
        { kind: "evidence", file: join(temporaryRoot, "cycle-a.yaml"), document: cycleA },
        { kind: "evidence", file: join(temporaryRoot, "cycle-b.yaml"), document: cycleB },
      ]),
      "supersession graph contains a cycle",
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("frozen evidence decisions are append-only in Git history", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "oss-evidence-history-"));
  try {
    copyGoalTrustAnchors(temporaryRoot);
    initializeGit(temporaryRoot);
    const cardPath = join(
      temporaryRoot,
      "docs/provenance/cards/EV-HISTORY-0001.yaml",
    );
    mkdirSync(dirname(cardPath), { recursive: true });
    const original = globalEvidence({
      evidence_id: "EV-HISTORY-0001",
      feature_id: "FEATURE-HISTORY-0001",
      title: "Original frozen behavior",
      business_description: "The independently reviewed behavior.",
      traceability: {},
    });
    writeFileSync(cardPath, YAML.stringify(original));
    commitAll(temporaryRoot, "freeze evidence");
    const record = { kind: "evidence", file: cardPath, document: original };
    assert.deepEqual(globalSpecificationIssues(temporaryRoot, [record]), []);

    const advanced = {
      ...original,
      traceability: { implementation_refs: ["repo:src/implementation.ts"] },
      lifecycle: { ...original.lifecycle, status: "implemented" },
    };
    writeFileSync(cardPath, YAML.stringify(advanced));
    commitAll(temporaryRoot, "record implementation evidence");
    lacksIssue(
      globalSpecificationIssues(temporaryRoot, [{ ...record, document: advanced }]),
      "frozen evidence decision changed in place",
    );

    const downgraded = {
      ...advanced,
      lifecycle: { ...advanced.lifecycle, status: "draft" },
    };
    writeFileSync(cardPath, YAML.stringify(downgraded));
    commitAll(temporaryRoot, "attempt lifecycle downgrade");
    hasIssue(
      globalSpecificationIssues(temporaryRoot, [{ ...record, document: downgraded }]),
      "frozen evidence cannot return to draft status",
    );

    writeFileSync(cardPath, YAML.stringify(advanced));
    commitAll(temporaryRoot, "restore frozen lifecycle");
    hasIssue(
      globalSpecificationIssues(temporaryRoot, [{ ...record, document: advanced }]),
      "frozen evidence history contains a deletion or draft downgrade",
    );

    const rewritten = { ...advanced, title: "Silently rewritten behavior" };
    writeFileSync(cardPath, YAML.stringify(rewritten));
    commitAll(temporaryRoot, "attempt in-place rewrite");
    hasIssue(
      globalSpecificationIssues(temporaryRoot, [{ ...record, document: rewritten }]),
      "frozen evidence decision changed in place; create a successor card instead",
    );

    writeFileSync(cardPath, YAML.stringify(advanced));
    commitAll(temporaryRoot, "attempt to hide rewrite by restoring original behavior");
    hasIssue(
      globalSpecificationIssues(temporaryRoot, [{ ...record, document: advanced }]),
      "frozen evidence history contains an in-place decision rewrite",
    );

    rmSync(cardPath);
    commitAll(temporaryRoot, "attempt frozen evidence deletion");
    hasIssue(
      globalSpecificationIssues(temporaryRoot, []),
      "frozen evidence cannot be removed or renamed",
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("frozen evidence source verification cannot be downgraded in Git history", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "oss-source-history-"));
  try {
    initializeGit(temporaryRoot);
    const cardPath = join(
      temporaryRoot,
      "docs/provenance/cards/EV-SOURCE-HISTORY-0001.yaml",
    );
    mkdirSync(dirname(cardPath), { recursive: true });
    const verified = globalEvidence({
      evidence_id: "EV-SOURCE-HISTORY-0001",
      feature_id: "FEATURE-SOURCE-HISTORY-0001",
      sources: [
        {
          ...globalEvidence().sources[0],
          verification_status: "verified",
          observed_at: "2026-07-18T00:00:00Z",
        },
      ],
    });
    writeFileSync(cardPath, YAML.stringify(verified));
    commitAll(temporaryRoot, "freeze verified source");

    const { observed_at: _observedAt, ...downgradedSource } = verified.sources[0];
    const downgraded = {
      ...verified,
      sources: [{ ...downgradedSource, verification_status: "unknown" }],
    };
    writeFileSync(cardPath, YAML.stringify(downgraded));
    commitAll(temporaryRoot, "attempt source verification downgrade");
    hasIssue(
      globalSpecificationIssues(temporaryRoot, [
        { kind: "evidence", file: cardPath, document: downgraded },
      ]),
      "source SRC-GOAL-0001 verification cannot regress from verified to unknown",
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("duplicate JSON keys are rejected before schema or digest validation", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "oss-json-policy-"));
  try {
    cpSync(resolve(ROOT, "docs"), join(temporaryRoot, "docs"), { recursive: true });
    cpSync(resolve(ROOT, ".github"), join(temporaryRoot, ".github"), { recursive: true });
    writeFileSync(
      join(temporaryRoot, "docs/provenance/duplicate-same.json"),
      '{"$schema":"./evidence-card.schema.json","$schema":"./evidence-card.schema.json"}\n',
    );
    writeFileSync(
      join(temporaryRoot, "docs/provenance/duplicate-different.json"),
      '{"$schema":"./evidence-card.schema.json","$schema":"./state-transition-table.schema.json"}\n',
    );
    const issues = validateRepository(temporaryRoot);
    assert.equal(issues.filter((issue) => issue.includes("Map keys must be unique")).length, 2);

    const schemaPath = join(temporaryRoot, "docs/provenance/evidence-card.schema.json");
    const schema = readFileSync(schemaPath, "utf8");
    writeFileSync(
      schemaPath,
      schema.replace("{\n", '{\n  "$comment": "first",\n  "$comment": "second",\n'),
    );
    hasIssue(validateRepository(temporaryRoot), "schema load error: Map keys must be unique");
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("GitHub policy parses YAML keys and rejects mutable actions and privileged events", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "oss-workflow-policy-"));
  try {
    cpSync(resolve(ROOT, "docs"), join(temporaryRoot, "docs"), { recursive: true });
    cpSync(resolve(ROOT, "package.json"), join(temporaryRoot, "package.json"));
    mkdirSync(join(temporaryRoot, ".github/workflows"), { recursive: true });
    cpSync(
      resolve(ROOT, ".github/workflows/bootstrap-policy.yml"),
      join(temporaryRoot, ".github/workflows/bootstrap-policy.yml"),
    );
    writeFileSync(
      join(temporaryRoot, ".github/workflows/hostile.yml"),
      [
        "name: hostile",
        '"on": [workflow_run, pull_request_target]',
        "permissions: { contents: read }",
        "jobs:",
        "  hostile:",
        "    runs-on: self-hosted",
        "    if: '${{ false }}'",
        "    continue-on-error: true",
        "    environment: production",
        "    env:",
        "      DEPLOY_TOKEN: '${{ secrets.DEPLOY_TOKEN }}'",
        "    container: node:latest",
        "    services:",
        "      db:",
        "        image: postgres:latest",
        "    steps:",
        "      - uses : attacker/example@main",
        "        continue-on-error: '${{ always() }}'",
        "",
      ].join("\n"),
    );
    mkdirSync(join(temporaryRoot, ".github/actions/hostile-remote"), { recursive: true });
    writeFileSync(
      join(temporaryRoot, ".github/actions/hostile-remote/action.yml"),
      "name: hostile\ndescription: hostile\nruns:\n  using: docker\n  image: docker://alpine:latest\n",
    );
    mkdirSync(join(temporaryRoot, ".github/actions/hostile-local"), { recursive: true });
    writeFileSync(
      join(temporaryRoot, ".github/actions/hostile-local/action.yml"),
      "name: hostile\ndescription: hostile\nruns:\n  using: docker\n  image: Dockerfile\n",
    );
    const bootstrapPath = join(temporaryRoot, ".github/workflows/bootstrap-policy.yml");
    writeFileSync(
      bootstrapPath,
      readFileSync(bootstrapPath, "utf8").replace(
        "run: node tools/validate-specifications.mjs",
        "run: |\n          exit 0\n          node tools/validate-specifications.mjs",
      ),
    );
    const packageDocument = JSON.parse(
      readFileSync(join(temporaryRoot, "package.json"), "utf8"),
    );
    packageDocument.scripts.check = "true";
    packageDocument.scripts.precheck = "true";
    writeFileSync(
      join(temporaryRoot, "package.json"),
      `${JSON.stringify(packageDocument, null, 2)}\n`,
    );
    mkdirSync(join(temporaryRoot, "ci/escape"), { recursive: true });
    writeFileSync(
      join(temporaryRoot, "ci/escape/action.yml"),
      "name: escape\ndescription: escape\nruns:\n  using: composite\n  steps:\n    - uses: attacker/example@main\n",
    );
    writeFileSync(
      join(temporaryRoot, ".github/workflows/local-escape.yml"),
      [
        "name: local escape",
        '"on": [pull_request]',
        "permissions: { contents: read }",
        "jobs:",
        "  check:",
        "    runs-on: ubuntu-24.04",
        "    steps:",
        "      - uses: ./ci/escape",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(temporaryRoot, ".github/workflows/trusted-secret.yml"),
      [
        "name: trusted secret",
        '"on": [workflow_dispatch]',
        "permissions: read-all",
        "jobs:",
        "  leak:",
        "    runs-on: ubuntu-24.04",
        "    environment: production",
        "    env:",
        "      DEPLOY_TOKEN: '${{ secrets.DEPLOY_TOKEN }}'",
        "    steps:",
        "      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0",
        '      - run: test -n "$DEPLOY_TOKEN"',
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(temporaryRoot, ".github/workflows/trusted-github-token.yml"),
      [
        "name: trusted github token",
        '"on": [workflow_dispatch]',
        "permissions: { contents: read }",
        "jobs:",
        "  token:",
        "    runs-on: ubuntu-24.04",
        "    env:",
        "      IMPLICIT_TOKEN: '${{ github.token }}'",
        "    steps:",
        '      - run: test -n "$IMPLICIT_TOKEN"',
        "",
      ].join("\n"),
    );
    const issues = validateRepository(temporaryRoot);
    hasIssue(issues, "remote action must be pinned");
    hasIssue(issues, "pull_request_target is forbidden");
    hasIssue(issues, "workflow jobs must use an explicitly allowed GitHub-hosted runner");
    hasIssue(issues, "conditional workflow execution is fail-closed");
    hasIssue(issues, "must not reference repository secrets");
    hasIssue(issues, "untrusted-trigger workflow cannot use an environment");
    assert.equal(
      issues.filter((issue) => issue.includes("continue-on-error must be the literal false value"))
        .length,
      2,
    );
    hasIssue(issues, "hostile-remote/action.yml:runs.image: container image must be pinned");
    hasIssue(issues, "local Dockerfiles are not allowed");
    hasIssue(issues, "normalized bootstrap workflow must match the reviewed fail-closed structure");
    hasIssue(issues, "local actions must live under .github/actions/");
    hasIssue(issues, "bootstrap phase permits only bootstrap-policy.yml");
    hasIssue(issues, "bootstrap phase does not permit local actions");
    hasIssue(issues, "bootstrap workflows must not reference secrets or github.token");
    hasIssue(issues, "bootstrap workflows cannot use an environment");
    hasIssue(issues, "permissions must be an explicit read-only map");
    hasIssue(issues, "bootstrap scripts must remain exact and cannot add pre/post lifecycle aliases");
    assert.equal(
      issues.filter((issue) =>
        issue.includes("bootstrap workflows must not reference secrets or github.token"),
      ).length,
      3,
    );
    assert.equal(issues.filter((issue) => issue.includes("container image must be pinned")).length, 3);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("repository evidence references reject roots, directories, and symlink escapes", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "oss-reference-policy-"));
  const outsideFile = join(tmpdir(), `oss-reference-outside-${process.pid}.txt`);
  try {
    mkdirSync(join(temporaryRoot, "artifacts"));
    writeFileSync(outsideFile, "outside\n");
    symlinkSync(outsideFile, join(temporaryRoot, "artifacts/escape.txt"));
    const issues = repositoryReferenceIssues(
      temporaryRoot,
      ["repo:.", "repo:artifacts", "repo:artifacts/escape.txt"],
      "artifact",
      true,
    );
    assert.equal(issues.length, 3);
    hasIssue(issues, "regular in-repository file");
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
    rmSync(outsideFile, { force: true });
  }
});

test("trusted ledger runner gate applies to ledger reviews, not state reviews", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "oss-runner-policy-"));
  try {
    mkdirSync(join(temporaryRoot, "tools"), { recursive: true });
    const stateIssues = globalSpecificationIssues(temporaryRoot, [
      {
        kind: "state",
        file: join(temporaryRoot, "state.yaml"),
        document: {
          review: { status: "passed" },
          source_evidence_ids: [],
          commands: [],
          transitions: [],
        },
      },
    ]);
    assert.ok(!stateIssues.some((issue) => issue.includes("golden_runner")));

    const ledgerIssues = globalSpecificationIssues(temporaryRoot, [
      {
        kind: "ledger",
        file: join(temporaryRoot, "ledger.yaml"),
        document: {
          review: { status: "passed" },
          source_evidence_ids: [],
          posting_rules: [],
          manual_command_rules: [],
          golden_vector_refs: [],
          golden_runner: { command: "node attacker.mjs", artifacts: [] },
        },
      },
    ]);
    hasIssue(ledgerIssues, "trusted exact-ledger executable is missing");
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("comment-only ledger runner and fabricated attestation cannot satisfy a passed review", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "oss-runner-noop-"));
  try {
    mkdirSync(join(temporaryRoot, "docs/reviews"), { recursive: true });
    writeFileSync(join(temporaryRoot, "docs/reviews/gate-evidence.txt"), "evidence\n");
    const records = writeG0OracleFixture(temporaryRoot);
    const ledgerRecord = records.find((record) => record.kind === "ledger");
    const runnerPath = join(temporaryRoot, "tools/run-ledger-golden-vectors.mjs");
    const forgedAttestationPath = join(temporaryRoot, "docs/reviews/ledger-attestation.json");
    writeFileSync(runnerPath, "// no-op runner that exits successfully\n");
    writeFileSync(forgedAttestationPath, '{"passed":true}\n');
    ledgerRecord.document.golden_runner.executable.content_digest = byteDigest(
      readFileSync(runnerPath),
    );
    ledgerRecord.document.golden_runner.attestation.content_digest = byteDigest(
      readFileSync(forgedAttestationPath),
    );
    writeFileSync(ledgerRecord.file, `${JSON.stringify(ledgerRecord.document, null, 2)}\n`);
    const issues = globalSpecificationIssues(temporaryRoot, [
      {
        kind: "evidence",
        file: join(temporaryRoot, "docs/provenance/cards/EV-GATE-0001.yaml"),
        document: globalEvidence(),
      },
      ...records,
    ]);
    hasIssue(issues, "source is not the reviewed trust-anchor runner");
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("Gate report binds a single-parent evidence commit and its captured repository artifacts", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "oss-gate-git-positive-"));
  try {
    initializeGit(temporaryRoot);
    mkdirSync(join(temporaryRoot, "src"), { recursive: true });
    writeFileSync(join(temporaryRoot, "src/subject.txt"), "audited subject\n");
    const evidenceDocument = frozenEvidenceFixture();
    const evidencePath = join(
      temporaryRoot,
      "docs/provenance/cards/EV-GATE-0001.yaml",
    );
    mkdirSync(dirname(evidencePath), { recursive: true });
    writeFileSync(evidencePath, YAML.stringify(evidenceDocument));
    const oracleRecords = writeG0OracleFixture(temporaryRoot);
    const subjectCommit = commitAll(temporaryRoot, "subject");

    mkdirSync(join(temporaryRoot, "docs/gates/reports"), { recursive: true });
    mkdirSync(join(temporaryRoot, "docs/reviews"), { recursive: true });
    const reportPath = join(temporaryRoot, "docs/gates/reports/gate.g0.fixture.yaml");
    writeFileSync(reportPath, "report: captured\n");
    writeFileSync(join(temporaryRoot, "docs/reviews/gate-evidence.txt"), "evidence\n");
    commitAll(temporaryRoot, "gate evidence");

    const records = [
      {
        kind: "evidence",
        file: evidencePath,
        document: evidenceDocument,
      },
      { kind: "gate", file: reportPath, document: globalGate(subjectCommit) },
      ...oracleRecords,
    ];
    assert.deepEqual(globalSpecificationIssues(temporaryRoot, records), []);

    writeFileSync(oracleRecords[0].file, "retroactively replaced oracle\n");
    hasIssue(
      globalSpecificationIssues(temporaryRoot, records),
      "validated document bytes do not match the report commit blob",
    );
    writeFileSync(oracleRecords[0].file, YAML.stringify(oracleRecords[0].document));

    writeFileSync(join(temporaryRoot, "src/subject.txt"), "audited subject for G1\n");
    const g1SubjectCommit = commitAll(temporaryRoot, "G1 subject");
    const g1ReportPath = join(temporaryRoot, "docs/gates/reports/gate.g1.fixture.yaml");
    writeFileSync(g1ReportPath, "report: G1 captured\n");
    commitAll(temporaryRoot, "G1 gate evidence");
    const g1Gate = globalGate(g1SubjectCommit);
    g1Gate.gate = "G1";
    g1Gate.report_id = "gate.g1.fixture";
    assert.deepEqual(
      globalSpecificationIssues(temporaryRoot, [
        ...records,
        { kind: "gate", file: g1ReportPath, document: g1Gate },
      ]),
      [],
    );

    records[1].document = globalGate("0".repeat(40));
    hasIssue(
      globalSpecificationIssues(temporaryRoot, records),
      "report must be in a dedicated evidence commit whose parent is the subject commit",
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("a later resolved successor cannot conceal unknown Evidence at the Gate report commit", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "oss-gate-historical-unknown-"));
  try {
    initializeGit(temporaryRoot);
    mkdirSync(join(temporaryRoot, "src"), { recursive: true });
    writeFileSync(join(temporaryRoot, "src/subject.txt"), "audited subject\n");

    const historicalUnknown = frozenEvidenceFixture();
    historicalUnknown.classification = {
      ...historicalUnknown.classification,
      status: "unknown",
      rationale: "Unresolved at the G0 report commit for the historical regression fixture.",
    };
    historicalUnknown.disposition = {
      targets: ["exclude"],
      module_ids: [],
      provider_capability_ids: [],
      configuration_keys: [],
      exclusion_assertion_ids: [],
    };
    historicalUnknown.unknown_handling = {
      owner_role: "evidence_owner",
      impact: "G0 cannot safely proceed while this fixture remains unknown.",
      fail_safe: "Keep the synthetic capability unavailable.",
      resolution_gate: "G0",
    };
    historicalUnknown.lifecycle.content_digest = contentDigest(
      historicalUnknown,
      ["lifecycle", "content_digest"],
    );
    const predecessorPath = join(
      temporaryRoot,
      "docs/provenance/cards/EV-GATE-0001.yaml",
    );
    mkdirSync(dirname(predecessorPath), { recursive: true });
    const historicalBytes = YAML.stringify(historicalUnknown);
    writeFileSync(predecessorPath, historicalBytes);

    const oracleRecords = writeG0OracleFixture(temporaryRoot);
    const subjectCommit = commitAll(temporaryRoot, "subject with unresolved Evidence");
    mkdirSync(join(temporaryRoot, "docs/gates/reports"), { recursive: true });
    const reportPath = join(
      temporaryRoot,
      "docs/gates/reports/gate.g0.fixture.yaml",
    );
    writeFileSync(reportPath, "report: captured unresolved evidence\n");
    writeFileSync(join(temporaryRoot, "docs/reviews/gate-evidence.txt"), "evidence\n");
    commitAll(temporaryRoot, "G0 evidence commit with unresolved card");

    const predecessor = {
      ...historicalUnknown,
      lifecycle: { ...historicalUnknown.lifecycle, status: "superseded" },
    };
    predecessor.lifecycle.content_digest = contentDigest(
      predecessor,
      ["lifecycle", "content_digest"],
    );
    writeFileSync(predecessorPath, YAML.stringify(predecessor));

    const successor = frozenEvidenceFixture();
    successor.evidence_id = "EV-GATE-0002";
    successor.sources[0].source_id = "SRC-GATE-0002";
    successor.title = "Resolved successor for historical unknown Evidence";
    successor.lifecycle.supersedes = predecessor.evidence_id;
    successor.lifecycle.content_digest = contentDigest(
      successor,
      ["lifecycle", "content_digest"],
    );
    const successorPath = join(
      temporaryRoot,
      "docs/provenance/cards/EV-GATE-0002.yaml",
    );
    writeFileSync(successorPath, YAML.stringify(successor));
    commitAll(temporaryRoot, "resolve Evidence with an append-only successor");

    const gate = globalGate(subjectCommit);
    gate.feature_evidence.retained_total = 0;
    gate.feature_evidence.card_artifacts[0].content_digest = byteDigest(historicalBytes);
    hasIssue(
      globalSpecificationIssues(temporaryRoot, [
        { kind: "evidence", file: predecessorPath, document: predecessor },
        { kind: "evidence", file: successorPath, document: successor },
        { kind: "gate", file: reportPath, document: gate },
        ...oracleRecords,
      ]),
      "report-commit evidence EV-GATE-0001 remained unresolved at G0",
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("Gate reports cannot be symlinks whose target changes after the evidence commit", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "oss-gate-symlink-"));
  try {
    initializeGit(temporaryRoot);
    mkdirSync(join(temporaryRoot, "src"), { recursive: true });
    writeFileSync(join(temporaryRoot, "src/subject.txt"), "audited subject\n");
    const subjectCommit = commitAll(temporaryRoot, "subject");

    mkdirSync(join(temporaryRoot, "docs/gates/reports"), { recursive: true });
    mkdirSync(join(temporaryRoot, "docs/reviews"), { recursive: true });
    const targetPath = join(temporaryRoot, "docs/reviews/g0-target.yaml");
    const reportPath = join(temporaryRoot, "docs/gates/reports/gate.g0.fixture.yaml");
    writeFileSync(targetPath, "report: original\n");
    writeFileSync(join(temporaryRoot, "docs/reviews/gate-evidence.txt"), "evidence\n");
    symlinkSync("../../reviews/g0-target.yaml", reportPath);
    commitAll(temporaryRoot, "gate evidence");
    writeFileSync(targetPath, "report: changed after acceptance\n");

    hasIssue(
      globalSpecificationIssues(temporaryRoot, [
        {
          kind: "evidence",
          file: join(temporaryRoot, "evidence.yaml"),
          document: globalEvidence(),
        },
        { kind: "gate", file: reportPath, document: globalGate(subjectCommit) },
      ]),
      "Gate report must be a regular non-symlink repository file",
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("Gate report rejects merge commits that smuggle subject changes", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "oss-gate-git-merge-"));
  try {
    initializeGit(temporaryRoot);
    mkdirSync(join(temporaryRoot, "src"), { recursive: true });
    writeFileSync(join(temporaryRoot, "src/subject.txt"), "audited subject\n");
    const subjectCommit = commitAll(temporaryRoot, "subject");

    git(temporaryRoot, ["checkout", "-b", "payload"]);
    writeFileSync(join(temporaryRoot, "src/malicious.txt"), "not evidence\n");
    commitAll(temporaryRoot, "payload");
    git(temporaryRoot, ["checkout", "main"]);
    git(temporaryRoot, ["merge", "--no-ff", "--no-commit", "payload"]);
    mkdirSync(join(temporaryRoot, "docs/gates/reports"), { recursive: true });
    mkdirSync(join(temporaryRoot, "docs/reviews"), { recursive: true });
    const reportPath = join(temporaryRoot, "docs/gates/reports/gate.g0.fixture.yaml");
    writeFileSync(reportPath, "report: merge\n");
    writeFileSync(join(temporaryRoot, "docs/reviews/gate-evidence.txt"), "evidence\n");
    commitAll(temporaryRoot, "merge gate evidence");

    const issues = globalSpecificationIssues(temporaryRoot, [
      {
        kind: "evidence",
        file: join(temporaryRoot, "evidence.yaml"),
        document: globalEvidence(),
      },
      { kind: "gate", file: reportPath, document: globalGate(subjectCommit) },
    ]);
    hasIssue(issues, "report must be in a dedicated evidence commit whose parent is the subject commit");
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("a later Gate subject must descend from the predecessor Gate report", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "oss-gate-git-order-"));
  try {
    initializeGit(temporaryRoot);
    mkdirSync(join(temporaryRoot, "src"), { recursive: true });
    writeFileSync(join(temporaryRoot, "src/subject.txt"), "G0 subject\n");
    const g0SubjectCommit = commitAll(temporaryRoot, "G0 subject");

    git(temporaryRoot, ["checkout", "-b", "early-g1"]);
    writeFileSync(join(temporaryRoot, "src/subject.txt"), "G1 subject too early\n");
    const g1SubjectCommit = commitAll(temporaryRoot, "early G1 subject");
    mkdirSync(join(temporaryRoot, "docs/gates/reports"), { recursive: true });
    mkdirSync(join(temporaryRoot, "docs/reviews"), { recursive: true });
    const g1ReportPath = join(temporaryRoot, "docs/gates/reports/gate.g1.fixture.yaml");
    writeFileSync(g1ReportPath, "report: early G1\n");
    writeFileSync(join(temporaryRoot, "docs/reviews/g1.txt"), "G1 evidence\n");
    commitAll(temporaryRoot, "early G1 evidence");

    git(temporaryRoot, ["checkout", "main"]);
    mkdirSync(join(temporaryRoot, "docs/gates/reports"), { recursive: true });
    mkdirSync(join(temporaryRoot, "docs/reviews"), { recursive: true });
    const g0ReportPath = join(temporaryRoot, "docs/gates/reports/gate.g0.fixture.yaml");
    writeFileSync(g0ReportPath, "report: G0\n");
    writeFileSync(join(temporaryRoot, "docs/reviews/g0.txt"), "G0 evidence\n");
    commitAll(temporaryRoot, "G0 evidence");
    git(temporaryRoot, [
      "-c",
      "commit.gpgsign=false",
      "merge",
      "--no-ff",
      "-m",
      "combine out-of-order Gates",
      "early-g1",
    ]);

    const g0Gate = globalGate(g0SubjectCommit, "repo:docs/reviews/g0.txt");
    const g1Gate = globalGate(g1SubjectCommit, "repo:docs/reviews/g1.txt");
    g1Gate.gate = "G1";
    g1Gate.report_id = "gate.g1.fixture";
    const issues = globalSpecificationIssues(temporaryRoot, [
      {
        kind: "evidence",
        file: join(temporaryRoot, "evidence.yaml"),
        document: globalEvidence(),
      },
      { kind: "gate", file: g0ReportPath, document: g0Gate },
      { kind: "gate", file: g1ReportPath, document: g1Gate },
    ]);
    hasIssue(issues, "Gate G1 subject must descend from the G0 report commit");
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("later commits cannot retroactively supply missing Gate artifacts", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "oss-gate-git-future-artifact-"));
  try {
    initializeGit(temporaryRoot);
    mkdirSync(join(temporaryRoot, "src"), { recursive: true });
    writeFileSync(join(temporaryRoot, "src/subject.txt"), "audited subject\n");
    const subjectCommit = commitAll(temporaryRoot, "subject");

    mkdirSync(join(temporaryRoot, "docs/gates/reports"), { recursive: true });
    const reportPath = join(temporaryRoot, "docs/gates/reports/gate.g0.fixture.yaml");
    writeFileSync(reportPath, "report: missing artifact\n");
    commitAll(temporaryRoot, "gate report without artifact");

    mkdirSync(join(temporaryRoot, "docs/reviews"), { recursive: true });
    writeFileSync(join(temporaryRoot, "docs/reviews/future.txt"), "too late\n");
    commitAll(temporaryRoot, "late artifact");

    const issues = globalSpecificationIssues(temporaryRoot, [
      {
        kind: "evidence",
        file: join(temporaryRoot, "evidence.yaml"),
        document: globalEvidence(),
      },
      {
        kind: "gate",
        file: reportPath,
        document: globalGate(subjectCommit, "repo:docs/reviews/future.txt"),
      },
    ]);
    hasIssue(issues, "repository evidence was not a regular file in report commit");
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
