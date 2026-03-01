import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseFlags,
  categorizeComment,
  isNonActionable,
  generatePrompt,
  generateSummary,
} from "../scripts/pr-feedback.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..");
const TMP_DIR = join(PROJECT_ROOT, "tests", "_tmp");

// Ensure tmp dir exists
mkdirSync(TMP_DIR, { recursive: true });

function run(args) {
  return execSync(`node "${join(PROJECT_ROOT, "scripts", "pr-feedback.mjs")}" ${args}`, {
    encoding: "utf-8",
    cwd: PROJECT_ROOT,
  });
}

// --- Sample feedback data ---
function sampleFeedback(overrides = {}) {
  return {
    pr_number: "42",
    repo: "user/repo",
    trigger_type: "review",
    collected_at: "2026-02-28T12:00:00.000Z",
    total_review_comments: 3,
    total_reviews: 1,
    total_issue_comments: 0,
    comments: [
      {
        id: 1001,
        type: "review_comment",
        path: "src/hello.mjs",
        line: 5,
        side: "RIGHT",
        diff_hunk: "@@ -1,5 +1,6 @@\n+console.log('debug');",
        body: "Please remove this debug console.log",
        author: "reviewer1",
        created_at: "2026-02-28T10:00:00Z",
        priority: "medium",
        category: "change-request",
      },
      {
        id: 1002,
        type: "review_comment",
        path: "src/math-utils.mjs",
        line: 12,
        side: "RIGHT",
        diff_hunk: "@@ -10,3 +10,5 @@\n+function add(a, b) { return a + b; }",
        body: "This function has a bug — it should validate inputs",
        author: "reviewer2",
        created_at: "2026-02-28T10:05:00Z",
        priority: "high",
        category: "bug",
      },
      {
        id: 1003,
        type: "review_body",
        path: "",
        line: null,
        side: null,
        diff_hunk: "",
        body: "Overall looks good, but consider adding error handling for edge cases.",
        author: "reviewer1",
        created_at: "2026-02-28T10:10:00Z",
        priority: "low",
        category: "suggestion",
        review_state: "COMMENTED",
      },
    ],
    ...overrides,
  };
}

// --- Tests ---

describe("parseFlags", () => {
  it("parses --key value pairs", () => {
    const flags = parseFlags(["--pr", "42", "--trigger", "review"]);
    assert.equal(flags.pr, "42");
    assert.equal(flags.trigger, "review");
  });

  it("parses --key=value pairs", () => {
    const flags = parseFlags(["--pr=42", "--output=/tmp/out.json"]);
    assert.equal(flags.pr, "42");
    assert.equal(flags.output, "/tmp/out.json");
  });

  it("parses boolean flags", () => {
    const flags = parseFlags(["--dry-run", "--verbose"]);
    assert.equal(flags["dry-run"], true);
    assert.equal(flags.verbose, true);
  });

  it("handles mixed formats", () => {
    const flags = parseFlags(["--pr", "7", "--output=/tmp/f.json", "--verbose"]);
    assert.equal(flags.pr, "7");
    assert.equal(flags.output, "/tmp/f.json");
    assert.equal(flags.verbose, true);
  });

  it("returns empty object for no flags", () => {
    const flags = parseFlags([]);
    assert.deepEqual(flags, {});
  });
});

describe("categorizeComment", () => {
  it("detects bug-related comments", () => {
    const r = categorizeComment("This has a bug in the validation logic");
    assert.equal(r.priority, "high");
    assert.equal(r.category, "bug");
  });

  it("detects security concerns", () => {
    const r = categorizeComment("This could be a SQL injection vulnerability");
    assert.equal(r.priority, "high");
    assert.equal(r.category, "security");
  });

  it("detects change requests", () => {
    const r = categorizeComment("Please rename this variable to something more descriptive");
    assert.equal(r.priority, "medium");
    assert.equal(r.category, "change-request");
  });

  it("detects suggestions", () => {
    const r = categorizeComment("Why not use a Map instead? Consider the performance impact");
    assert.equal(r.priority, "low");
    assert.equal(r.category, "suggestion");
  });

  it("detects style/formatting comments", () => {
    const r = categorizeComment("nit: inconsistent spacing here");
    assert.equal(r.priority, "low");
    assert.equal(r.category, "style");
  });

  it("defaults to medium/general for ambiguous comments", () => {
    const r = categorizeComment("Interesting approach here.");
    assert.equal(r.priority, "medium");
    assert.equal(r.category, "general");
  });
});

