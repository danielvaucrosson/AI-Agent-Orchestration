import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  unlinkSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

import {
  FAILURE_CATEGORIES,
  categorizeError,
  extractFailures,
  parseAuditFile,
  loadSessions,
  analyzePatterns,
  computeErrorProneFiles,
  generateRecommendations,
  generateReport,
  generateSyntheticSessions,
  writeSyntheticSessions,
} from "../scripts/failure-patterns.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..");
const TEST_DIR = join(PROJECT_ROOT, ".claude", "audit", "_test-patterns");
const SCRIPT = join(PROJECT_ROOT, "scripts", "failure-patterns.mjs");

function runScript(args) {
  return execSync(`node "${SCRIPT}" ${args}`, {
    encoding: "utf-8",
    cwd: PROJECT_ROOT,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function cleanup() {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

function writeTestSession(filename, entries) {
  if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
  const lines = entries.map((e) => JSON.stringify(e)).join("\n");
  writeFileSync(join(TEST_DIR, filename), lines + "\n", "utf8");
}

// --- Test Fixtures ---

const SESSION_WITH_FAILURES = [
  { ts: "2026-03-01T10:00:00Z", type: "session_start", branch: "feature/DVA-50-test", issueId: "DVA-50" },
  { ts: "2026-03-01T10:00:01Z", type: "tool_start", tool: "Read", summary: "auth.mjs" },
  { ts: "2026-03-01T10:00:02Z", type: "tool_end", tool: "Read", success: true },
  { ts: "2026-03-01T10:00:03Z", type: "tool_start", tool: "Bash", summary: "npm test" },
  { ts: "2026-03-01T10:00:10Z", type: "tool_end", tool: "Bash", success: false, error: "Error: test suite failed\nExit code 1" },
  { ts: "2026-03-01T10:00:11Z", type: "tool_start", tool: "Edit", summary: "auth.mjs" },
  { ts: "2026-03-01T10:00:15Z", type: "tool_end", tool: "Edit", success: false, error: "Error: ENOENT: no such file or directory" },
  { ts: "2026-03-01T10:00:16Z", type: "tool_start", tool: "Bash", summary: "git merge main" },
  { ts: "2026-03-01T10:00:20Z", type: "tool_end", tool: "Bash", success: false, error: "CONFLICT (content): Merge conflict in src/api.mjs" },
  { ts: "2026-03-01T10:00:21Z", type: "tool_start", tool: "Bash", summary: "node scripts/linear.mjs" },
  { ts: "2026-03-01T10:00:22Z", type: "tool_end", tool: "Bash", success: false, error: "Error: Linear API returned 429 rate limit exceeded" },
  { ts: "2026-03-01T10:00:23Z", type: "tool_start", tool: "Bash", summary: "npm run build" },
  { ts: "2026-03-01T10:00:30Z", type: "tool_end", tool: "Bash", success: false, error: "Error: command timeout after 120000ms" },
  { ts: "2026-03-01T10:00:31Z", type: "tool_start", tool: "Bash", summary: "eslint ." },
  { ts: "2026-03-01T10:00:35Z", type: "tool_end", tool: "Bash", success: false, error: "eslint: 5 errors found" },
];

const SESSION_CLEAN = [
  { ts: "2026-03-01T11:00:00Z", type: "session_start", branch: "feature/DVA-51-clean", issueId: "DVA-51" },
  { ts: "2026-03-01T11:00:01Z", type: "tool_start", tool: "Read", summary: "index.mjs" },
  { ts: "2026-03-01T11:00:02Z", type: "tool_end", tool: "Read", success: true },
  { ts: "2026-03-01T11:00:03Z", type: "tool_start", tool: "Edit", summary: "index.mjs" },
  { ts: "2026-03-01T11:00:04Z", type: "tool_end", tool: "Edit", success: true },
  { ts: "2026-03-01T11:00:05Z", type: "tool_start", tool: "Bash", summary: "npm test" },
  { ts: "2026-03-01T11:00:10Z", type: "tool_end", tool: "Bash", success: true },
];

// --- Tests ---

describe("failure categories", () => {
  it("has 6 defined categories", () => {
    assert.equal(FAILURE_CATEGORIES.length, 6);
  });

  it("each category has required fields", () => {
    for (const cat of FAILURE_CATEGORIES) {
      assert.ok(cat.id, "missing id");
      assert.ok(cat.name, "missing name");
      assert.ok(cat.description, "missing description");
      assert.ok(Array.isArray(cat.patterns), "patterns must be array");
      assert.ok(cat.patterns.length > 0, `${cat.id} has no patterns`);
    }
  });

  it("category IDs are unique", () => {
    const ids = FAILURE_CATEGORIES.map((c) => c.id);
    assert.equal(ids.length, new Set(ids).size);
  });
});

describe("categorizeError", () => {
  it("categorizes test failures", () => {
    assert.equal(categorizeError("Error: test suite failed"), "test-failure");
    assert.equal(categorizeError("AssertionError: expected true to be false"), "test-failure");
    assert.equal(categorizeError("3 failing tests"), "test-failure");
  });

  it("categorizes lint errors", () => {
    assert.equal(categorizeError("eslint: 5 errors found"), "lint-error");
    assert.equal(categorizeError("SyntaxError: Unexpected token"), "lint-error");
    assert.equal(categorizeError("prettier check failed"), "lint-error");
  });

  it("categorizes merge conflicts", () => {
    assert.equal(categorizeError("CONFLICT (content): Merge conflict in file"), "merge-conflict");
    assert.equal(categorizeError("error: automatic merge failed"), "merge-conflict");
  });

  it("categorizes API errors", () => {
    assert.equal(categorizeError("Error: Linear API returned 429 rate limit exceeded"), "api-error");
    assert.equal(categorizeError("Error: fetch failed ECONNREFUSED"), "api-error");
    assert.equal(categorizeError("Error: GitHub API 403 Forbidden"), "api-error");
  });

  it("categorizes timeouts", () => {
    assert.equal(categorizeError("Error: command timeout after 120000ms"), "timeout");
    assert.equal(categorizeError("Error: process timed out"), "timeout");
  });

  it("categorizes wrong approach errors", () => {
    assert.equal(categorizeError("Error: ENOENT: no such file or directory"), "wrong-approach");
    assert.equal(categorizeError("Error: Cannot find module './missing'"), "wrong-approach");
    assert.equal(categorizeError("TypeError: undefined is not a function"), "wrong-approach");
  });

  it("returns uncategorized for unknown errors", () => {
    assert.equal(categorizeError("Something went wrong"), "uncategorized");
    assert.equal(categorizeError(""), "uncategorized");
    assert.equal(categorizeError(null), "uncategorized");
  });
});

describe("extractFailures", () => {
  it("extracts failures from tool_end entries", () => {
    const failures = extractFailures(SESSION_WITH_FAILURES);
    assert.equal(failures.length, 6);
  });

  it("assigns correct categories to each failure", () => {
    const failures = extractFailures(SESSION_WITH_FAILURES);
    const categories = failures.map((f) => f.category);
    assert.ok(categories.includes("test-failure"));
    assert.ok(categories.includes("wrong-approach"));
    assert.ok(categories.includes("merge-conflict"));
    assert.ok(categories.includes("api-error"));
    assert.ok(categories.includes("timeout"));
    assert.ok(categories.includes("lint-error"));
  });

  it("extracts no failures from clean session", () => {
    const failures = extractFailures(SESSION_CLEAN);
    assert.equal(failures.length, 0);
  });

  it("handles error-type entries", () => {
    const entries = [
      { ts: "2026-03-01T10:00:00Z", type: "error", tool: "system", message: "Error: test suite failed" },
    ];
    const failures = extractFailures(entries);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].category, "test-failure");
  });
});

describe("parseAuditFile", () => {
  beforeEach(() => cleanup());
  afterEach(() => cleanup());

  it("parses valid JSONL file", () => {
    writeTestSession("test.jsonl", SESSION_WITH_FAILURES);
    const entries = parseAuditFile(join(TEST_DIR, "test.jsonl"));
    assert.equal(entries.length, SESSION_WITH_FAILURES.length);
    assert.equal(entries[0].type, "session_start");
  });

  it("returns empty array for missing file", () => {
    const entries = parseAuditFile("/nonexistent/path.jsonl");
    assert.deepEqual(entries, []);
  });

  it("skips malformed lines", () => {
    if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
    writeFileSync(
      join(TEST_DIR, "bad.jsonl"),
      '{"type":"session_start"}\nnot json\n{"type":"tool_start"}\n',
      "utf8",
    );
    const entries = parseAuditFile(join(TEST_DIR, "bad.jsonl"));
    assert.equal(entries.length, 2);
  });
});

describe("loadSessions", () => {
  beforeEach(() => cleanup());
  afterEach(() => cleanup());

  it("loads all JSONL files from directory", () => {
    writeTestSession("session-DVA-50.jsonl", SESSION_WITH_FAILURES);
    writeTestSession("session-DVA-51.jsonl", SESSION_CLEAN);
    const sessions = loadSessions(TEST_DIR);
    assert.equal(sessions.length, 2);
  });

  it("extracts issue ID from session_start", () => {
    writeTestSession("session-DVA-50.jsonl", SESSION_WITH_FAILURES);
    const sessions = loadSessions(TEST_DIR);
    assert.equal(sessions[0].issueId, "DVA-50");
  });

  it("falls back to filename for issue ID", () => {
    const entries = [
      { ts: "2026-03-01T10:00:00Z", type: "tool_start", tool: "Read", summary: "file.mjs" },
    ];
    writeTestSession("session-DVA-99.jsonl", entries);
    const sessions = loadSessions(TEST_DIR);
    assert.equal(sessions[0].issueId, "DVA-99");
  });

  it("returns empty for nonexistent directory", () => {
    const sessions = loadSessions("/nonexistent/dir");
    assert.deepEqual(sessions, []);
  });
});

describe("analyzePatterns", () => {
  it("computes correct totals", () => {
    const sessions = [
      { file: "s1.jsonl", issueId: "DVA-50", branch: "", entries: SESSION_WITH_FAILURES },
      { file: "s2.jsonl", issueId: "DVA-51", branch: "", entries: SESSION_CLEAN },
    ];
    const analysis = analyzePatterns(sessions);
    assert.equal(analysis.totalSessions, 2);
    assert.equal(analysis.totalFailures, 6);
  });

  it("identifies top 3 failure modes", () => {
    const sessions = [
      { file: "s1.jsonl", issueId: "DVA-50", branch: "", entries: SESSION_WITH_FAILURES },
    ];
    const analysis = analyzePatterns(sessions);
    assert.ok(analysis.topFailureModes.length <= 3);
    assert.ok(analysis.topFailureModes.length > 0);
  });

  it("computes category breakdown with percentages", () => {
    const sessions = [
      { file: "s1.jsonl", issueId: "DVA-50", branch: "", entries: SESSION_WITH_FAILURES },
    ];
    const analysis = analyzePatterns(sessions);
    const testFailure = analysis.categoryBreakdown["test-failure"];
    assert.ok(testFailure);
    assert.ok(testFailure.count > 0);
    assert.ok(parseFloat(testFailure.percentage) > 0);
  });

  it("computes session-level failure rates", () => {
    const sessions = [
      { file: "s1.jsonl", issueId: "DVA-50", branch: "", entries: SESSION_WITH_FAILURES },
      { file: "s2.jsonl", issueId: "DVA-51", branch: "", entries: SESSION_CLEAN },
    ];
    const analysis = analyzePatterns(sessions);
    const s1 = analysis.sessionStats.find((s) => s.issueId === "DVA-50");
    const s2 = analysis.sessionStats.find((s) => s.issueId === "DVA-51");
    assert.ok(s1.failureRate > 0);
    assert.equal(s2.failureRate, 0);
  });

  it("handles empty sessions", () => {
    const analysis = analyzePatterns([]);
    assert.equal(analysis.totalSessions, 0);
    assert.equal(analysis.totalFailures, 0);
  });
});

describe("computeErrorProneFiles", () => {
  it("identifies files preceding failures", () => {
    const sessions = [
      { file: "s1.jsonl", issueId: "DVA-50", branch: "", entries: SESSION_WITH_FAILURES },
    ];
    const files = computeErrorProneFiles(sessions);
    assert.ok(files.length > 0);
    assert.ok(files[0].failureCorrelation > 0);
  });

  it("returns at most 10 files", () => {
    const synth = generateSyntheticSessions(20);
    const files = computeErrorProneFiles(synth);
    assert.ok(files.length <= 10);
  });
});

describe("generateRecommendations", () => {
  it("produces recommendations for top failure modes", () => {
    const sessions = [
      { file: "s1.jsonl", issueId: "DVA-50", branch: "", entries: SESSION_WITH_FAILURES },
    ];
    const analysis = analyzePatterns(sessions);
    const recs = generateRecommendations(analysis);
    assert.ok(recs.length > 0);
    assert.ok(recs.every((r) => r.priority && r.category && r.finding && r.recommendation));
  });

  it("includes error-prone file recommendation when files exist", () => {
    const sessions = [
      { file: "s1.jsonl", issueId: "DVA-50", branch: "", entries: SESSION_WITH_FAILURES },
    ];
    const analysis = analyzePatterns(sessions);
    const recs = generateRecommendations(analysis);
    const fileRec = recs.find((r) => r.category === "Error-Prone Files");
    assert.ok(fileRec);
  });

  it("handles analysis with no failures", () => {
    const sessions = [
      { file: "s1.jsonl", issueId: "DVA-51", branch: "", entries: SESSION_CLEAN },
    ];
    const analysis = analyzePatterns(sessions);
    const recs = generateRecommendations(analysis);
    // Should have no recommendations (no failures)
    assert.equal(recs.length, 0);
  });
});

describe("generateReport", () => {
  it("produces valid Markdown with all sections", () => {
    const sessions = [
      { file: "s1.jsonl", issueId: "DVA-50", branch: "", entries: SESSION_WITH_FAILURES },
    ];
    const analysis = analyzePatterns(sessions);
    const report = generateReport(analysis);
    assert.ok(report.includes("# Failure Pattern Detection Report"));
    assert.ok(report.includes("## Summary"));
    assert.ok(report.includes("## Top Failure Modes"));
    assert.ok(report.includes("## Category Breakdown"));
    assert.ok(report.includes("## Recommendations"));
    assert.ok(report.includes("## Session Details"));
  });

  it("handles zero-failure report", () => {
    const sessions = [
      { file: "s1.jsonl", issueId: "DVA-51", branch: "", entries: SESSION_CLEAN },
    ];
    const analysis = analyzePatterns(sessions);
    const report = generateReport(analysis);
    assert.ok(report.includes("No failures detected"));
  });
});

describe("generateSyntheticSessions", () => {
  it("generates requested number of sessions", () => {
    const sessions = generateSyntheticSessions(5);
    assert.equal(sessions.length, 5);
  });

  it("each session has required fields", () => {
    const sessions = generateSyntheticSessions(3);
    for (const s of sessions) {
      assert.ok(s.file);
      assert.ok(s.issueId);
      assert.ok(s.branch);
      assert.ok(Array.isArray(s.entries));
      assert.ok(s.entries.length > 0);
      assert.equal(s.entries[0].type, "session_start");
    }
  });

  it("produces deterministic output with same seed", () => {
    const a = generateSyntheticSessions(3, 42);
    const b = generateSyntheticSessions(3, 42);
    assert.deepEqual(
      a.map((s) => s.entries.length),
      b.map((s) => s.entries.length),
    );
  });

  it("produces different output with different seeds", () => {
    const a = generateSyntheticSessions(3, 42);
    const b = generateSyntheticSessions(3, 99);
    // Very unlikely to be identical
    const aLengths = a.map((s) => s.entries.length);
    const bLengths = b.map((s) => s.entries.length);
    assert.notDeepEqual(aLengths, bLengths);
  });

  it("includes both successes and failures", () => {
    const sessions = generateSyntheticSessions(10, 42);
    const allEntries = sessions.flatMap((s) => s.entries);
    const successes = allEntries.filter((e) => e.type === "tool_end" && e.success);
    const failures = allEntries.filter((e) => e.type === "tool_end" && !e.success);
    assert.ok(successes.length > 0, "should have successes");
    assert.ok(failures.length > 0, "should have failures");
  });
});

describe("writeSyntheticSessions", () => {
  beforeEach(() => cleanup());
  afterEach(() => cleanup());

  it("writes sessions as JSONL files", () => {
    const sessions = generateSyntheticSessions(3);
    writeSyntheticSessions(TEST_DIR, sessions);
    for (const s of sessions) {
      assert.ok(existsSync(join(TEST_DIR, s.file)));
    }
  });

  it("written files can be loaded back", () => {
    const sessions = generateSyntheticSessions(3);
    writeSyntheticSessions(TEST_DIR, sessions);
    const loaded = loadSessions(TEST_DIR);
    assert.equal(loaded.length, 3);
  });
});

describe("CLI", () => {
  beforeEach(() => cleanup());
  afterEach(() => cleanup());

  it("shows help with no arguments", () => {
    const output = runScript("");
    assert.ok(output.includes("Usage:"));
    assert.ok(output.includes("analyze"));
    assert.ok(output.includes("report"));
    assert.ok(output.includes("categories"));
  });

  it("categories command lists all categories", () => {
    const output = runScript("categories");
    assert.ok(output.includes("test-failure"));
    assert.ok(output.includes("lint-error"));
    assert.ok(output.includes("merge-conflict"));
    assert.ok(output.includes("api-error"));
    assert.ok(output.includes("timeout"));
    assert.ok(output.includes("wrong-approach"));
  });

  it("analyze command with synthetic data", () => {
    const sessions = generateSyntheticSessions(5);
    writeSyntheticSessions(TEST_DIR, sessions);
    const output = runScript(`analyze "${TEST_DIR}"`);
    assert.ok(output.includes("Sessions: 5"));
    assert.ok(output.includes("Top failure modes:"));
  });

  it("analyze --json produces valid JSON", () => {
    const sessions = generateSyntheticSessions(5);
    writeSyntheticSessions(TEST_DIR, sessions);
    const output = runScript(`analyze "${TEST_DIR}" --json`);
    const parsed = JSON.parse(output);
    assert.equal(parsed.totalSessions, 5);
    assert.ok(parsed.categoryBreakdown);
  });

  it("report command generates Markdown", () => {
    const sessions = generateSyntheticSessions(5);
    writeSyntheticSessions(TEST_DIR, sessions);
    const output = runScript(`report "${TEST_DIR}"`);
    assert.ok(output.includes("# Failure Pattern Detection Report"));
    assert.ok(output.includes("## Recommendations"));
  });

  it("report --output writes to file", () => {
    const sessions = generateSyntheticSessions(5);
    writeSyntheticSessions(TEST_DIR, sessions);
    const outFile = join(TEST_DIR, "test-report.md");
    runScript(`report "${TEST_DIR}" --output "${outFile}"`);
    assert.ok(existsSync(outFile));
    const content = readFileSync(outFile, "utf8");
    assert.ok(content.includes("# Failure Pattern Detection Report"));
  });

  it("end-to-end: 10+ sessions with pattern detection", () => {
    // Acceptance criteria: tested with 10+ sessions
    const sessions = generateSyntheticSessions(12);
    writeSyntheticSessions(TEST_DIR, sessions);
    const output = runScript(`analyze "${TEST_DIR}" --json`);
    const parsed = JSON.parse(output);

    assert.equal(parsed.totalSessions, 12);
    assert.ok(parsed.totalFailures > 0, "should detect failures");
    assert.ok(parsed.topFailureModes.length > 0, "should identify top failure modes");
    assert.ok(parsed.topFailureModes.length <= 3, "should limit to top 3");
    assert.ok(parsed.errorProneFiles.length > 0, "should find error-prone files");

    // Verify actionable recommendations
    const reportOutput = runScript(`report "${TEST_DIR}"`);
    assert.ok(reportOutput.includes("Recommendation:"), "report should include recommendations");
  });
});
