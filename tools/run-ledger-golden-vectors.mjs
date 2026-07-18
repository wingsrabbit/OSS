// SPDX-License-Identifier: AGPL-3.0-or-later
// NOT FOR PRODUCTION — MOCK PROVIDERS ONLY

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PROTOCOL = "oss-ledger-exact/v1";
const ARTIFACT_SCHEMA =
  "https://opensales.system/schemas/ledger-golden-artifact.schema.json";
const STABLE_ID = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/;
const INTEGER = /^(?:0|-?[1-9][0-9]*)$/;
const NON_NEGATIVE_INTEGER = /^(?:0|[1-9][0-9]*)$/;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/;
const MAX_EXPRESSION_DEPTH = 32;
const MAX_EXPRESSION_NODES = 1024;

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

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function semanticDigest(matrix) {
  const copy = JSON.parse(JSON.stringify(matrix));
  delete copy.golden_runner;
  delete copy.review;
  return sha256(Buffer.from(canonicalJson(copy)));
}

function exactKeys(value, required, optional, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} has unknown field ${key}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new Error(`${label} is missing ${key}`);
  }
}

function uniqueBy(items, key, label) {
  if (!Array.isArray(items)) throw new Error(`${label} must be an array`);
  const seen = new Set();
  for (const item of items) {
    const id = item?.[key];
    if (seen.has(id)) throw new Error(`${label} contains duplicate ${key} ${id}`);
    seen.add(id);
  }
}

