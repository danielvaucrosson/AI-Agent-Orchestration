/**
 * Tests for .claude/hooks/check-linear-update.mjs (Stop hook)
 *
 * The hook is a top-level-await script with no dependency injection, so we
 * test it in two ways:
 *
 *  1. Pure-logic tests — extract the pattern arrays and helper behaviour that
 *     can be verified without running the hook as a subprocess.
 *
 *  2. Subprocess tests — spawn the hook with controlled stdin (the JSON
 *     payload Claude Code normally provides) and inspect stdout/exit-code.
 *     We control the LINEAR_API_KEY env var to exercise the API-key branch.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execSync, spawnSync } from "node:child_process";
import { writeFileSync, unlinkSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..");
const HOOK_PATH = join(PROJECT_ROOT, ".claude", "hooks", "check-linear-update.mjs");
const HANDOFFS_DIR = join(PROJECT_ROOT, ".claude", "handoffs");

// ---------------------------------------------------------------------------
// Helper: run the hook as a subprocess
// ---------------------------------------------------------------------------

/**
 * @param {object} inputData  JSON payload (matches Claude Code Stop hook schema)
 * @param {object} [envOverrides]  Env vars merged on top of a clean env
 * @returns {{ stdout: string, stderr: string, status: number }}
 */
function runHook(inputData, envOverrides = {}) {
  const result = spawnSync(
    process.execPath,
    [HOOK_PATH],
    {
      input: JSON.stringify(inputData),
      encoding: "utf-8",
      cwd: PROJECT_ROOT,
      timeout: 10_000,
      env: {
        PATH: process.env.PATH,
        // Deliberately omit LINEAR_API_KEY unless the caller provides it
        ...envOverrides,
      },
    },
  );
  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    status: result.status ?? -1,
  };
}

// ---------------------------------------------------------------------------
// Pattern-matching logic (extracted constants from the hook)
// These must stay in sync with check-linear-update.mjs
// ---------------------------------------------------------------------------

const UPDATED_PATTERNS = [
  /linear\.mjs\s+(status|comment|link-pr)/i,
  /update[d]?\s+(the\s+)?linear/i,
  /move[d]?\s+.*\s+to\s+(in progress|in review|done|backlog|todo)/i,
  /post(ed)?\s+(a\s+)?comment\s+(on|to)\s+(the\s+)?linear/i,
  /\bupdate_issue\b/i,
  /\bcreate_comment\b/i,
];

const COMPLETED_PATTERNS = [
  /\bpr\s+(created|opened|merged)\b/i,
  /\bpull\s+request\s+(created|opened|merged)\b/i,
  /\bgh\s+pr\s+create\b/i,
  /\bmove[d]?\s+.*\s+to\s+(done|in review)\b/i,
  /\btask\s+(is\s+)?complete[d]?\b/i,
  /\bwork\s+(is\s+)?done\b/i,
  /\ball\s+acceptance\s+criteria\s+(are\s+)?met\b/i,
];

const HANDOFF_PATTERNS = [
  /\bhandoff\b.*\b(creat|writ|generat|sav)/i,
  /\bhandoff\.mjs\b/i,
  /\.claude\/handoffs\//i,
  /\bhandoff\s+document\b/i,
  /\bsession\s+handoff\b/i,
];

const TERMINAL_STATES = ["done", "canceled", "cancelled", "duplicate"];

// States where the GitHub Action (or another process) has already updated
// Linear — the hook should skip the Linear update reminder for these.
const ALREADY_UPDATED_STATES = ["in review", ...TERMINAL_STATES];

// ---------------------------------------------------------------------------
// Section 1: Pure pattern-matching logic
// ---------------------------------------------------------------------------

