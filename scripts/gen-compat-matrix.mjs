#!/usr/bin/env node
/**
 * Generate the compatibility matrix in README.md from docs/compat-results.json.
 *
 * The point of this script is that the README table can no longer drift:
 * it is rendered output, not hand-maintained prose. `--check` is wired into
 * `prepublishOnly`, so a release fails if the table and the recorded results
 * disagree, or if a pi version was added to a test script without a recorded
 * result.
 *
 * Usage:
 *   node scripts/gen-compat-matrix.mjs            # write README table
 *   node scripts/gen-compat-matrix.mjs --check    # verify only, exit 1 on drift
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RESULTS_PATH = join(ROOT, "docs", "compat-results.json");
const README_PATH = join(ROOT, "README.md");
const MATRIX_SCRIPT = join(ROOT, "scripts", "test-pi-versions.mjs");
const E2E_SCRIPT = join(ROOT, "scripts", "e2e", "run-e2e.mjs");

const START = "<!-- BEGIN GENERATED COMPAT MATRIX -->";
const END = "<!-- END GENERATED COMPAT MATRIX -->";

/**
 * The supported range lives in exactly one place: package.json's peer range,
 * which is what npm actually enforces. Everything else derives from it.
 */
function readSupportedRange() {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const range = pkg.peerDependencies?.["@earendil-works/pi-coding-agent"];
  if (!range) {
    throw new Error('package.json has no peerDependencies["@earendil-works/pi-coding-agent"]');
  }
  return range;
}

/** Versions the matrix script will actually test. */
function matrixScriptVersions() {
  const source = readFileSync(MATRIX_SCRIPT, "utf8");
  const block = source.match(/const DEFAULT_PI_VERSIONS = \[([\s\S]*?)\];/);
  if (!block) throw new Error(`could not find DEFAULT_PI_VERSIONS in ${MATRIX_SCRIPT}`);
  return [...block[1].matchAll(/"([\d.]+)"/g)].map((m) => m[1]);
}

/** Versions the E2E script drives by default. */
function e2eScriptVersions() {
  const source = readFileSync(E2E_SCRIPT, "utf8");
  const block = source.match(/argValue\("--versions", "([^"]*)"\)/);
  if (!block) throw new Error(`could not find the --versions default in ${E2E_SCRIPT}`);
  return block[1].split(",").map((v) => v.trim()).filter(Boolean);
}

/** Human-facing cell text for a recorded status. */
function cell(status, footnote) {
  const base = status === "passed" ? "passed" : status === "not run" ? "not run" : status;
  return footnote ? `${base} &nbsp;${footnote}` : base;
}

function render(results) {
  const matrix = results.matrix.versions;
  const e2e = results.e2e.versions;
  const footnotes = results.footnotes ?? {};

  const lines = [
    START,
    `Supported range: \`@earendil-works/pi-coding-agent ${readSupportedRange()}\`.`,
    "",
    "| pi coding agent | Automated clean install (`typecheck` + tests) | Automated isolated E2E (tmux + mock Telegram API + mock provider) |",
    "|-----------------|-----------------------------------------------|-------------------------------------------------------------------|",
  ];
  // Order by the matrix script, so the table follows the tested range rather
  // than JSON key order.
  for (const version of matrixScriptVersions()) {
    if (!(version in matrix)) continue;
    const fn = footnotes[version];
    lines.push(
      `| \`${version}\` | ${cell(matrix[version], fn)} | ${cell(e2e[version] ?? "not run", fn)} |`,
    );
  }
  lines.push(END);
  return lines.join("\n");
}

function replaceBlock(readme, block) {
  const startIndex = readme.indexOf(START);
  const endIndex = readme.indexOf(END);
  if (startIndex === -1 || endIndex === -1) {
    throw new Error(`README is missing the ${START} / ${END} markers`);
  }
  return readme.slice(0, startIndex) + block + readme.slice(endIndex + END.length);
}

/**
 * Compare two dotted numeric versions. Returns -1, 0 or 1.
 * Only release versions (no prerelease/build metadata) are supported; anything
 * else throws, so an unparseable version can never be silently treated as in-range.
 */
