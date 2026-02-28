import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  writeFileSync,
  existsSync,
  unlinkSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..");
const SCAN_SCRIPT = join(PROJECT_ROOT, "scripts", "scan.mjs");

// Import scanner functions for unit testing
const { scanMarkers, scanTestGaps, scanAntiPatterns, contentHash, scanAll } =
  await import("../scripts/scan.mjs");

function runScan(args = "") {
  return execSync(`node "${SCAN_SCRIPT}" ${args}`, {
    encoding: "utf-8",
    cwd: PROJECT_ROOT,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

// Temp directory for test fixture files
const FIXTURE_DIR = join(PROJECT_ROOT, "src", "_test-fixtures");

function createFixture(filename, content) {
  if (!existsSync(FIXTURE_DIR)) {
    mkdirSync(FIXTURE_DIR, { recursive: true });
  }
  const filePath = join(FIXTURE_DIR, filename);
  writeFileSync(filePath, content, "utf8");
  return filePath;
}

function cleanupFixtures() {
  if (existsSync(FIXTURE_DIR)) {
    rmSync(FIXTURE_DIR, { recursive: true, force: true });
  }
}

describe("scan.mjs CLI", () => {
  it("shows help with --help", () => {
    const output = runScan("--help");
    assert.ok(output.includes("Usage: node scripts/scan.mjs"));
    assert.ok(output.includes("scan"));
    assert.ok(output.includes("create"));
  });

  it("outputs JSON with --json flag", () => {
    const output = runScan("--json");
    const findings = JSON.parse(output);
    assert.ok(Array.isArray(findings));
  });

  it("runs scan command by default", () => {
    const output = runScan("");
    // Should produce output (either findings or "clean" message)
    assert.ok(output.length > 0);
  });
});

describe("scanMarkers()", () => {
  afterEach(() => cleanupFixtures());

  it("detects TODO comments", () => {
    const file = createFixture("todo-test.mjs", "// TODO: Fix this bug\n");
    const findings = scanMarkers(file);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].marker, "TODO");
    assert.equal(findings[0].message, "Fix this bug");
    assert.equal(findings[0].line, 1);
  });

  it("detects FIXME comments", () => {
    const file = createFixture(
      "fixme-test.mjs",
      "const x = 1;\n// FIXME: Memory leak\n",
    );
    const findings = scanMarkers(file);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].marker, "FIXME");
    assert.equal(findings[0].line, 2);
  });

  it("detects HACK, BUG, and XXX comments", () => {
    const file = createFixture(
      "multi-test.mjs",
      [
        "// HACK: Temporary workaround",
        "const y = 2;",
        "// BUG: Off-by-one error",
        "// XXX: Needs refactoring",
      ].join("\n"),
    );
    const findings = scanMarkers(file);
    assert.equal(findings.length, 3);
    assert.deepEqual(
      findings.map((f) => f.marker),
      ["HACK", "BUG", "XXX"],
    );
  });

  it("ignores markers not in comments", () => {
    const file = createFixture(
      "no-comment-test.mjs",
      'const msg = "TODO: this is a string";\nconst re = /TODO|FIXME/;\n',
    );
    const findings = scanMarkers(file);
    assert.equal(findings.length, 0);
  });

  it("includes surrounding context", () => {
    const file = createFixture(
      "context-test.mjs",
      "line1\nline2\n// TODO: Important\nline4\nline5\n",
    );
    const findings = scanMarkers(file);
    assert.equal(findings.length, 1);
    assert.ok(findings[0].context.includes(">>>"));
    assert.ok(findings[0].context.includes("line2"));
  });

  it("returns empty array for non-existent file", () => {
    const findings = scanMarkers("/nonexistent/file.mjs");
    assert.deepEqual(findings, []);
  });
});

describe("scanTestGaps()", () => {
  afterEach(() => cleanupFixtures());

  it("detects source files without test files", () => {
    createFixture("no-test-for-me.mjs", "export const x = 1;\n");
    const findings = scanTestGaps();
    const gapFinding = findings.find((f) =>
      f.file.includes("no-test-for-me.mjs"),
    );
    assert.ok(gapFinding, "Should detect missing test file");
    assert.equal(gapFinding.type, "test-gap");
    assert.equal(gapFinding.marker, "TEST");
  });

  it("does not flag files that have tests", () => {
    // hello.mjs has hello.test.mjs, math-utils.mjs has math-utils.test.mjs
    const findings = scanTestGaps();
    const helloGap = findings.find((f) => f.file === "src/hello.mjs" || f.file === "src\\hello.mjs");
    assert.equal(helloGap, undefined, "hello.mjs should not be flagged");
  });
});

describe("scanAntiPatterns()", () => {
  afterEach(() => cleanupFixtures());

  it("detects console.log in production source", () => {
    const file = createFixture(
      "with-log.mjs",
      "export function foo() {\n  console.log('debug');\n}\n",
    );
    const findings = scanAntiPatterns(file);
    const logFinding = findings.find((f) => f.message.includes("console.log"));
    assert.ok(logFinding, "Should detect console.log");
  });

  it("detects empty catch blocks", () => {
    const file = createFixture(
      "empty-catch.mjs",
      "try { doSomething(); } catch (e) {}\n",
    );
    const findings = scanAntiPatterns(file);
    const catchFinding = findings.find((f) =>
      f.message.includes("Empty catch"),
    );
    assert.ok(catchFinding, "Should detect empty catch block");
  });
});

describe("contentHash()", () => {
  it("produces consistent hashes", () => {
    const h1 = contentHash("marker", join(PROJECT_ROOT, "src/foo.mjs"), "TODO: Fix bug");
    const h2 = contentHash("marker", join(PROJECT_ROOT, "src/foo.mjs"), "TODO: Fix bug");
    assert.equal(h1, h2);
  });

  it("produces different hashes for different content", () => {
    const h1 = contentHash("marker", join(PROJECT_ROOT, "src/foo.mjs"), "TODO: Fix bug");
    const h2 = contentHash("marker", join(PROJECT_ROOT, "src/foo.mjs"), "TODO: Add feature");
    assert.notEqual(h1, h2);
  });

  it("produces 12-char hex strings", () => {
    const h = contentHash("test", join(PROJECT_ROOT, "file.mjs"), "content");
    assert.match(h, /^[a-f0-9]{12}$/);
  });
});