describe("UPDATED_PATTERNS", () => {
  it("matches linear.mjs status call", () => {
    assert.ok(UPDATED_PATTERNS.some((re) => re.test("node scripts/linear.mjs status DVA-5 'In Progress'")));
  });

  it("matches linear.mjs comment call", () => {
    assert.ok(UPDATED_PATTERNS.some((re) => re.test("node scripts/linear.mjs comment DVA-5 'Done'")));
  });

  it("matches 'updated the linear'", () => {
    assert.ok(UPDATED_PATTERNS.some((re) => re.test("I updated the Linear issue status")));
  });

  it("matches 'update_issue' MCP tool name", () => {
    assert.ok(UPDATED_PATTERNS.some((re) => re.test("Called update_issue to move the issue")));
  });

  it("matches 'create_comment' MCP tool name", () => {
    assert.ok(UPDATED_PATTERNS.some((re) => re.test("Used create_comment to add a summary")));
  });

  it("matches 'posted a comment on the linear'", () => {
    assert.ok(UPDATED_PATTERNS.some((re) => re.test("I posted a comment on the Linear issue")));
  });

  it("matches 'moved issue to In Review'", () => {
    assert.ok(UPDATED_PATTERNS.some((re) => re.test("I moved the issue to In Review")));
  });

  it("does NOT match unrelated messages", () => {
    assert.ok(!UPDATED_PATTERNS.some((re) => re.test("Ran npm test and all tests passed")));
  });
});

describe("COMPLETED_PATTERNS", () => {
  it("matches 'PR created'", () => {
    assert.ok(COMPLETED_PATTERNS.some((re) => re.test("The PR created successfully")));
  });

  it("matches 'pull request opened'", () => {
    assert.ok(COMPLETED_PATTERNS.some((re) => re.test("A pull request opened for review")));
  });

  it("matches 'gh pr create' command", () => {
    assert.ok(COMPLETED_PATTERNS.some((re) => re.test("I ran gh pr create to open the PR")));
  });

  it("matches 'task is completed'", () => {
    assert.ok(COMPLETED_PATTERNS.some((re) => re.test("The task is completed")));
  });

  it("matches 'work is done'", () => {
    assert.ok(COMPLETED_PATTERNS.some((re) => re.test("The work is done")));
  });

  it("matches 'all acceptance criteria are met'", () => {
    assert.ok(COMPLETED_PATTERNS.some((re) => re.test("All acceptance criteria are met")));
  });

  it("does NOT match 'work started'", () => {
    assert.ok(!COMPLETED_PATTERNS.some((re) => re.test("Work started on the feature")));
  });
});

describe("HANDOFF_PATTERNS", () => {
  it("matches 'handoff created'", () => {
    assert.ok(HANDOFF_PATTERNS.some((re) => re.test("I have created a handoff document")));
  });

  it("matches 'handoff.mjs'", () => {
    assert.ok(HANDOFF_PATTERNS.some((re) => re.test("node scripts/handoff.mjs")));
  });

  it("matches path reference '.claude/handoffs/'", () => {
    assert.ok(HANDOFF_PATTERNS.some((re) => re.test("Wrote to .claude/handoffs/DVA-58.md")));
  });

  it("matches 'handoff document'", () => {
    assert.ok(HANDOFF_PATTERNS.some((re) => re.test("Created a handoff document for the next agent")));
  });

  it("does NOT match 'hand off work'", () => {
    // "hand off" with space — not the same as the hook's patterns
    assert.ok(!HANDOFF_PATTERNS.some((re) => re.test("Ready to hand off work to reviewer")));
  });
});

describe("TERMINAL_STATES", () => {
  it("includes 'done'", () => {
    assert.ok(TERMINAL_STATES.includes("done"));
  });

  it("includes 'canceled' and 'cancelled'", () => {
    assert.ok(TERMINAL_STATES.includes("canceled"));
    assert.ok(TERMINAL_STATES.includes("cancelled"));
  });

  it("includes 'duplicate'", () => {
    assert.ok(TERMINAL_STATES.includes("duplicate"));
  });

  it("does NOT include 'in progress'", () => {
    assert.ok(!TERMINAL_STATES.includes("in progress"));
  });
});

describe("ALREADY_UPDATED_STATES", () => {
  it("includes 'in review'", () => {
    assert.ok(ALREADY_UPDATED_STATES.includes("in review"));
  });

  it("includes all terminal states", () => {
    for (const state of TERMINAL_STATES) {
      assert.ok(
        ALREADY_UPDATED_STATES.includes(state),
        `ALREADY_UPDATED_STATES should include terminal state '${state}'`,
      );
    }
  });

  it("does NOT include 'in progress'", () => {
    assert.ok(!ALREADY_UPDATED_STATES.includes("in progress"));
  });

  it("does NOT include 'backlog'", () => {
    assert.ok(!ALREADY_UPDATED_STATES.includes("backlog"));
  });
});