function compareVersions(a, b) {
  const parse = (value) => {
    if (!/^\d+(\.\d+)*$/.test(value)) {
      throw new Error(`unsupported version "${value}" (expected a dotted numeric release version)`);
    }
    return value.split(".").map(Number);
  };
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (l !== r) return l < r ? -1 : 1;
  }
  return 0;
}

/** True when `version` satisfies a `>=x <y` / `^x` style range. Throws on syntax it cannot verify. */
function satisfiesRange(version, range) {
  const clauses = range.trim().split(/\s+/).filter(Boolean);
  if (!clauses.length) throw new Error(`empty range "${range}"`);
  for (const clause of clauses) {
    const match = clause.match(/^(>=|<=|>|<|=)?\s*(\d+(?:\.\d+)*)$/);
    if (!match) {
      throw new Error(`unsupported range clause "${clause}" in "${range}"`);
    }
    const [, operator = "=", bound] = match;
    const cmp = compareVersions(version, bound);
    const ok =
      operator === ">=" ? cmp >= 0
        : operator === "<=" ? cmp <= 0
          : operator === ">" ? cmp > 0
            : operator === "<" ? cmp < 0
              : cmp === 0;
    if (!ok) return false;
  }
  return true;
}

/** Everything that must be internally consistent for a release. */
function collectProblems(results) {
  const problems = [];
  const matrix = results.matrix.versions;
  const e2e = results.e2e.versions;

  const scriptVersions = matrixScriptVersions();
  const recorded = Object.keys(matrix);

  const missing = scriptVersions.filter((v) => !recorded.includes(v));
  if (missing.length) {
    problems.push(
      `scripts/test-pi-versions.mjs tests ${missing.join(", ")} but docs/compat-results.json records no result`,
    );
  }
  const extra = recorded.filter((v) => !scriptVersions.includes(v));
  if (extra.length) {
    problems.push(
      `docs/compat-results.json records ${extra.join(", ")} which scripts/test-pi-versions.mjs no longer tests`,
    );
  }

  const missingE2e = Object.keys(e2e).filter((v) => !scriptVersions.includes(v));
  if (missingE2e.length) {
    problems.push(
      `docs/compat-results.json records E2E results for ${missingE2e.join(", ")}, absent from the matrix`,
    );
  }
  for (const version of e2eScriptVersions()) {
    if (!(version in e2e)) {
      problems.push(
        `scripts/e2e/run-e2e.mjs drives ${version} by default but docs/compat-results.json records no E2E result`,
      );
    }
  }

  // The declared range must actually contain every version we claim to test; a
  // range that excludes a tested version is the exact class of drift that stale
  // hand-written prose caused before this script existed.
  const range = readSupportedRange();
  for (const version of scriptVersions) {
    if (!satisfiesRange(version, range)) {
      problems.push(
        `package.json peer range "${range}" does not include tested version ${version}`,
      );
    }
  }

  return problems;
}

function main() {
  const checkOnly = process.argv.includes("--check");
  const results = JSON.parse(readFileSync(RESULTS_PATH, "utf8"));
  const readme = readFileSync(README_PATH, "utf8");
  const block = render(results);
  const next = replaceBlock(readme, block);

  const problems = collectProblems(results);
  if (problems.length) {
    for (const problem of problems) console.error(`✗ ${problem}`);
    process.exitCode = 1;
    return;
  }

  if (checkOnly) {
    if (next !== readme) {
      console.error("✗ README compatibility matrix is out of date with docs/compat-results.json.");
      console.error("  Run `npm run compat:gen` and commit the result.");
      process.exitCode = 1;
      return;
    }
    console.log(`✓ compatibility matrix is current (${matrixScriptVersions().length} versions)`);
    return;
  }

  if (next === readme) {
    console.log(`✓ compatibility matrix already current (${matrixScriptVersions().length} versions)`);
    return;
  }
  writeFileSync(README_PATH, next);
  console.log(`✓ wrote README compatibility matrix (${matrixScriptVersions().length} versions)`);
}

try {
  main();
} catch (error) {
  // Any range syntax this script cannot verify is a hard failure, never a silent pass:
  // the whole point is that the range and the evidence must not be able to disagree.
  console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