describe("isNonActionable", () => {
  it("flags empty strings", () => {
    assert.equal(isNonActionable(""), true);
    assert.equal(isNonActionable("    "), true);
  });

  it("flags very short strings", () => {
    assert.equal(isNonActionable("ok"), true);
    assert.equal(isNonActionable("yes"), true);
  });

  it("flags LGTM and praise", () => {
    assert.equal(isNonActionable("LGTM"), true);
    assert.equal(isNonActionable("Looks good!"), true);
    assert.equal(isNonActionable("Nice!"), true);
    assert.equal(isNonActionable("great"), true);
  });

  it("flags resolved markers", () => {
    assert.equal(isNonActionable("resolved"), true);
    assert.equal(isNonActionable("Done."), true);
    assert.equal(isNonActionable("fixed"), true);
  });

  it("flags emoji-only feedback", () => {
    assert.equal(isNonActionable("👍"), true);
    assert.equal(isNonActionable("✅"), true);
  });

  it("does NOT flag actionable comments", () => {
    assert.equal(isNonActionable("Please remove this debug log"), false);
    assert.equal(isNonActionable("This function needs error handling"), false);
    assert.equal(isNonActionable("Why not use async/await here?"), false);
  });
});

describe("generatePrompt", () => {
  it("generates a structured prompt from feedback", () => {
    const data = sampleFeedback();
    const prompt = generatePrompt(data);

    assert.ok(prompt.includes("# PR #42 Review Feedback"));
    assert.ok(prompt.includes("3 actionable comment(s)"));
    assert.ok(prompt.includes("src/hello.mjs"));
    assert.ok(prompt.includes("src/math-utils.mjs"));
    assert.ok(prompt.includes("console.log"));
    assert.ok(prompt.includes("[HIGH] bug"));
    assert.ok(prompt.includes("[MEDIUM] change-request"));
    assert.ok(prompt.includes("[LOW] suggestion"));
  });

  it("includes diff hunks in code blocks", () => {
    const data = sampleFeedback();
    const prompt = generatePrompt(data);
    assert.ok(prompt.includes("```diff"));
  });

  it("handles empty comments gracefully", () => {
    const data = sampleFeedback({ comments: [] });
    const prompt = generatePrompt(data);
    assert.ok(prompt.includes("No actionable review comments found"));
  });

  it("includes commit instructions", () => {
    const data = sampleFeedback();
    const prompt = generatePrompt(data);
    assert.ok(prompt.includes("Commit your changes"));
    assert.ok(prompt.includes("address PR #42 review feedback"));
  });
});

describe("generateSummary", () => {
  it("produces a readable summary", () => {
    const data = sampleFeedback();
    const summary = generateSummary(data);

    assert.ok(summary.includes("PR #42 Feedback Summary"));
    assert.ok(summary.includes("Total actionable comments: 3"));
    assert.ok(summary.includes("high=1"));
    assert.ok(summary.includes("medium=1"));
    assert.ok(summary.includes("low=1"));
    assert.ok(summary.includes("src/hello.mjs"));
    assert.ok(summary.includes("src/math-utils.mjs"));
  });

  it("lists affected files", () => {
    const data = sampleFeedback();
    const summary = generateSummary(data);
    assert.ok(summary.includes("Affected files (2)"));
  });
});

describe("CLI", () => {
  it("shows help with no arguments", () => {
    const out = run("");
    assert.ok(out.includes("Usage:"));
    assert.ok(out.includes("collect"));
    assert.ok(out.includes("prompt"));
    assert.ok(out.includes("reply"));
    assert.ok(out.includes("summary"));
  });

  it("prompt command produces output from JSON file", () => {
    const inputPath = join(TMP_DIR, "test-feedback.json");
    const outputPath = join(TMP_DIR, "test-prompt.md");

    try {
      writeFileSync(inputPath, JSON.stringify(sampleFeedback()), "utf-8");
      run(`prompt --input "${inputPath}" --output "${outputPath}"`);

      assert.ok(existsSync(outputPath));
      const content = readFileSync(outputPath, "utf-8");
      assert.ok(content.includes("# PR #42 Review Feedback"));
      assert.ok(content.includes("3 actionable comment(s)"));
    } finally {
      if (existsSync(inputPath)) unlinkSync(inputPath);
      if (existsSync(outputPath)) unlinkSync(outputPath);
    }
  });

  it("summary command shows collected comment stats", () => {
    const inputPath = join(TMP_DIR, "test-feedback-summary.json");

    try {
      writeFileSync(inputPath, JSON.stringify(sampleFeedback()), "utf-8");
      const out = run(`summary --input "${inputPath}"`);

      assert.ok(out.includes("PR #42 Feedback Summary"));
      assert.ok(out.includes("Total actionable comments: 3"));
    } finally {
      if (existsSync(inputPath)) unlinkSync(inputPath);
    }
  });

  it("prompt command errors without --input", () => {
    assert.throws(() => run("prompt"), /Error/);
  });
});