// ---------------------------------------------------------------------------
// Section 2: Subprocess tests — verifying hook decision output
// ---------------------------------------------------------------------------

describe("stop hook subprocess: stop_hook_active guard", () => {
  it("exits 0 immediately when stop_hook_active is true", () => {
    const result = runHook({ stop_hook_active: true, last_assistant_message: "" });
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), "");
  });
});

describe("stop hook subprocess: no Linear issue on branch", () => {
  it("exits 0 silently when branch has no issue ID", () => {
    // Set up a temp git repo with a branch that has no Linear issue ID.
    // We can't override getBranch() without modifying the hook, so we run
    // the hook from a temp repo whose branch name has no issue pattern.
    const TMP_DIR = join(PROJECT_ROOT, "tests", "_tmp", "stop-hook-no-issue-repo");
    mkdirSync(TMP_DIR, { recursive: true });

    try {
      execSync("git init -b main", {
        cwd: TMP_DIR,
        encoding: "utf-8",
        stdio: "pipe",
      });
      execSync('git commit --allow-empty -m "init"', {
        cwd: TMP_DIR,
        encoding: "utf-8",
        stdio: "pipe",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "test",
          GIT_AUTHOR_EMAIL: "test@test.com",
          GIT_COMMITTER_NAME: "test",
          GIT_COMMITTER_EMAIL: "test@test.com",
        },
      });

      const result = spawnSync(
        process.execPath,
        [HOOK_PATH],
        {
          input: JSON.stringify({
            stop_hook_active: false,
            last_assistant_message: "All done!",
          }),
          encoding: "utf-8",
          cwd: TMP_DIR,
          timeout: 10_000,
          env: { PATH: process.env.PATH },
        },
      );

      assert.equal(result.status ?? -1, 0, "Hook should exit 0 when no issue ID");
      assert.equal((result.stdout || "").trim(), "", "Hook should produce no output when no issue ID");
    } finally {
      rmSync(TMP_DIR, { recursive: true, force: true });
    }
  });
});

describe("stop hook subprocess: reminder for in-progress issue (no API key)", () => {
  it("blocks and emits reminder when branch has issue ID and no API key", () => {
    // We cannot easily override the git branch from the outside, so we run
    // the hook with a custom GIT_DIR trick. Instead, we test the behaviour
    // indirectly by looking at what the hook does when it DOES find an issue.
    //
    // The cleanest way without modifying the hook: set up a temp git repo whose
    // HEAD branch contains a Linear issue ID, then run the hook from there.

    const TMP_DIR = join(PROJECT_ROOT, "tests", "_tmp", "stop-hook-test-repo");
    mkdirSync(TMP_DIR, { recursive: true });

    try {
      // Minimal git repo with a branch named feature/DVA-58-test
      execSync("git init -b feature/DVA-58-stop-hook-test", {
        cwd: TMP_DIR,
        encoding: "utf-8",
        stdio: "pipe",
      });
      execSync('git commit --allow-empty -m "init"', {
        cwd: TMP_DIR,
        encoding: "utf-8",
        stdio: "pipe",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "test",
          GIT_AUTHOR_EMAIL: "test@test.com",
          GIT_COMMITTER_NAME: "test",
          GIT_COMMITTER_EMAIL: "test@test.com",
        },
      });

      // Run the hook from the temp repo's directory so git picks up the branch
      const result = spawnSync(
        process.execPath,
        [HOOK_PATH],
        {
          input: JSON.stringify({
            stop_hook_active: false,
            last_assistant_message: "I finished the refactor.",
          }),
          encoding: "utf-8",
          cwd: TMP_DIR,
          timeout: 10_000,
          env: {
            PATH: process.env.PATH,
            // No LINEAR_API_KEY — isIssueTerminal returns false
          },
        },
      );

      const stdout = result.stdout || "";
      const status = result.status ?? -1;

      // Hook should output a block decision (not exit 0 silently)
      assert.equal(status, 0, "Hook process should exit 0 (it writes to stdout to block)");
      assert.ok(stdout.trim().length > 0, "Hook should produce output when issue found");

      const parsed = JSON.parse(stdout.trim());
      assert.equal(parsed.decision, "block", "Hook should block the agent");
      assert.ok(
        parsed.reason.includes("DVA-58"),
        `Reason should mention the issue ID; got: ${parsed.reason}`,
      );
      assert.ok(
        parsed.reason.includes("update Linear"),
        "Reason should include a reminder to update Linear",
      );
    } finally {
      rmSync(TMP_DIR, { recursive: true, force: true });
    }
  });
});

