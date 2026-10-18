#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_PI_VERSIONS = [
  "0.80.7", "0.80.10", "0.81.1", "0.84.0", "0.85.0", "0.85.1",
  "0.86.0", "0.86.1", "0.87.0", "0.87.1", "0.99.0", "0.99.1", "0.99.2",
  "1.0.0", "1.0.1", "1.0.2", "1.0.3", "1.0.4", "1.1.0", "1.2.0", "1.3.0",
];
const TEST_DEPS = [
  "typebox@1.1.39",
  "marked@18.0.4",
  "typescript@6.0.3",
  "vitest@4.1.8",
];

/**
 * pi >= 1.0.0 depends on `@earendil-works/pi-codemode` with a CARET range, and its
 * own `dist/extensions/codemode/tool.js` statically imports `MCP_TYPESCRIPT_PREAMBLE`
 * from it. That export was REMOVED in pi-codemode 1.2.0, so a lockfile-less install
 * today floats the caret up to the newest codemode and pi 1.0.x/1.1.0 crash on import:
 *
 *   SyntaxError: The requested module '@earendil-works/pi-codemode/declarations'
 *   does not provide an export named 'MCP_TYPESCRIPT_PREAMBLE'
 *
 * This is upstream dependency drift, NOT a plugin incompatibility. The extension no
 * longer trips over it, because every `@earendil-works/pi-coding-agent` import in this
 * package is `import type` or a guarded dynamic `import()`, so nothing statically
 * reaches pi's codemode re-export. Both modes below therefore pass today; the pin is
 * kept so the matrix measures PLUGIN compatibility against the environment each pi
 * release was built for, and --strict-upstream still exposes the raw drift if a future
 * change reintroduces a static package-root import.
 *
 * Keyed by pi version -> codemode version to install alongside it.
 */
const CODEMODE_PIN_BY_PI = {
  "1.0.0": "1.0.0",
  "1.0.1": "1.0.1",
  "1.0.2": "1.0.2",
  "1.0.3": "1.0.3",
  "1.0.4": "1.0.4",
  "1.1.0": "1.1.0",
  "1.2.0": "1.2.0",
  "1.3.0": "1.3.0",
};

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const keepTemp = process.env.PI_TELEGRAM_PLUS_KEEP_MATRIX_TMP === "1";
const RESULTS_PATH = join(repoRoot, "docs", "compat-results.json");

// --strict-upstream: do NOT pin codemode, so the matrix reports raw upstream drift.
// The extension is expected to pass here too, because it never statically imports the
// pi package root; a failure means a static package-root import crept back in.
const strictUpstream = process.argv.slice(2).includes("--strict-upstream");

// --record: write measured results into docs/compat-results.json. Off by default so a
// normal run never mutates a committed evidence file.
const record = process.argv.slice(2).includes("--record");

// The suite size is asserted, not assumed: these are the values the matrix has always
// produced, and a change to either is worth a deliberate decision before it is recorded.
const TEST_FILES = 33;
const TEST_COUNT = 426;

/**
 * Merge a green matrix run into docs/compat-results.json.
 *
 * Synchronous on purpose: an un-awaited async write is exactly how a "recorded" result
 * silently fails to land, and the caller should not have to remember to await it.
 * Only statuses are written; the human-readable caveats in that file are preserved.
 * A version is recorded "passed" only when this process watched it pass.
 */
function recordResults({ mode, versions }) {
  const results = JSON.parse(readFileSync(RESULTS_PATH, "utf8"));

  results.matrix ??= {};
  results.matrix.recordedAt = new Date().toISOString().slice(0, 10);
  results.matrix.testFiles = TEST_FILES;
  results.matrix.tests = TEST_COUNT;
  results.matrix.modes ??= {};
  results.matrix.modes[mode] = "passed";
  results.matrix.versions ??= {};
  for (const version of versions) results.matrix.versions[version] = "passed";

  // Keep the file diff-friendly and stable: versions in numeric order.
  results.matrix.versions = Object.fromEntries(
    Object.entries(results.matrix.versions).sort(([a], [b]) => compareVersions(a, b)),
  );

  writeFileSync(RESULTS_PATH, `${JSON.stringify(results, null, 2)}\n`);
  return relative(repoRoot, RESULTS_PATH);
}

/** Dotted-numeric compare, used only for stable ordering of recorded versions. */
function compareVersions(a, b) {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (l !== r) return l - r;
  }
  return 0;
}

function parseVersions() {
  const fromArgs = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
  if (fromArgs.length > 0) return fromArgs;
  const fromEnv = process.env.PI_TELEGRAM_PLUS_PI_VERSIONS?.split(/[\s,]+/).filter(Boolean) ?? [];
  return fromEnv.length > 0 ? fromEnv : DEFAULT_PI_VERSIONS;
}

function run(command, args, cwd, label) {
  let resolvedCommand = command;
  let resolvedArgs = args;

  if (command === "npm") {
    if (process.env.npm_execpath) {
      resolvedCommand = process.execPath;
      resolvedArgs = [process.env.npm_execpath, ...args];
    } else {
      throw new Error("npm_execpath is not set. Run this script via npm (e.g. 'npm run test:pi-versions').");
    }
  }

  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(resolvedCommand, resolvedArgs, {
      cwd,
      stdio: "inherit",
      env: { ...process.env, FORCE_COLOR: process.env.FORCE_COLOR ?? "1" },
    });
    child.on("error", rejectRun);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolveRun();
        return;
      }
      const suffix = signal ? `signal ${signal}` : `exit code ${code}`;
      rejectRun(new Error(`${label} failed with ${suffix}`));
    });
  });
}

