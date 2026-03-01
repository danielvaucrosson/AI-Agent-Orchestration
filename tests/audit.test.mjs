import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  unlinkSync,
  mkdirSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..");
const AUDIT_DIR = join(PROJECT_ROOT, ".claude", "audit");
const LOG_PATH = join(AUDIT_DIR, "current.jsonl");
const AUDIT_SCRIPT = join(PROJECT_ROOT, "scripts", "audit.mjs");

function runAudit(args) {
  return execSync(`node "${AUDIT_SCRIPT}" ${args}`, {
    encoding: "utf-8",
    cwd: PROJECT_ROOT,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function cleanup() {
  if (existsSync(LOG_PATH)) {
    unlinkSync(LOG_PATH);
  }
}

describe("audit.mjs CLI", () => {
  beforeEach(() => cleanup());
  afterEach(() => cleanup());

  it("shows help when called with no arguments", () => {
    const output = runAudit("");
    assert.ok(output.includes("Usage: node scripts/audit.mjs"));
    assert.ok(output.includes("init"));
    assert.ok(output.includes("export"));
  });

  it("init creates a session log", () => {
    const output = runAudit("init");
    assert.ok(output.includes("Audit session started"));
    assert.ok(existsSync(LOG_PATH));

    const lines = readFileSync(LOG_PATH, "utf8").trim().split("\n");
    assert.equal(lines.length, 1);

    const entry = JSON.parse(lines[0]);
    assert.equal(entry.type, "session_start");
    assert.ok(entry.ts);
    assert.ok(entry.branch);
  });

  it("log adds a manual entry", () => {
    runAudit("init");
    const output = runAudit('log decision "Test decision"');
    assert.ok(output.includes("Logged [decision]"));

    const lines = readFileSync(LOG_PATH, "utf8").trim().split("\n");
    assert.equal(lines.length, 2); // session_start + manual

    const entry = JSON.parse(lines[1]);
    assert.equal(entry.type, "manual");
    assert.equal(entry.category, "decision");
    assert.equal(entry.message, "Test decision");
  });

  it("summary prints stats", () => {
    runAudit("init");
    runAudit('log note "Test note"');
    const output = runAudit("summary");
    assert.ok(output.includes("=== Audit Summary ==="));
    assert.ok(output.includes("Duration:"));
  });

  it("export generates Markdown", () => {
    runAudit("init");
    runAudit('log decision "Architecture choice"');
    const output = runAudit("export");
    assert.ok(output.includes("# Audit Trail"));
    assert.ok(output.includes("## Quick Stats"));
    assert.ok(output.includes("## Timeline"));
  });

  it("clear removes the log file", () => {
    runAudit("init");
    assert.ok(existsSync(LOG_PATH));

    const output = runAudit("clear");
    assert.ok(output.includes("Audit log cleared"));
    assert.ok(!existsSync(LOG_PATH));
  });

  it("summary with no log shows friendly message", () => {
    const output = runAudit("summary");
    assert.ok(output.includes("No audit log found"));
  });
});

describe("audit hooks", () => {
  const PRE_HOOK = join(PROJECT_ROOT, ".claude", "hooks", "audit-pre.mjs");
  const POST_HOOK = join(PROJECT_ROOT, ".claude", "hooks", "audit-post.mjs");
  const TMP_INPUT = join(AUDIT_DIR, "_test-input.json");

  function runHook(hookPath, inputObj) {
    // Write input to a temp file and redirect, avoids shell quoting issues
    writeFileSync(TMP_INPUT, JSON.stringify(inputObj), "utf8");
    execSync(`node "${hookPath}" < "${TMP_INPUT}"`, {
      encoding: "utf-8",
      cwd: PROJECT_ROOT,
    });
    if (existsSync(TMP_INPUT)) unlinkSync(TMP_INPUT);
  }

  beforeEach(() => cleanup());
  afterEach(() => {
    cleanup();
    if (existsSync(TMP_INPUT)) unlinkSync(TMP_INPUT);
  });

  it("PreToolUse hook logs tool_start entry", () => {
    runHook(PRE_HOOK, {
      tool_name: "Read",
      tool_input: { file_path: "/project/src/index.mjs" },
    });

    assert.ok(existsSync(LOG_PATH));
    const lines = readFileSync(LOG_PATH, "utf8").trim().split("\n");
    // Should have: session_start (auto) + tool_start
    assert.ok(lines.length >= 2);

    const toolEntry = JSON.parse(lines[lines.length - 1]);
    assert.equal(toolEntry.type, "tool_start");
    assert.equal(toolEntry.tool, "Read");
    assert.equal(toolEntry.summary, "index.mjs");
  });

  it("PostToolUse hook logs tool_end entry", () => {
    // First create a log with PreToolUse
    runHook(PRE_HOOK, {
      tool_name: "Bash",
      tool_input: { command: "npm test" },
    });

    // Then run PostToolUse with an error
    runHook(POST_HOOK, {
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      tool_output: "Error: test suite failed\nExit code 1",
    });

    const lines = readFileSync(LOG_PATH, "utf8").trim().split("\n");
    const lastEntry = JSON.parse(lines[lines.length - 1]);
    assert.equal(lastEntry.type, "tool_end");
    assert.equal(lastEntry.tool, "Bash");
    assert.equal(lastEntry.success, false);
    assert.ok(lastEntry.error);
  });

  it("PreToolUse hook skips TodoWrite", () => {
    runHook(PRE_HOOK, {
      tool_name: "TodoWrite",
      tool_input: { todos: [] },
    });

    // Should not have created a log file
    assert.ok(!existsSync(LOG_PATH));
  });
});