describe("stop hook subprocess: silences reminder when agent already updated Linear", () => {
  it("exits 0 silently when last message already references update_issue and task is done", () => {
    // Run in a temp repo with a branch that has a Linear issue ID.
    // The last message mentions update_issue (Linear updated) AND task is complete
    // (PR created) — both conditions satisfied, so hook should exit silently (no block).
    const TMP_DIR = join(PROJECT_ROOT, "tests", "_tmp", "stop-hook-already-updated");
    mkdirSync(TMP_DIR, { recursive: true });

    try {
      execSync("git init -b feature/DVA-77-already-updated", {
        cwd: TMP_DIR,
        encoding: "utf-8",
        stdio: "pipe",
      });
      execSync('git commit --allow-empty -m "init"', {
        cwd: TMP_DIR,
        encoding: "utf-8",
        stdio: "pipe",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "test",
          GIT_AUTHOR_EMAIL: "test@test.com",
          GIT_COMMITTER_NAME: "test",
          GIT_COMMITTER_EMAIL: "test@test.com",
        },
      });

      const result = spawnSync(
        process.execPath,
        [HOOK_PATH],
        {
          input: JSON.stringify({
            stop_hook_active: false,
            // Mentions update_issue (Linear updated), PR created (task done),
            // and audit trail exported — all three reminder conditions satisfied.
            last_assistant_message:
              "I called update_issue to move DVA-77 to In Review. The PR created and work is done. I ran audit.mjs export and audit.mjs attach 42 to post the audit trail.",
          }),
          encoding: "utf-8",
          cwd: TMP_DIR,
          timeout: 10_000,
          env: { PATH: process.env.PATH },
        },
      );

      const stdout = (result.stdout || "").trim();
      // Hook should exit 0 with no block (all reminders satisfied)
      assert.equal(result.status ?? -1, 0, "Hook should exit 0");
      assert.equal(stdout, "", `Hook should produce no blocking output; got: ${stdout}`);
    } finally {
      rmSync(TMP_DIR, { recursive: true, force: true });
    }
  });
});

describe("stop hook subprocess: graceful fallback without API key", () => {
  it("does not crash when LINEAR_API_KEY is absent (stop_hook_active guard)", () => {
    // Use the stop_hook_active=true guard — exits unconditionally without API calls
    const result = runHook(
      { stop_hook_active: true, last_assistant_message: "Just testing." },
      { PATH: process.env.PATH }, // explicitly no LINEAR_API_KEY
    );
    assert.notEqual(result.status, null, "Hook should exit cleanly");
    assert.ok(
      !result.stderr.includes("TypeError") && !result.stderr.includes("ReferenceError"),
      `Hook should not throw JS errors; stderr: ${result.stderr}`,
    );
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), "");
  });

  it("does not crash when stop_hook_active guard fires", () => {
    const result = runHook(
      { stop_hook_active: true, last_assistant_message: "" },
      {}, // no API key
    );
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), "");
  });

  it("does not crash and falls back gracefully when API key missing but issue is found", () => {
    // When there's no API key, isIssueTerminal returns false (doesn't throw).
    // The hook should continue and fire reminders rather than crashing.
    const TMP_DIR = join(PROJECT_ROOT, "tests", "_tmp", "stop-hook-no-api-key");
    mkdirSync(TMP_DIR, { recursive: true });

    try {
      execSync("git init -b feature/DVA-88-no-api-key-test", {
        cwd: TMP_DIR,
        encoding: "utf-8",
        stdio: "pipe",
      });
      execSync('git commit --allow-empty -m "init"', {
        cwd: TMP_DIR,
        encoding: "utf-8",
        stdio: "pipe",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "test",
          GIT_AUTHOR_EMAIL: "test@test.com",
          GIT_COMMITTER_NAME: "test",
          GIT_COMMITTER_EMAIL: "test@test.com",
        },
      });

      const result = spawnSync(
        process.execPath,
        [HOOK_PATH],
        {
          input: JSON.stringify({
            stop_hook_active: false,
            last_assistant_message: "Making progress on the work.",
          }),
          encoding: "utf-8",
          cwd: TMP_DIR,
          timeout: 10_000,
          env: { PATH: process.env.PATH }, // no LINEAR_API_KEY
        },
      );

      // Should not crash — hook catches errors and exits 0 silently, or
      // it falls through to fire reminders. Either way, no stderr JS errors.
      assert.ok(
        !((result.stderr || "").includes("TypeError")) && !((result.stderr || "").includes("ReferenceError")),
        `Hook should not throw JS errors; stderr: ${result.stderr}`,
      );
      // Status should be 0 (hook writes block via stdout, doesn't use exit codes)
      assert.equal(result.status ?? -1, 0);
    } finally {
      rmSync(TMP_DIR, { recursive: true, force: true });
    }
  });
});