function strictDocument(bytes, extension, label) {
  if (extension !== ".json") throw new Error(`${label} must use canonical JSON`);
  const text = bytes.toString("utf8");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} parse failed: ${error.message}`);
  }
}

function repositoryFile(root, reference, label) {
  if (typeof reference !== "string" || !reference.startsWith("repo:")) {
    throw new Error(`${label} must be a repo: reference`);
  }
  const repositoryPath = reference.slice("repo:".length);
  const segments = repositoryPath.split("/");
  const target = resolve(root, repositoryPath);
  if (
    !repositoryPath ||
    repositoryPath.startsWith("/") ||
    repositoryPath.includes("\\") ||
    segments.includes("") ||
    segments.includes("..") ||
    target === root ||
    !target.startsWith(`${root}${sep}`) ||
    !existsSync(target)
  ) {
    throw new Error(`${label} is not a valid repository file`);
  }
  const metadata = lstatSync(target);
  const realTarget = realpathSync(target);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    (realTarget !== root && !realTarget.startsWith(`${root}${sep}`))
  ) {
    throw new Error(`${label} must resolve to a regular in-repository file`);
  }
  return { target, bytes: readFileSync(target) };
}

function sameAsset(values, label) {
  const assetIds = new Set(values.map((value) => value.asset_id));
  if (assetIds.size !== 1) throw new Error(`${label} mixes assets`);
  return values[0].asset_id;
}

function roundRatio(atoms, numerator, denominator, mode) {
  const product = atoms * numerator;
  const negative = product < 0n;
  const absolute = negative ? -product : product;
  const quotient = absolute / denominator;
  const remainder = absolute % denominator;
  let rounded = quotient;
  if (mode === "up" && remainder !== 0n) rounded += 1n;
  if (mode === "half_up" && remainder * 2n >= denominator) rounded += 1n;
  if (
    mode === "half_even" &&
    (remainder * 2n > denominator ||
      (remainder * 2n === denominator && quotient % 2n === 1n))
  ) {
    rounded += 1n;
  }
  if (!["down", "up", "half_up", "half_even"].includes(mode)) {
    throw new Error(`unsupported executable rounding mode ${mode}`);
  }
  return negative ? -rounded : rounded;
}

function evaluateExpression(expression, context, budget, depth = 0) {
  if (depth > MAX_EXPRESSION_DEPTH) throw new Error("expression depth exceeds limit");
  budget.nodes += 1;
  if (budget.nodes > MAX_EXPRESSION_NODES) throw new Error("expression node count exceeds limit");
  if (!expression || typeof expression !== "object" || Array.isArray(expression)) {
    throw new Error("expression must be an object");
  }
  const evaluate = (value) => evaluateExpression(value, context, budget, depth + 1);
  switch (expression.op) {
    case "input": {
      const value = context.inputs.get(expression.input_id);
      if (!value) throw new Error(`unresolved input ${expression.input_id}`);
      return value;
    }
    case "amount": {
      const value = context.amounts.get(expression.amount_id);
      if (!value) throw new Error(`unresolved amount ${expression.amount_id}`);
      return value;
    }
    case "sum": {
      const values = expression.values.map(evaluate);
      return {
        asset_id: sameAsset(values, "sum"),
        atoms: values.reduce((total, value) => total + value.atoms, 0n),
      };
    }
    case "subtract": {
      const left = evaluate(expression.left);
      const right = evaluate(expression.right);
      sameAsset([left, right], "subtract");
      return { asset_id: left.asset_id, atoms: left.atoms - right.atoms };
    }
    case "min":
    case "max": {
      const values = expression.values.map(evaluate);
      const assetId = sameAsset(values, expression.op);
      const atoms = values
        .map((value) => value.atoms)
        .reduce((selected, value) =>
          expression.op === "min"
            ? value < selected
              ? value
              : selected
            : value > selected
              ? value
              : selected,
        );
      return { asset_id: assetId, atoms };
    }
    case "clamp_min_zero": {
      const value = evaluate(expression.value);
      return { asset_id: value.asset_id, atoms: value.atoms < 0n ? 0n : value.atoms };
    }
    case "multiply_ratio_round": {
      const value = evaluate(expression.value);
      if (!NON_NEGATIVE_INTEGER.test(expression.numerator)) {
        throw new Error("ratio numerator must be a canonical non-negative integer string");
      }
      if (!POSITIVE_INTEGER.test(expression.denominator)) {
        throw new Error("ratio denominator must be a canonical positive integer string");
      }
      const rule = context.roundingRules.get(expression.rounding_rule_id);
      if (!rule) throw new Error(`unresolved rounding rule ${expression.rounding_rule_id}`);
      return {
        asset_id: value.asset_id,
        atoms: roundRatio(
          value.atoms,
          BigInt(expression.numerator),
          BigInt(expression.denominator),
          rule.mode,
        ),
      };
    }
    default:
      throw new Error(`unsupported expression operator ${expression.op}`);
  }
}

function evaluateAmounts(matrix, input) {
  const inputs = new Map();
  uniqueBy(input.inputs, "input_id", "input.inputs");
  for (const entry of input.inputs) {
    exactKeys(entry, ["input_id", "asset_id", "atoms"], [], `input ${entry?.input_id}`);
    if (!STABLE_ID.test(entry.input_id) || !STABLE_ID.test(entry.asset_id) || !INTEGER.test(entry.atoms)) {
      throw new Error(`input ${entry.input_id} is not canonical`);
    }
    inputs.set(entry.input_id, { asset_id: entry.asset_id, atoms: BigInt(entry.atoms) });
  }
  const roundingRules = new Map(matrix.rounding_rules.map((rule) => [rule.rounding_rule_id, rule]));
  for (const rule of roundingRules.values()) {
    if (rule.mode === "asset_defined") {
      throw new Error(`rounding rule ${rule.rounding_rule_id} must resolve to a concrete executable mode`);
    }
  }
  const amounts = new Map();
  const pending = new Map(matrix.derived_amounts.map((amount) => [amount.amount_id, amount]));
  while (pending.size > 0) {
    let progressed = false;
    let lastError;
    for (const [amountId, amount] of [...pending]) {
      try {
        const value = evaluateExpression(
          amount.formula,
          { inputs, amounts, roundingRules },
          { nodes: 0 },
        );
        amounts.set(amountId, value);
        pending.delete(amountId);
        progressed = true;
      } catch (error) {
        lastError = error;
      }
    }
    if (!progressed) {
      throw new Error(`amount graph is cyclic or unresolved: ${lastError?.message ?? "unknown error"}`);
    }
  }
  return amounts;
}

function publicAmount(amountId, value) {
  return { amount_id: amountId, asset_id: value.asset_id, atoms: value.atoms.toString() };
}

function runVector(root, matrix, vector) {
  const inputFile = repositoryFile(root, vector.input_fixture_ref, `${vector.vector_id} input`);
  const expectedFile = repositoryFile(
    root,
    vector.expected_postings_ref,
    `${vector.vector_id} expected`,
  );
  if (sha256(inputFile.bytes) !== vector.input_fixture_digest) {
    throw new Error(`${vector.vector_id} input digest mismatch`);
  }
  if (sha256(expectedFile.bytes) !== vector.expected_postings_digest) {
    throw new Error(`${vector.vector_id} expected digest mismatch`);
  }
  const input = strictDocument(inputFile.bytes, ".json", `${vector.vector_id} input`);
  const expected = strictDocument(expectedFile.bytes, ".json", `${vector.vector_id} expected`);
  exactKeys(
    input,
    ["$schema", "kind", "protocol", "matrix_id", "vector_id", "inputs", "evaluate_amount_ids", "posting_rule_ids"],
    [],
    `${vector.vector_id} input`,
  );
  if (
    input.$schema !== ARTIFACT_SCHEMA ||
    input.kind !== "input" ||
    input.protocol !== PROTOCOL ||
    input.matrix_id !== matrix.matrix_id ||
    input.vector_id !== vector.vector_id
  ) {
    throw new Error(`${vector.vector_id} input identity mismatch`);
  }
  if (canonicalJson(input.posting_rule_ids) !== canonicalJson(vector.covered_posting_rule_ids)) {
    throw new Error(`${vector.vector_id} input posting-rule set mismatch`);
  }
  uniqueBy(input.evaluate_amount_ids.map((amount_id) => ({ amount_id })), "amount_id", "evaluate_amount_ids");
  const amounts = evaluateAmounts(matrix, input);
  const amountRows = input.evaluate_amount_ids.map((amountId) => {
    const value = amounts.get(amountId);
    if (!value) throw new Error(`${vector.vector_id} requests unknown amount ${amountId}`);
    return publicAmount(amountId, value);
  });
  const postingRules = new Map(matrix.posting_rules.map((rule) => [rule.posting_rule_id, rule]));
  const journals = vector.covered_posting_rule_ids.map((postingRuleId) => {
    const rule = postingRules.get(postingRuleId);
    if (!rule) throw new Error(`${vector.vector_id} references unknown posting rule ${postingRuleId}`);
    const postings = rule.lines.map((line) => {
      const value = amounts.get(line.amount_id);
      if (!value) throw new Error(`${line.line_id} references unknown amount ${line.amount_id}`);
      if (value.atoms <= 0n) throw new Error(`${line.line_id} posting amount must be positive`);
      return {
        line_id: line.line_id,
        account_id: line.account_id,
        side: line.side,
        asset_id: value.asset_id,
        atoms: value.atoms.toString(),
      };
    });
    return { posting_rule_id: postingRuleId, postings };
  });
  const balanceChecks = journals.flatMap((journal) => {
    const assets = [...new Set(journal.postings.map((posting) => posting.asset_id))].sort();
    return assets.map((assetId) => {
      const relevant = journal.postings.filter((posting) => posting.asset_id === assetId);
      const debit = relevant
        .filter((posting) => posting.side === "debit")
        .reduce((sum, posting) => sum + BigInt(posting.atoms), 0n);
      const credit = relevant
        .filter((posting) => posting.side === "credit")
        .reduce((sum, posting) => sum + BigInt(posting.atoms), 0n);
      if (debit !== credit) {
        throw new Error(`${journal.posting_rule_id} is unbalanced for ${assetId}`);
      }
      return {
        posting_rule_id: journal.posting_rule_id,
        asset_id: assetId,
        debit_atoms: debit.toString(),
        credit_atoms: credit.toString(),
        balanced: true,
      };
    });
  });
  const actualExpected = {
    $schema: ARTIFACT_SCHEMA,
    kind: "expected",
    protocol: PROTOCOL,
    matrix_id: matrix.matrix_id,
    vector_id: vector.vector_id,
    amounts: amountRows,
    journals,
  };
  if (canonicalJson(actualExpected) !== canonicalJson(expected)) {
    throw new Error(`${vector.vector_id} actual amounts/postings do not match expected artifact`);
  }
  return {
    vector_id: vector.vector_id,
    vector_digest: vector.content_digest,
    input_digest: vector.input_fixture_digest,
    expected_digest: vector.expected_postings_digest,
    result: "passed",
    amounts: amountRows,
    journals,
    balance_checks: balanceChecks,
  };
}

export function runMatrix(rootArgument, matrixArgument) {
  const root = realpathSync(resolve(rootArgument));
  if (
    typeof matrixArgument !== "string" ||
    matrixArgument.startsWith("/") ||
    matrixArgument.includes("\\") ||
    matrixArgument.split("/").includes("..")
  ) {
    throw new Error("matrix path must be repository-relative");
  }
  const matrixPath = resolve(root, matrixArgument);
  if (matrixPath === root || !matrixPath.startsWith(`${root}${sep}`) || !existsSync(matrixPath)) {
    throw new Error("matrix path escapes or does not exist");
  }
  const metadata = lstatSync(matrixPath);
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error("matrix must be a regular file");
  if (extname(matrixPath) !== ".json") throw new Error("passed ledger matrix must use JSON");
  const matrix = strictDocument(readFileSync(matrixPath), extname(matrixPath), "ledger matrix");
  const runnerBytes = readFileSync(fileURLToPath(import.meta.url));
  const runnerDigest = sha256(runnerBytes);
  if (matrix.golden_runner.protocol !== PROTOCOL) {
    throw new Error("matrix runner protocol mismatch");
  }
  if (matrix.golden_runner.executable?.content_digest !== runnerDigest) {
    throw new Error("matrix runner source digest does not match executable bytes");
  }
  const vectors = matrix.golden_vector_refs.map((vector) => runVector(root, matrix, vector));
  return {
    $schema: ARTIFACT_SCHEMA,
    kind: "attestation",
    protocol: PROTOCOL,
    matrix_id: matrix.matrix_id,
    matrix_semantic_digest: semanticDigest(matrix),
    runner_digest: runnerDigest,
    vectors,
    summary: { total: vectors.length, passed: vectors.length, failed: 0 },
  };
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || values.has(key)) {
      throw new Error("arguments must be unique --key value pairs");
    }
    values.set(key, value);
  }
  if (values.get("--protocol") !== PROTOCOL || values.get("--format") !== "canonical-json") {
    throw new Error(`runner requires --protocol ${PROTOCOL} --format canonical-json`);
  }
  if (!values.has("--root") || !values.has("--matrix") || values.size !== 4) {
    throw new Error("runner requires --root and --matrix only");
  }
  return { root: values.get("--root"), matrix: values.get("--matrix") };
}

function main() {
  try {
    const { root, matrix } = parseArguments(process.argv.slice(2));
    process.stdout.write(`${canonicalJson(runMatrix(root, matrix))}\n`);
  } catch (error) {
    process.stderr.write(`ledger-golden-runner: ${error.message}\n`);
    process.exitCode = 2;
  }
}

if (
  process.argv[1] &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
) {
  main();
}
