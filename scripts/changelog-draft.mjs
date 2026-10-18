#!/usr/bin/env node
/**
 * Draft the `[Unreleased]` section of CHANGELOG.md from conventional commits.
 *
 * This exists because CHANGELOG.md is the *only* human-facing release-notes surface for
 * this project: the publish workflow creates tags but no GitHub Release, so a consumer
 * has nowhere else to read what changed. That makes the file worth keeping — but it does
 * not make it worth writing from scratch every release.
 *
 * This script produces a skeleton, not a finished section. It cannot know why a change
 * mattered, and it should not pretend to: the output is deliberately terse and is meant to
 * be edited down before release. Sections that are internal (ci/build/chore/test/docs)
 * are reported separately so they can be dropped on purpose rather than by accident.
 *
 * Usage:
 *   npm run changelog:draft                 # commits since the last tag
 *   npm run changelog:draft -- v0.0.9       # since an explicit ref
 *   npm run changelog:draft -- v0.0.9 HEAD
 *
 * Zero dependencies: this must keep working with no install step.
 */
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Conventional type -> changelog section. Types absent here are treated as internal. */
const SECTIONS = {
  feat: "Added",
  fix: "Fixed",
  perf: "Changed",
  refactor: "Changed",
  revert: "Changed",
  build: "Changed",
};

/** Types that are internal housekeeping and normally do not belong in release notes. */
const INTERNAL = new Set(["ci", "chore", "test", "docs", "style", "release"]);

const SECTION_ORDER = ["Added", "Changed", "Fixed", "Removed"];

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

/** Last reachable tag, or undefined when the repo has none. */
function lastTag() {
  try {
    return git(["describe", "--tags", "--abbrev=0"]);
  } catch {
    return undefined;
  }
}

/**
 * Parse one commit subject.
 * Returns null for merge commits and anything without a recognised conventional prefix —
 * those are reported separately rather than silently dropped into a section.
 */
function parseCommit(line) {
  const match = line.match(/^([0-9a-f]+) ([a-z]+)(?:\(([^)]*)\))?(!)?: (.+)$/);
  if (!match) return null;
  const [, sha, type, scope, breaking, subject] = match;
  return { sha, type, scope, breaking: Boolean(breaking), subject };
}

function main() {
  const [fromArg, toArg] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const to = toArg ?? "HEAD";
  const from = fromArg ?? lastTag();

  const range = from ? `${from}..${to}` : to;
  const raw = git(["log", "--no-merges", "--format=%h %s", range]);
  const lines = raw ? raw.split("\n").filter(Boolean) : [];

  const bySection = new Map();
  const internal = [];
  const unparsed = [];
  const breaking = [];

  for (const line of lines) {
    const commit = parseCommit(line);
    if (!commit) {
      // Merge commits are excluded by --no-merges; anything left is a non-conventional
      // subject, which needs a human decision rather than a guessed section.
      if (!/^[0-9a-f]+ Merge /.test(line)) unparsed.push(line);
      continue;
    }
    const text = commit.scope ? `**${commit.scope}:** ${commit.subject}` : commit.subject;
    const entry = { ...commit, text };
    if (commit.breaking) breaking.push(entry);

    if (INTERNAL.has(commit.type)) {
      internal.push(entry);
      continue;
    }
    const section = SECTIONS[commit.type];
    if (!section) {
      internal.push(entry);
      continue;
    }
    if (!bySection.has(section)) bySection.set(section, []);
    bySection.get(section).push(entry);
  }

  const heading = from ? `commits in \`${range}\`` : `all ${lines.length} commits (no tag found)`;
  console.log(`<!-- draft: ${heading} -->`);
  console.log("<!--\n  Draft only. Edit before release: keep the user-visible effect, drop the\n"
    + "  internal detail. Commit bodies already carry the full rationale.\n-->");
  console.log();
  console.log("## [Unreleased]");
  console.log();

  if (breaking.length) {
    console.log("### Breaking");
    console.log();
    for (const entry of breaking) console.log(`- ${entry.text} (${entry.sha})`);
    console.log();
  }

  for (const section of SECTION_ORDER) {
    const entries = bySection.get(section);
    if (!entries?.length) continue;
    console.log(`### ${section}`);
    console.log();
    for (const entry of entries) console.log(`- ${entry.text} (${entry.sha})`);
    console.log();
  }

  const unmapped = [...bySection.keys()].filter((s) => !SECTION_ORDER.includes(s));
  for (const section of unmapped) {
    console.log(`### ${section}`);
    console.log();
    for (const entry of bySection.get(section)) console.log(`- ${entry.text} (${entry.sha})`);
    console.log();
  }

  if (internal.length) {
    console.log("<!-- Internal (normally omitted from release notes):");
    for (const entry of internal) console.log(`       ${entry.type}  ${entry.text}`);
    console.log("-->");
    console.log();
  }

  if (unparsed.length) {
    console.log("<!-- Non-conventional subjects needing a decision:");
    for (const line of unparsed) console.log(`       ${line}`);
    console.log("-->");
    console.log();
  }
}

main();