describe("stop hook subprocess: fires reminder in temp repo for in-progress issue", () => {
  it("includes handoff reminder when task appears incomplete", () => {
    const TMP_DIR = join(PROJECT_ROOT, "tests", "_tmp", "stop-hook-handoff-test");
    mkdirSync(TMP_DIR, { recursive: true });

    try {
      execSync("git init -b feature/DVA-99-handoff-test", {
        cwd: TMP_DIR,
        encoding: "utf-8",
        stdio: "pipe",
      });
      execSync('git commit --allow-empty -m "init"', {
        cwd: TMP_DIR,
        encoding: "utf-8",
        stdio: "pipe",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "test",
          GIT_AUTHOR_EMAIL: "test@test.com",
          GIT_COMMITTER_NAME: "test",
          GIT_COMMITTER_EMAIL: "test@test.com",
        },
      });

      // Last message does NOT mention updating Linear OR completing the task
      const result = spawnSync(
        process.execPath,
        [HOOK_PATH],
        {
          input: JSON.stringify({
            stop_hook_active: false,
            last_assistant_message: "I made some progress on the refactor.",
          }),
          encoding: "utf-8",
          cwd: TMP_DIR,
          timeout: 10_000,
          env: { PATH: process.env.PATH },
        },
      );

      const stdout = result.stdout || "";
      assert.ok(stdout.trim().length > 0, "Hook should produce a block decision");

      const parsed = JSON.parse(stdout.trim());
      assert.equal(parsed.decision, "block");
      // Should include both Linear update reminder and handoff reminder
      assert.ok(parsed.reason.includes("update Linear"), "Should remind to update Linear");
      assert.ok(parsed.reason.includes("handoff"), "Should remind to write handoff");
    } finally {
      rmSync(TMP_DIR, { recursive: true, force: true });
    }
  });

  it("omits handoff reminder when task appears complete", () => {
    const TMP_DIR = join(PROJECT_ROOT, "tests", "_tmp", "stop-hook-complete-test");
    mkdirSync(TMP_DIR, { recursive: true });

    try {
      execSync("git init -b feature/DVA-99-complete-test", {
        cwd: TMP_DIR,
        encoding: "utf-8",
        stdio: "pipe",
      });
      execSync('git commit --allow-empty -m "init"', {
        cwd: TMP_DIR,
        encoding: "utf-8",
        stdio: "pipe",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "test",
          GIT_AUTHOR_EMAIL: "test@test.com",
          GIT_COMMITTER_NAME: "test",
          GIT_COMMITTER_EMAIL: "test@test.com",
        },
      });

      // Task is complete (PR created) but Linear not yet updated
      const result = spawnSync(
        process.execPath,
        [HOOK_PATH],
        {
          input: JSON.stringify({
            stop_hook_active: false,
            last_assistant_message: "The PR created and the work is done.",
          }),
          encoding: "utf-8",
          cwd: TMP_DIR,
          timeout: 10_000,
          env: { PATH: process.env.PATH },
        },
      );

      const stdout = result.stdout || "";
      assert.ok(stdout.trim().length > 0, "Hook should still block to remind about Linear update");

      const parsed = JSON.parse(stdout.trim());
      assert.equal(parsed.decision, "block");
      assert.ok(parsed.reason.includes("update Linear"), "Should still remind to update Linear");
      // But should NOT include handoff reminder (task is complete)
      assert.ok(
        !parsed.reason.includes("incomplete"),
        "Should not include incomplete task reminder",
      );
    } finally {
      rmSync(TMP_DIR, { recursive: true, force: true });
    }
  });
});
