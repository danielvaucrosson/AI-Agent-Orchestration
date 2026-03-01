/**
 * Pre-PR Review Agent — quality gate before PR creation.
 *
 * Runs a series of automated checks (quality gates) before a PR is opened.
 * If any gate fails, the review blocks PR creation with actionable feedback.
 * If all gates pass, outputs a review report for inclusion in the PR description.
 *
 * Usage:
 *   node scripts/pre-pr-review.mjs                     Run all gates
 *   node scripts/pre-pr-review.mjs --gate tests        Run a specific gate
 *   node scripts/pre-pr-review.mjs --force              Run but don't block on failure
 *   node scripts/pre-pr-review.mjs --report <file>      Write report to a file
 *   node scripts/pre-pr-review.mjs --json                Output JSON instead of Markdown
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname, extname, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..");

// --- Gate Definitions ---

/**
 * Each gate is a function that returns:
 *   { name, status: "pass"|"fail"|"warn", details: string[], items?: object[] }
 */

/**
 * Gate: Tests — run `npm test` and check exit code.
 */
export function gateTests() {
  const name = "Tests";
  try {
    const output = execSync("npm test 2>&1", {
      encoding: "utf-8",
      cwd: PROJECT_ROOT,
      timeout: 60000,
    });

    // Parse test counts from Node test runner output
    const passMatch = output.match(/pass\s+(\d+)/);
    const failMatch = output.match(/fail\s+(\d+)/);
    const passed = passMatch ? parseInt(passMatch[1]) : 0;
    const failed = failMatch ? parseInt(failMatch[1]) : 0;

    if (failed > 0) {
      return {
        name,
        status: "fail",
        details: [`${failed} test(s) failed, ${passed} passed`],
      };
    }

    return {
      name,
      status: "pass",
      details: [`All ${passed} tests passed`],
    };
  } catch (err) {
    const output = err.stdout || err.stderr || err.message || "";
    // Extract a concise error summary
    const lines = output.split("\n").filter((l) => l.includes("✖") || l.includes("fail") || l.includes("Error"));
    return {
      name,
      status: "fail",
      details: lines.length > 0 ? lines.slice(0, 10) : ["Test command failed — check output above"],
    };
  }
}

/**
 * Gate: Security — check for hardcoded secrets and unsafe patterns.
 */