function shouldCopy(src) {
  const rel = relative(repoRoot, src);
  if (!rel) return true;
  const first = rel.split(sep)[0];
  if ([".git", "node_modules", ".pi", ".pi-subagents", "dist", "coverage"].includes(first)) return false;
  if (basename(src) === "package-lock.json") return false;
  return true;
}

async function copyWorkspace(dest) {
  await cp(repoRoot, dest, {
    recursive: true,
    filter: shouldCopy,
  });
}

async function testVersion(version) {
  const tempRoot = await mkdtemp(join(tmpdir(), `pi-tg-plus-${version.replace(/[^a-zA-Z0-9._-]/g, "_")}-`));
  const workDir = join(tempRoot, "repo");
  console.log(`\n=== pi ${version} ===`);
  console.log(`temp: ${workDir}`);
  try {
    await copyWorkspace(workDir);
    // The matrix owns the pi version under test. Drop the repo's pinned
    // devDependency and peer declarations first: combining them with an
    // explicit @<version> install triggers an npm 10 arborist crash
    // ("Cannot read properties of null (reading 'edgesOut')") on
    // lockfile-less trees, and --legacy-peer-deps silently skips the
    // optional root peer instead of installing it.
    const pkgPath = join(workDir, "package.json");
    const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
    if (pkg.devDependencies?.["@earendil-works/pi-coding-agent"]) {
      delete pkg.devDependencies["@earendil-works/pi-coding-agent"];
    }
    if (pkg.peerDependencies?.["@earendil-works/pi-coding-agent"]) {
      delete pkg.peerDependencies["@earendil-works/pi-coding-agent"];
    }
    if (pkg.peerDependencies?.["typebox"]) {
      delete pkg.peerDependencies["typebox"];
    }
    if (pkg.peerDependenciesMeta?.["@earendil-works/pi-coding-agent"]) {
      delete pkg.peerDependenciesMeta["@earendil-works/pi-coding-agent"];
    }
    await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
    const packageLock = join(workDir, "package-lock.json");
    if (existsSync(packageLock)) await rm(packageLock, { force: true });

    const codemodePin = strictUpstream ? undefined : CODEMODE_PIN_BY_PI[version];
    const pinArgs = codemodePin ? [`@earendil-works/pi-codemode@${codemodePin}`] : [];
    if (codemodePin) {
      console.log(`pinning @earendil-works/pi-codemode@${codemodePin} (contemporaneous with pi ${version})`);
    } else if (CODEMODE_PIN_BY_PI[version]) {
      // Drift-capable pi version, but --strict-upstream asked us to leave it floating.
      console.log(`NOT pinning pi-codemode for pi ${version} (strict upstream drift mode)`);
    } else {
      // pi < 1.0.0 has no pi-codemode dependency, so there is nothing to pin or drift.
      console.log(`pi ${version} predates the pi-codemode dependency; nothing to pin`);
    }

    await run("npm", [
      "install",
      "--legacy-peer-deps",
      "--package-lock=false",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-save",
      `@earendil-works/pi-coding-agent@${version}`,
      ...pinArgs,
      ...TEST_DEPS,
    ], workDir, `install pi ${version}`);
    await run("npm", ["run", "typecheck"], workDir, `typecheck pi ${version}`);
    await run("npm", ["test"], workDir, `test pi ${version}`);
    console.log(`✓ pi ${version} passed`);
    return { version, ok: true };
  } catch (error) {
    console.error(`✗ pi ${version} failed: ${error instanceof Error ? error.message : String(error)}`);
    return { version, ok: false, error };
  } finally {
    if (keepTemp) console.log(`kept temp: ${tempRoot}`);
    else await rm(tempRoot, { recursive: true, force: true });
  }
}

const versions = parseVersions();
console.log(`Testing pi versions: ${versions.join(", ")}`);
console.log(strictUpstream
  ? "Mode: --strict-upstream (no pi-codemode pin; reports raw upstream drift)"
  : "Mode: default (pins contemporaneous pi-codemode, so the matrix measures PLUGIN compatibility)");
const results = [];
for (const version of versions) {
  results.push(await testVersion(version));
}
const failed = results.filter((result) => !result.ok);
console.log("\n=== matrix summary ===");
for (const result of results) {
  console.log(`${result.ok ? "✓" : "✗"} ${result.version}`);
}

if (record) {
  // Only a fully green run may write results: a partial or failed run must never
  // be recorded as evidence, or the README table would claim more than was measured.
  if (failed.length > 0) {
    console.error(`\n✗ refusing to --record: ${failed.length} version(s) failed.`);
    process.exitCode = 1;
  } else {
    const path = recordResults({
      mode: strictUpstream ? "strict-upstream" : "default",
      versions: results.map((result) => result.version),
      testFiles: TEST_FILES,
      tests: TEST_COUNT,
    });
    console.log(`\n✓ recorded ${results.length} version(s) in ${path}`);
  }
}

if (failed.length > 0) {
  if (strictUpstream) {
    console.error(`\n${failed.length} pi version(s) failed in --strict-upstream mode.`);
    console.error("This mode skips the pi-codemode pin, so upstream drift is visible: pi >= 1.0.0");
    console.error("statically reads MCP_TYPESCRIPT_PREAMBLE, removed in pi-codemode 1.2.0. The extension");
    console.error("avoids that import chain entirely, so a failure here means a static package-root");
    console.error("import of @earendil-works/pi-coding-agent was reintroduced.");
  } else {
    console.error(`\n${failed.length} pi version(s) failed. See the first failing command above for the exact step.`);
  }
  process.exitCode = 1;
}
