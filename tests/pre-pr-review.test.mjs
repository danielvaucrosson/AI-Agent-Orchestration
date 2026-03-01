import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { writeFileSync, unlinkSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  gateSecurity,
  gateCodeQuality,
  runAllGates,
  generateReport,
  getChangedFiles,
} from "../scripts/pre-pr-review.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..");
const FIXTURES_DIR = join(PROJECT_ROOT, "src", "_review-fixtures");
const TMP_DIR = join(PROJECT_ROOT, "tests", "_tmp");

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

function cleanFixture(filePath) {
  try {
    if (existsSync(filePath)) unlinkSync(filePath);
  } catch { /* ignore */ }
}

function run(args) {
  return execSync(`node "${join(PROJECT_ROOT, "scripts", "pre-pr-review.mjs")}" ${args}`, {
    encoding: "utf-8",
    cwd: PROJECT_ROOT,
    timeout: 120000,
  });
}

// --- Tests ---

describe("gateSecurity", () => {
  beforeEach(() => ensureDir(FIXTURES_DIR));
  afterEach(() => {
    cleanFixture(join(FIXTURES_DIR, "unsafe-secrets.mjs"));
    cleanFixture(join(FIXTURES_DIR, "clean-code.mjs"));
  });

  it("detects hardcoded API keys", () => {
    const file = join(FIXTURES_DIR, "unsafe-secrets.mjs");
    writeFileSync(file, 'const api_key = "sk-abc123def456ghi789jklmnopqrstuvwxyz1234";\n', "utf-8");

    const result = gateSecurity(["src/_review-fixtures/unsafe-secrets.mjs"]);
    assert.equal(result.status, "fail");
    assert.ok(result.details.some((d) => d.includes("CRITICAL")));
  });

  it("detects GitHub tokens", () => {
    const file = join(FIXTURES_DIR, "unsafe-secrets.mjs");
    writeFileSync(file, 'const token = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij1234";\n', "utf-8");

    const result = gateSecurity(["src/_review-fixtures/unsafe-secrets.mjs"]);
    assert.equal(result.status, "fail");
    assert.ok(result.details.some((d) => d.includes("GitHub token")));
  });

  it("passes clean code", () => {
    const file = join(FIXTURES_DIR, "clean-code.mjs");
    writeFileSync(file, 'export function hello() { return "world"; }\n', "utf-8");

    const result = gateSecurity(["src/_review-fixtures/clean-code.mjs"]);
    assert.equal(result.status, "pass");
  });

  it("handles empty file list", () => {
    const result = gateSecurity([]);
    // Falls back to scanning all source files
    assert.ok(result.name === "Security");
    assert.ok(["pass", "warn", "fail"].includes(result.status));
    assert.ok(Array.isArray(result.details));
  });
});

describe("gateCodeQuality", () => {
  beforeEach(() => ensureDir(FIXTURES_DIR));
  afterEach(() => {
    cleanFixture(join(FIXTURES_DIR, "quality-issues.mjs"));
    cleanFixture(join(FIXTURES_DIR, "quality-clean.mjs"));
  });

  it("detects console.log in source files", () => {
    const file = join(FIXTURES_DIR, "quality-issues.mjs");
    writeFileSync(file, 'export function debug() {\n  console.log("debug");\n}\n', "utf-8");

    const result = gateCodeQuality(["src/_review-fixtures/quality-issues.mjs"]);
    assert.equal(result.status, "warn");
    assert.ok(result.details.some((d) => d.includes("console.log")));
  });

  it("detects TODO markers in comments", () => {
    const file = join(FIXTURES_DIR, "quality-issues.mjs");
    writeFileSync(file, '// TODO: fix this later\nexport function stub() {}\n', "utf-8");

    const result = gateCodeQuality(["src/_review-fixtures/quality-issues.mjs"]);
    // TODO in comments is info-level, not a failure
    assert.ok(["pass", "warn"].includes(result.status));
    if (result.items) {
      assert.ok(result.items.some((i) => i.issue.includes("TODO")));
    }
  });

  it("passes clean source files", () => {
    const file = join(FIXTURES_DIR, "quality-clean.mjs");
    writeFileSync(file, 'export function add(a, b) { return a + b; }\n', "utf-8");

    const result = gateCodeQuality(["src/_review-fixtures/quality-clean.mjs"]);
    assert.equal(result.status, "pass");
  });
});