export function gateSecurity(changedFiles) {
  const name = "Security";
  const findings = [];

  const SECRET_PATTERNS = [
    { pattern: /(?:api[_-]?key|apikey)\s*[:=]\s*["'][^"']{8,}["']/gi, label: "Possible API key" },
    { pattern: /(?:secret|password|passwd|pwd)\s*[:=]\s*["'][^"']{4,}["']/gi, label: "Possible secret/password" },
    { pattern: /(?:token)\s*[:=]\s*["'][^"']{8,}["']/gi, label: "Possible token" },
    { pattern: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/g, label: "Private key" },
    { pattern: /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,}/g, label: "GitHub token" },
    { pattern: /sk-[A-Za-z0-9]{32,}/g, label: "OpenAI/Anthropic API key" },
    { pattern: /\bAKIA[A-Z0-9]{16}\b/g, label: "AWS access key" },
  ];

  // Files that intentionally contain fake secret patterns (test fixtures)
  const SECURITY_ALLOWLIST = new Set([
    "tests/pre-pr-review.test.mjs",
  ]);

  const UNSAFE_PATTERNS = [
    { pattern: /eval\s*\(/g, label: "Use of eval()", extensions: new Set([".mjs", ".js", ".ts"]) },
    { pattern: /innerHTML\s*=/g, label: "innerHTML assignment (XSS risk)", extensions: new Set([".mjs", ".js", ".ts", ".tsx", ".jsx"]) },
    { pattern: /document\.write\s*\(/g, label: "document.write() (XSS risk)", extensions: new Set([".mjs", ".js", ".ts", ".tsx", ".jsx"]) },
    { pattern: /child_process.*exec\(/g, label: "Command injection risk (exec)", extensions: new Set([".mjs", ".js", ".ts"]) },
  ];

  // Files to scan — either changed files or all source files
  const files = changedFiles && changedFiles.length > 0
    ? changedFiles
    : getSourceFiles();

  for (const filePath of files) {
    const absPath = join(PROJECT_ROOT, filePath);
    if (!existsSync(absPath)) continue;

    // Skip binary files, node_modules, .git
    if (filePath.includes("node_modules") || filePath.includes(".git/")) continue;

    let content;
    try {
      content = readFileSync(absPath, "utf-8");
    } catch {
      continue;
    }

    const ext = extname(filePath);

    // Normalize path separators for cross-platform allowlist matching
    const normalizedPath = filePath.replace(/\\/g, "/");

    // Check for secrets (skip allowlisted files with intentional test fixtures)
    if (!SECURITY_ALLOWLIST.has(normalizedPath)) {
      for (const { pattern, label } of SECRET_PATTERNS) {
        pattern.lastIndex = 0;
        if (pattern.test(content)) {
          findings.push({ file: filePath, issue: label, severity: "critical" });
        }
      }
    }

    // Check for unsafe patterns
    for (const { pattern, label, extensions } of UNSAFE_PATTERNS) {
      if (extensions && !extensions.has(ext)) continue;
      pattern.lastIndex = 0;
      if (pattern.test(content)) {
        // Exclude test files and scripts from some checks
        if (filePath.includes("test") || filePath.includes("scripts/")) continue;
        findings.push({ file: filePath, issue: label, severity: "warning" });
      }
    }
  }

  const critical = findings.filter((f) => f.severity === "critical");
  const warnings = findings.filter((f) => f.severity === "warning");

  if (critical.length > 0) {
    return {
      name,
      status: "fail",
      details: critical.map((f) => `CRITICAL: ${f.issue} in ${f.file}`),
      items: findings,
    };
  }

  if (warnings.length > 0) {
    return {
      name,
      status: "warn",
      details: warnings.map((f) => `WARNING: ${f.issue} in ${f.file}`),
      items: findings,
    };
  }

  return {
    name,
    status: "pass",
    details: [`No security issues found in ${files.length} file(s)`],
  };
}

/**
 * Gate: Conventions — verify project conventions from CLAUDE.md.
 */
export function gateConventions() {
  const name = "Conventions";
  const issues = [];

  // 1. Check branch naming convention
  let branch = "";
  try {
    branch = execSync("git rev-parse --abbrev-ref HEAD", {
      encoding: "utf-8",
      cwd: PROJECT_ROOT,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    issues.push("Could not determine current branch");
  }

  if (branch) {
    const validBranchPattern = /^(feature|fix|chore|docs|refactor)\/[A-Z]{1,5}-\d+/;
    if (!validBranchPattern.test(branch) && !branch.startsWith("claude/")) {
      issues.push(`Branch "${branch}" doesn't follow naming convention: feature/DVA-<N>-description`);
    }
  }

  // 2. Check that changed files have corresponding tests (for src/ files)
  const changedSrcFiles = getChangedFiles().filter(
    (f) => f.startsWith("src/") && !f.includes(".test.")
  );

  for (const srcFile of changedSrcFiles) {
    const testFile = srcFile
      .replace(/^src\//, "tests/")
      .replace(/(\.\w+)$/, ".test$1");
    if (!existsSync(join(PROJECT_ROOT, testFile))) {
      issues.push(`Source file ${srcFile} has no corresponding test file (expected ${testFile})`);
    }
  }

  // 3. Check that scripts have usage docs (help text)
  const changedScripts = getChangedFiles().filter(
    (f) => f.startsWith("scripts/") && f.endsWith(".mjs")
  );
  for (const scriptFile of changedScripts) {
    const absPath = join(PROJECT_ROOT, scriptFile);
    if (!existsSync(absPath)) continue;
    const content = readFileSync(absPath, "utf-8");
    if (!content.includes("Usage:") && !content.includes("usage:")) {
      issues.push(`Script ${scriptFile} is missing usage documentation`);
    }
  }

  if (issues.length > 0) {
    return {
      name,
      status: "warn",
      details: issues,
    };
  }

  return {
    name,
    status: "pass",
    details: ["Branch naming, test coverage, and conventions look good"],
  };
}

/**
 * Gate: Code Quality — check for common quality issues.
 */
export function gateCodeQuality(changedFiles) {
  const name = "Code Quality";
  const issues = [];

  const files = changedFiles && changedFiles.length > 0
    ? changedFiles.filter((f) => f.startsWith("src/"))
    : getSourceFiles().filter((f) => f.startsWith("src/"));

  const COMMENT_PREFIX_RE = /^\s*(?:\/\/|#|\/\*|\*)/;

  for (const filePath of files) {
    const absPath = join(PROJECT_ROOT, filePath);
    if (!existsSync(absPath)) continue;

    let content;
    try {
      content = readFileSync(absPath, "utf-8");
    } catch {
      continue;
    }

    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Check for TODO/FIXME in comments
      if (COMMENT_PREFIX_RE.test(line) && /\b(TODO|FIXME|HACK|XXX)\b/.test(line)) {
        issues.push({
          file: filePath,
          line: i + 1,
          issue: `Unresolved marker: ${line.trim().slice(0, 80)}`,
          severity: "info",
        });
      }

      // Check for console.log in production source code
      if (/\bconsole\.log\b/.test(line) && !filePath.includes("test")) {
        issues.push({
          file: filePath,
          line: i + 1,
          issue: "console.log in production code",
          severity: "warning",
        });
      }
    }

    // Check for empty catch blocks
    if (/catch\s*\([^)]*\)\s*\{\s*\}/.test(content)) {
      issues.push({
        file: filePath,
        line: null,
        issue: "Empty catch block — errors may be silently swallowed",
        severity: "warning",
      });
    }
  }

  const warnings = issues.filter((i) => i.severity === "warning");
  const infos = issues.filter((i) => i.severity === "info");

  if (warnings.length > 0) {
    return {
      name,
      status: "warn",
      details: [
        ...warnings.map((i) => `${i.file}${i.line ? `:${i.line}` : ""}: ${i.issue}`),
        ...(infos.length > 0 ? [`Plus ${infos.length} info-level finding(s)`] : []),
      ],
      items: issues,
    };
  }

  if (infos.length > 0) {
    return {
      name,
      status: "pass",
      details: [`Passed with ${infos.length} info-level finding(s)`],
      items: issues,
    };
  }

  return {
    name,
    status: "pass",
    details: [`No quality issues found in ${files.length} source file(s)`],
  };
}

/**
 * Gate: Diff Size — warn on excessively large PRs.
 */
export function gateDiffSize() {
  const name = "Diff Size";

  try {
    // Get diff stats against the base branch
    const baseBranch = getBaseBranch();
    const diffStat = execSync(`git diff --stat ${baseBranch}...HEAD`, {
      encoding: "utf-8",
      cwd: PROJECT_ROOT,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    const lastLine = diffStat.split("\n").pop() || "";
    const insertions = (lastLine.match(/(\d+) insertion/) || [, "0"])[1];
    const deletions = (lastLine.match(/(\d+) deletion/) || [, "0"])[1];
    const filesChanged = (lastLine.match(/(\d+) file/) || [, "0"])[1];

    const totalChanges = parseInt(insertions) + parseInt(deletions);

    if (totalChanges > 1000) {
      return {
        name,
        status: "warn",
        details: [
          `Large PR: ${filesChanged} files, +${insertions}/-${deletions} lines (${totalChanges} total changes)`,
          "Consider breaking this into smaller PRs for easier review",
        ],
      };
    }

    return {
      name,
      status: "pass",
      details: [`${filesChanged} files, +${insertions}/-${deletions} lines`],
    };
  } catch {
    return {
      name,
      status: "pass",
      details: ["Could not compute diff stats (possibly initial commit)"],
    };
  }
}

// --- Helpers ---

/**
 * Get the default/base branch name.
 */
function getBaseBranch() {
  try {
    // Check for common base branches
    const branches = execSync("git branch -r", {
      encoding: "utf-8",
      cwd: PROJECT_ROOT,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    if (branches.includes("origin/main")) return "origin/main";
    if (branches.includes("origin/master")) return "origin/master";

    // Fall back to the first remote branch that looks like a default
    const lines = branches.split("\n").map((l) => l.trim());
    const defaultBranch = lines.find((l) => l.includes("HEAD ->"));
    if (defaultBranch) {
      const match = defaultBranch.match(/-> (.+)/);
      if (match) return match[1];
    }

    // Last resort: use the first claude/ branch
    const claudeBranch = lines.find((l) => l.startsWith("origin/claude/"));
    if (claudeBranch) return claudeBranch;

    return "HEAD~5"; // Compare against last 5 commits
  } catch {
    return "HEAD~5";
  }
}

/**
 * Get list of changed files (staged + unstaged + untracked vs base).
 */
export function getChangedFiles() {
  try {
    const baseBranch = getBaseBranch();
    const output = execSync(`git diff --name-only ${baseBranch}...HEAD`, {
      encoding: "utf-8",
      cwd: PROJECT_ROOT,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    return output ? output.split("\n").filter(Boolean) : [];
  } catch {
    return [];
  }
}

/**
 * Get all source files in the project.
 */
function getSourceFiles(dir = PROJECT_ROOT, base = "") {
  const results = [];
  const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".claude"]);
  const SOURCE_EXTS = new Set([".mjs", ".js", ".ts", ".tsx", ".jsx", ".json"]);

  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;
      const fullPath = join(dir, entry);
      const relPath = base ? `${base}/${entry}` : entry;

      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          results.push(...getSourceFiles(fullPath, relPath));
        } else if (SOURCE_EXTS.has(extname(entry))) {
          results.push(relPath);
        }
      } catch {
        continue;
      }
    }
  } catch {
    // Directory not readable
  }

  return results;
}

// --- Report Generation ---

/**
 * Run all gates and produce a structured result.
 */
export function runAllGates(options = {}) {
  const changedFiles = getChangedFiles();
  const gatesToRun = options.gate
    ? [options.gate]
    : ["tests", "security", "conventions", "codeQuality", "diffSize"];

  const gateMap = {
    tests: () => gateTests(),
    security: () => gateSecurity(changedFiles),
    conventions: () => gateConventions(),
    codeQuality: () => gateCodeQuality(changedFiles),
    diffSize: () => gateDiffSize(),
  };

  const results = [];
  for (const gateName of gatesToRun) {
    const fn = gateMap[gateName];
    if (!fn) {
      results.push({ name: gateName, status: "fail", details: [`Unknown gate: ${gateName}`] });
      continue;
    }

    try {
      results.push(fn());
    } catch (err) {
      results.push({
        name: gateName,
        status: "fail",
        details: [`Gate threw error: ${err.message}`],
      });
    }
  }

  const passed = results.filter((r) => r.status === "pass").length;
  const warned = results.filter((r) => r.status === "warn").length;
  const failed = results.filter((r) => r.status === "fail").length;

  return {
    timestamp: new Date().toISOString(),
    overall: failed > 0 ? "fail" : warned > 0 ? "warn" : "pass",
    summary: { passed, warned, failed, total: results.length },
    gates: results,
  };
}

/**
 * Generate a Markdown report from gate results.
 */
export function generateReport(result) {
  const icon = { pass: "✅", warn: "⚠️", fail: "❌" };
  const lines = [
    `## Pre-PR Review Report`,
    ``,
    `**Overall:** ${icon[result.overall]} ${result.overall.toUpperCase()}`,
    `**Gates:** ${result.summary.passed} passed, ${result.summary.warned} warnings, ${result.summary.failed} failed`,
    `**Time:** ${result.timestamp}`,
    ``,
    `| Gate | Status | Details |`,
    `|------|--------|---------|`,
  ];

  for (const gate of result.gates) {
    const statusIcon = icon[gate.status];
    const detail = gate.details[0] || "-";
    lines.push(`| ${gate.name} | ${statusIcon} ${gate.status} | ${detail} |`);
  }

  lines.push(``);

  // Detailed findings for non-pass gates
  const nonPass = result.gates.filter((g) => g.status !== "pass");
  if (nonPass.length > 0) {
    lines.push(`### Details`);
    lines.push(``);

    for (const gate of nonPass) {
      lines.push(`#### ${icon[gate.status]} ${gate.name}`);
      lines.push(``);
      for (const detail of gate.details) {
        lines.push(`- ${detail}`);
      }
      lines.push(``);
    }
  }

  return lines.join("\n");
}

// --- CLI ---

const isMain = process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  // Parse flags
  const args = process.argv.slice(2);
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
        flags[key] = args[i + 1];
        i++;
      } else {
        flags[key] = true;
      }
    }
  }

  if (flags.help) {
    console.log(`Usage: node scripts/pre-pr-review.mjs [options]

Options:
  --gate <name>     Run a specific gate only (tests, security, conventions, codeQuality, diffSize)
  --force           Run review but exit 0 even on failure (for urgent fixes)
  --report <file>   Write Markdown report to a file
  --json            Output JSON instead of Markdown
  --help            Show this help

Quality Gates:
  tests         Run npm test and check all tests pass
  security      Check for hardcoded secrets and unsafe patterns
  conventions   Verify branch naming, test coverage, script docs
  codeQuality   Check for TODO/FIXME, console.log, empty catch blocks
  diffSize      Warn on excessively large diffs (>1000 lines)

Examples:
  node scripts/pre-pr-review.mjs                        # Run all gates
  node scripts/pre-pr-review.mjs --gate tests            # Run tests gate only
  node scripts/pre-pr-review.mjs --force                 # Run but don't block
  node scripts/pre-pr-review.mjs --report review.md      # Save report to file
  node scripts/pre-pr-review.mjs --json                  # Output JSON

Exit codes:
  0   All gates passed (or --force flag used)
  1   One or more gates failed`);
    process.exit(0);
  }

  const result = runAllGates({ gate: flags.gate });

  if (flags.json) {
    const json = JSON.stringify(result, null, 2);
    if (flags.report) {
      writeFileSync(flags.report, json, "utf-8");
      console.log(`JSON report written to ${flags.report}`);
    } else {
      console.log(json);
    }
  } else {
    const report = generateReport(result);
    if (flags.report) {
      writeFileSync(flags.report, report, "utf-8");
      console.log(`Report written to ${flags.report}`);
    } else {
      console.log(report);
    }
  }

  // Summary line
  const { summary } = result;
  console.log(
    `\nReview: ${summary.passed}/${summary.total} gates passed` +
    (summary.warned > 0 ? `, ${summary.warned} warning(s)` : "") +
    (summary.failed > 0 ? `, ${summary.failed} FAILED` : "")
  );

  // Write marker file when review passes (used by pre-pr-check hook)
  if (result.overall !== "fail" || flags.force) {
    const markerDir = join(PROJECT_ROOT, ".claude", "audit");
    const markerPath = join(markerDir, "_review-passed.marker");
    mkdirSync(markerDir, { recursive: true });
    writeFileSync(markerPath, new Date().toISOString(), "utf-8");
  }

  // Exit code
  if (result.overall === "fail" && !flags.force) {
    console.log("\nPR creation blocked. Fix the issues above or use --force to override.");
    process.exit(1);
  } else if (flags.force && result.overall === "fail") {
    console.log("\n⚠️  Force mode: proceeding despite failures.");
  }
}