describe("generateReport", () => {
  it("generates Markdown with all gates", () => {
    const result = {
      timestamp: "2026-02-28T12:00:00.000Z",
      overall: "pass",
      summary: { passed: 5, warned: 0, failed: 0, total: 5 },
      gates: [
        { name: "Tests", status: "pass", details: ["All 37 tests passed"] },
        { name: "Security", status: "pass", details: ["No issues found"] },
        { name: "Conventions", status: "pass", details: ["All good"] },
        { name: "Code Quality", status: "pass", details: ["No issues"] },
        { name: "Diff Size", status: "pass", details: ["5 files, +100/-20 lines"] },
      ],
    };

    const report = generateReport(result);
    assert.ok(report.includes("## Pre-PR Review Report"));
    assert.ok(report.includes("PASS"));
    assert.ok(report.includes("5 passed"));
    assert.ok(report.includes("Tests"));
    assert.ok(report.includes("Security"));
  });

  it("includes details section for failures", () => {
    const result = {
      timestamp: "2026-02-28T12:00:00.000Z",
      overall: "fail",
      summary: { passed: 3, warned: 1, failed: 1, total: 5 },
      gates: [
        { name: "Tests", status: "fail", details: ["2 tests failed"] },
        { name: "Security", status: "warn", details: ["Possible eval() usage"] },
        { name: "Conventions", status: "pass", details: ["All good"] },
        { name: "Code Quality", status: "pass", details: ["No issues"] },
        { name: "Diff Size", status: "pass", details: ["5 files"] },
      ],
    };

    const report = generateReport(result);
    assert.ok(report.includes("FAIL"));
    assert.ok(report.includes("### Details"));
    assert.ok(report.includes("2 tests failed"));
    assert.ok(report.includes("eval()"));
  });

  it("omits details section when all gates pass", () => {
    const result = {
      timestamp: "2026-02-28T12:00:00.000Z",
      overall: "pass",
      summary: { passed: 5, warned: 0, failed: 0, total: 5 },
      gates: [
        { name: "Tests", status: "pass", details: ["All passed"] },
      ],
    };

    const report = generateReport(result);
    assert.ok(!report.includes("### Details"));
  });
});

describe("runAllGates", () => {
  it("runs a single gate when specified", () => {
    const result = runAllGates({ gate: "security" });
    assert.equal(result.gates.length, 1);
    assert.equal(result.gates[0].name, "Security");
    assert.ok(["pass", "warn", "fail"].includes(result.overall));
  });

  it("returns structured result with summary", () => {
    const result = runAllGates({ gate: "diffSize" });
    assert.ok(result.timestamp);
    assert.ok(result.summary);
    assert.equal(typeof result.summary.passed, "number");
    assert.equal(typeof result.summary.total, "number");
  });

  it("handles unknown gate name", () => {
    const result = runAllGates({ gate: "nonexistent" });
    assert.equal(result.overall, "fail");
    assert.ok(result.gates[0].details[0].includes("Unknown gate"));
  });
});

describe("CLI", () => {
  it("shows help with --help", () => {
    const out = run("--help");
    assert.ok(out.includes("Usage:"));
    assert.ok(out.includes("Quality Gates:"));
    assert.ok(out.includes("tests"));
    assert.ok(out.includes("security"));
    assert.ok(out.includes("conventions"));
    assert.ok(out.includes("diffSize"));
  });

  it("runs a single gate with --gate", () => {
    const out = run("--gate security --force");
    assert.ok(out.includes("Security"));
    assert.ok(out.includes("Review:"));
  });

  it("outputs JSON with --json", () => {
    const out = run("--gate diffSize --json --force");
    // The JSON output should be parseable
    const jsonPart = out.split("\n").filter((l) => l.startsWith("{") || l.startsWith("}") || l.startsWith("  ")).join("\n");
    assert.ok(jsonPart.includes('"overall"'));
    assert.ok(jsonPart.includes('"gates"'));
  });

  it("writes report to file with --report", () => {
    ensureDir(TMP_DIR);
    const reportPath = join(TMP_DIR, "test-review-report.md");

    try {
      run(`--gate diffSize --force --report "${reportPath}"`);
      assert.ok(existsSync(reportPath));
      const content = readFileSync(reportPath, "utf-8");
      assert.ok(content.includes("## Pre-PR Review Report"));
    } finally {
      cleanFixture(reportPath);
    }
  });

  it("uses --force to exit 0 even on warnings", () => {
    // --force should always succeed (exit 0)
    const out = run("--force");
    assert.ok(out.includes("Review:"));
  });
});

describe("pre-pr-check hook", () => {
  const HOOK_PATH = join(PROJECT_ROOT, ".claude", "hooks", "pre-pr-check.mjs");
  const TMP_INPUT = join(TMP_DIR, "hook-input.json");

  function runHook(inputObj) {
    ensureDir(TMP_DIR);
    writeFileSync(TMP_INPUT, JSON.stringify(inputObj), "utf-8");
    try {
      return execSync(`node "${HOOK_PATH}" < "${TMP_INPUT}"`, {
        encoding: "utf-8",
        cwd: PROJECT_ROOT,
        timeout: 10000,
      }).trim();
    } finally {
      cleanFixture(TMP_INPUT);
    }
  }

  it("allows non-Bash tool calls through", () => {
    const output = runHook({ tool_name: "Read", tool_input: { file_path: "/tmp/file.txt" } });
    assert.equal(output, "");
  });

  it("allows non-PR Bash commands through", () => {
    const output = runHook({ tool_name: "Bash", tool_input: { command: "npm test" } });
    assert.equal(output, "");
  });

  it("blocks gh pr create without review", () => {
    // Remove any existing marker first
    const markerPath = join(PROJECT_ROOT, ".claude", "audit", "_review-passed.marker");
    cleanFixture(markerPath);

    const output = runHook({
      tool_name: "Bash",
      tool_input: { command: 'gh pr create --title "test"' },
    });

    assert.ok(output.length > 0, "Hook should produce output");
    const parsed = JSON.parse(output);
    assert.equal(parsed.decision, "block");
    assert.ok(parsed.reason.includes("Pre-PR review"));
  });

  it("allows gh pr create with --force flag", () => {
    const output = runHook({
      tool_name: "Bash",
      tool_input: { command: 'gh pr create --title "test" --force' },
    });
    assert.equal(output, "");
  });
});
