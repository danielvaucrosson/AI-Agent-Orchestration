# DVA-19: Scheduled Agent Runs Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a cron-based GitHub Action that picks up the highest-priority "Todo" Linear issue and dispatches a Claude Code agent to work on it autonomously.

**Architecture:** Two GitHub Actions workflows — a scheduler (cron, gate checks, task selection) dispatches a worker (Claude Code execution) via `workflow_dispatch`. A Node.js script (`agent-scheduler.mjs`) handles rate limiting, task filtering, and retry tracking. The worker handles failure recovery (handoff, label, status revert).

**Tech Stack:** GitHub Actions, Node.js 20 (ESM), `@linear/sdk`, `gh` CLI, Claude Code CLI

**Spec:** `docs/superpowers/specs/2026-03-14-scheduled-agent-runs-design.md`

---

## Chunk 1: Scheduler Script (`scripts/agent-scheduler.mjs`)

### Task 1: Rate Limit Checking

**Files:**
- Create: `scripts/agent-scheduler.mjs`
- Create: `tests/agent-scheduler.test.mjs`

- [ ] **Step 1: Write failing test for `checkRateLimit`**

```javascript
// tests/agent-scheduler.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  checkRateLimit,
  parseRetryCount,
  filterForScheduler,
  setOutput,
} from "../scripts/agent-scheduler.mjs";

describe("checkRateLimit", () => {
  it("returns allowed=true when run count is below limit", () => {
    const runs = [
      { created_at: new Date().toISOString(), conclusion: "success" },
    ];
    const result = checkRateLimit(runs, 2);
    assert.equal(result.allowed, true);
    assert.equal(result.currentCount, 1);
  });

  it("returns allowed=false when run count equals limit", () => {
    const now = new Date().toISOString();
    const runs = [
      { created_at: now, conclusion: "success" },
      { created_at: now, conclusion: "failure" },
    ];
    const result = checkRateLimit(runs, 2);
    assert.equal(result.allowed, false);
    assert.equal(result.currentCount, 2);
  });

  it("returns allowed=true when no runs exist", () => {
    const result = checkRateLimit([], 2);
    assert.equal(result.allowed, true);
    assert.equal(result.currentCount, 0);
  });

  it("counts all conclusions (success, failure, cancelled)", () => {
    const now = new Date().toISOString();
    const runs = [
      { created_at: now, conclusion: "success" },
      { created_at: now, conclusion: "failure" },
      { created_at: now, conclusion: "cancelled" },
    ];
    const result = checkRateLimit(runs, 3);
    assert.equal(result.allowed, false);
    assert.equal(result.currentCount, 3);
  });
});
```

Note: All imports are consolidated in a single `import` statement at the top. Functions not yet implemented will cause expected failures — address them task by task.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/agent-scheduler.test.mjs`
Expected: FAIL — `checkRateLimit` not found

- [ ] **Step 3: Write minimal implementation**

```javascript
// scripts/agent-scheduler.mjs
/**
 * Scheduler logic for automated agent task pickup.
 *
 * Handles rate limiting, task selection (with retry filtering),
 * and output for the GitHub Actions scheduler workflow.
 *
 * Usage:
 *   node scripts/agent-scheduler.mjs next [--max-daily N] [--team DVA]
 *   node scripts/agent-scheduler.mjs --help
 */

import { execSync } from "node:child_process";
import { existsSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Check if dispatching another agent run is allowed under the rate limit.
 *
 * Caller is responsible for passing only runs from the last 24 hours.
 * This function counts them and compares against the limit.
 *
 * @param {object[]} runs - Recent workflow runs from GitHub API
 *   (each has `created_at` and `conclusion`)
 * @param {number} maxDaily - Maximum allowed runs per 24 hours
 * @returns {{ allowed: boolean, currentCount: number, maxDaily: number }}
 */
export function checkRateLimit(runs, maxDaily) {
  const currentCount = runs.length;
  return {
    allowed: currentCount < maxDaily,
    currentCount,
    maxDaily,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

The test file imports `parseRetryCount`, `filterForScheduler`, and `setOutput` which don't exist yet. Add stubs in `agent-scheduler.mjs` so the import succeeds:

```javascript
// Temporary stubs — replaced in Tasks 2 and 3
export function parseRetryCount() { throw new Error("Not implemented"); }
export function filterForScheduler() { throw new Error("Not implemented"); }
export function setOutput() { throw new Error("Not implemented"); }
```

Run: `node --test tests/agent-scheduler.test.mjs`
Expected: PASS — all 4 `checkRateLimit` tests pass; other describe blocks may fail (that's expected, they'll be fixed in Tasks 2-3)

- [ ] **Step 5: Commit**

```bash
git add scripts/agent-scheduler.mjs tests/agent-scheduler.test.mjs
git commit -m "DVA-19: add checkRateLimit with tests"
```

---

### Task 2: Retry Count Parsing

**Files:**
- Modify: `scripts/agent-scheduler.mjs`
- Modify: `tests/agent-scheduler.test.mjs`

- [ ] **Step 1: Write failing tests for `parseRetryCount`**

Add to `tests/agent-scheduler.test.mjs` (below the existing `checkRateLimit` describe block):

```javascript
describe("parseRetryCount", () => {
  it("returns 0 when no retry comments exist", () => {
    const comments = [
      { body: "Starting work on this issue" },
      { body: "PR opened: https://github.com/..." },
    ];
    assert.equal(parseRetryCount(comments), 0);
  });

  it("parses retry count from structured comment", () => {
    const comments = [
      { body: "Starting work" },
      { body: "[agent-retry: 1]" },
    ];
    assert.equal(parseRetryCount(comments), 1);
  });

  it("returns the highest retry count when multiple exist", () => {
    const comments = [
      { body: "[agent-retry: 1]" },
      { body: "[agent-retry: 2]" },
    ];
    assert.equal(parseRetryCount(comments), 2);
  });

  it("handles retry marker embedded in longer text", () => {
    const comments = [
      { body: "Agent failed. [agent-retry: 3] Will skip next time." },
    ];
    assert.equal(parseRetryCount(comments), 3);
  });

  it("returns 0 for empty comments array", () => {
    assert.equal(parseRetryCount([]), 0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/agent-scheduler.test.mjs`
Expected: FAIL — `parseRetryCount` throws "Not implemented"

- [ ] **Step 3: Replace stub with real implementation**

Replace the `parseRetryCount` stub in `scripts/agent-scheduler.mjs`:

```javascript
/**
 * Parse the retry count from an issue's comments.
 * Looks for structured markers like `[agent-retry: N]`.
 *
 * @param {object[]} comments - Array of comment objects with `body` string
 * @returns {number} The highest retry count found, or 0
 */
export function parseRetryCount(comments) {
  let maxRetry = 0;
  const pattern = /\[agent-retry:\s*(\d+)\]/;
  for (const comment of comments) {
    const match = comment.body.match(pattern);
    if (match) {
      const count = parseInt(match[1], 10);
      if (count > maxRetry) maxRetry = count;
    }
  }
  return maxRetry;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/agent-scheduler.test.mjs`
Expected: PASS — all `checkRateLimit` and `parseRetryCount` tests

- [ ] **Step 5: Commit**

```bash
git add scripts/agent-scheduler.mjs tests/agent-scheduler.test.mjs
git commit -m "DVA-19: add parseRetryCount with tests"
```

---

### Task 3: Task Filtering and Output Helper

**Files:**
- Modify: `scripts/agent-scheduler.mjs`
- Modify: `tests/agent-scheduler.test.mjs`

- [ ] **Step 1: Write failing tests for `filterForScheduler` and `setOutput`**

Add to `tests/agent-scheduler.test.mjs`:

```javascript
describe("filterForScheduler", () => {
  it("returns only Todo issues (excludes Backlog)", () => {
    const tasks = [
      { identifier: "DVA-1", status: "Backlog", statusLower: "backlog", labels: [] },
      { identifier: "DVA-2", status: "Todo", statusLower: "todo", labels: [] },
    ];
    const result = filterForScheduler(tasks, {});
    assert.equal(result.length, 1);
    assert.equal(result[0].identifier, "DVA-2");
  });

  it("excludes issues with agent-failed label and retries >= maxRetries", () => {
    const tasks = [
      { identifier: "DVA-1", status: "Todo", statusLower: "todo", labels: ["agent-failed"] },
      { identifier: "DVA-2", status: "Todo", statusLower: "todo", labels: [] },
    ];
    const commentsMap = {
      "DVA-1": [{ body: "[agent-retry: 2]" }],
    };
    const result = filterForScheduler(tasks, commentsMap, 2);
    assert.equal(result.length, 1);
    assert.equal(result[0].identifier, "DVA-2");
  });

  it("keeps agent-failed issues with retries below max", () => {
    const tasks = [
      { identifier: "DVA-1", status: "Todo", statusLower: "todo", labels: ["agent-failed"] },
    ];
    const commentsMap = {
      "DVA-1": [{ body: "[agent-retry: 1]" }],
    };
    const result = filterForScheduler(tasks, commentsMap, 2);
    assert.equal(result.length, 1);
    assert.equal(result[0].identifier, "DVA-1");
  });

  it("returns empty array when no tasks match", () => {
    const tasks = [
      { identifier: "DVA-1", status: "In Progress", statusLower: "in progress", labels: [] },
    ];
    const result = filterForScheduler(tasks, {});
    assert.equal(result.length, 0);
  });
});

describe("setOutput", () => {
  it("writes key=value to GITHUB_OUTPUT file when env is set", async () => {
    const { writeFileSync, readFileSync, unlinkSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const tmpFile = join(tmpdir(), `test-output-${Date.now()}`);
    writeFileSync(tmpFile, "");

    const origEnv = process.env.GITHUB_OUTPUT;
    process.env.GITHUB_OUTPUT = tmpFile;
    try {
      setOutput("task", "DVA-5");
      const content = readFileSync(tmpFile, "utf8");
      assert.ok(content.includes("task=DVA-5"));
    } finally {
      process.env.GITHUB_OUTPUT = origEnv;
      unlinkSync(tmpFile);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/agent-scheduler.test.mjs`
Expected: FAIL — `filterForScheduler` and `setOutput` throw "Not implemented"

- [ ] **Step 3: Replace stubs with real implementations**

Replace the `filterForScheduler` and `setOutput` stubs in `scripts/agent-scheduler.mjs`:

```javascript
/**
 * Filter task list to issues suitable for automated pickup.
 * - Only "Todo" status (not Backlog — those aren't ready)
 * - Exclude issues with `agent-failed` label and retry count >= maxRetries
 *
 * @param {object[]} tasks - Ordered list of task objects (from task-ordering.mjs)
 * @param {Object<string, object[]>} commentsMap - Map of identifier -> comments array
 * @param {number} [maxRetries=2] - Maximum retry attempts before skipping
 * @returns {object[]} Filtered and ordered tasks
 */
export function filterForScheduler(tasks, commentsMap = {}, maxRetries = 2) {
  return tasks.filter((task) => {
    if (task.statusLower !== "todo") return false;

    const hasFailedLabel = (task.labels || []).includes("agent-failed");
    if (hasFailedLabel) {
      const comments = commentsMap[task.identifier] || [];
      const retryCount = parseRetryCount(comments);
      if (retryCount >= maxRetries) return false;
    }

    return true;
  });
}

/**
 * Write a key=value pair to GitHub Actions output.
 * Falls back to console.log if not running in Actions.
 *
 * @param {string} key - Output variable name
 * @param {string} value - Output value
 */
export function setOutput(key, value) {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile && existsSync(outputFile)) {
    appendFileSync(outputFile, `${key}=${value}\n`);
  }
  console.log(`${key}=${value}`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/agent-scheduler.test.mjs`
Expected: PASS — all tests

- [ ] **Step 5: Commit**

```bash
git add scripts/agent-scheduler.mjs tests/agent-scheduler.test.mjs
git commit -m "DVA-19: add filterForScheduler and setOutput with tests"
```

---

### Task 4: CLI Entry Point

**Files:**
- Modify: `scripts/agent-scheduler.mjs`

- [ ] **Step 1: Add CLI entry point with `next` command**

The CLI orchestrates: fetch rate limit data, call `task-ordering.mjs next`, apply `filterForScheduler`, and output the selected task via `setOutput`.

```javascript
// Add to scripts/agent-scheduler.mjs

/**
 * Fetch recent agent-worker workflow runs from GitHub API.
 * Uses `gh` CLI which is pre-authenticated in GitHub Actions.
 *
 * @param {string} workflowFile - Workflow filename (e.g., "agent-worker.yml")
 * @returns {object[]} Array of workflow run objects
 */
export function fetchRecentRuns(workflowFile) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  try {
    const output = execSync(
      `gh api "/repos/{owner}/{repo}/actions/workflows/${workflowFile}/runs?created=>${since}&per_page=100"`,
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
    );
    const data = JSON.parse(output);
    return data.workflow_runs || [];
  } catch {
    // If workflow doesn't exist yet or gh not available, no runs
    return [];
  }
}

/**
 * Fetch comments for a Linear issue using the @linear/sdk.
 * Returns array of { body } objects.
 *
 * @param {string} identifier - Issue identifier (e.g., "DVA-5")
 * @returns {Promise<object[]>} Comment objects with `body` field
 */
async function fetchIssueComments(identifier) {
  try {
    const { LinearClient } = await import("@linear/sdk");
    const client = new LinearClient({ apiKey: process.env.LINEAR_API_KEY });
    const issue = await client.issue(identifier);
    const comments = await issue.comments();
    return comments.nodes.map((c) => ({ body: c.body }));
  } catch {
    return [];
  }
}

// --- CLI ---

function parseArgs(argv) {
  const args = { command: null, maxDaily: 2, team: "DVA" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--max-daily" && argv[i + 1]) {
      args.maxDaily = parseInt(argv[i + 1], 10);
      i++;
    } else if (argv[i] === "--team" && argv[i + 1]) {
      args.team = argv[i + 1];
      i++;
    } else if (argv[i] === "--help") {
      args.command = "help";
    } else if (!args.command) {
      args.command = argv[i];
    }
  }
  return args;
}

// ESM-safe main guard using fileURLToPath
const __filename = fileURLToPath(import.meta.url);
const isMain = process.argv[1] && __filename === process.argv[1];

if (isMain) {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === "help" || !args.command) {
    console.log(`Usage: node scripts/agent-scheduler.mjs next [options]

Commands:
  next    Select the next task for automated pickup

Options:
  --max-daily N   Maximum agent runs per 24h (default: 2)
  --team TEAM     Linear team key (default: DVA)
  --help          Show this help

Outputs (for GitHub Actions):
  task=none|<issue-id>
  task_title=<title>
  task_url=<url>`);
    process.exit(args.command === "help" ? 0 : 1);
  }

  if (args.command === "next") {
    try {
      // 1. Check rate limit
      const runs = await fetchRecentRuns("agent-worker.yml");
      const rateCheck = checkRateLimit(runs, args.maxDaily);

      if (!rateCheck.allowed) {
        console.log(
          `Rate limit reached: ${rateCheck.currentCount}/${rateCheck.maxDaily} runs in last 24h`
        );
        setOutput("task", "none");
        process.exit(0);
      }

      console.log(
        `Rate limit OK: ${rateCheck.currentCount}/${rateCheck.maxDaily} runs in last 24h`
      );

      // 2. Get ordered tasks from task-ordering.mjs
      const taskOutput = execSync(
        `node scripts/task-ordering.mjs next --team ${args.team} --json`,
        { encoding: "utf8", cwd: process.cwd() }
      );
      const taskResult = JSON.parse(taskOutput);

      if (!taskResult.task) {
        console.log("No actionable tasks found");
        setOutput("task", "none");
        process.exit(0);
      }

      // 3. Apply scheduler filter (Todo-only + failed-task exclusion)
      // Fetch comments for the top candidate to check retry count
      const task = taskResult.task;
      const commentsMap = {};
      const hasFailedLabel = (task.labels || []).includes("agent-failed");

      if (hasFailedLabel) {
        const comments = await fetchIssueComments(task.identifier);
        commentsMap[task.identifier] = comments;
      }

      const eligible = filterForScheduler([task], commentsMap);

      if (eligible.length === 0) {
        console.log(
          `Skipping ${task.identifier}: not eligible (status: ${task.status}, failed-label: ${hasFailedLabel})`
        );
        setOutput("task", "none");
        process.exit(0);
      }

      // 4. Output selected task
      const selected = eligible[0];
      console.log(`Selected task: ${selected.identifier} — ${selected.title}`);
      setOutput("task", selected.identifier);
      setOutput("task_title", selected.title);
      setOutput("task_url", selected.url || "");
    } catch (err) {
      console.error(`Error: ${err.message}`);
      setOutput("task", "none");
      process.exit(1);
    }
  }
}
```

Also add the `handle-failure` command (used by the worker workflow's failure handler):

```javascript
  if (args.command === "handle-failure") {
    // Usage: node scripts/agent-scheduler.mjs handle-failure DVA-X "handoff message"
    const issueId = args.issueId; // parsed from argv
    const handoffMsg = args.handoffMsg || "";

    try {
      const { LinearClient } = await import("@linear/sdk");
      const client = new LinearClient({ apiKey: process.env.LINEAR_API_KEY });
      const issue = await client.issue(issueId);

      // 1. Read existing retry count from comments
      const comments = await issue.comments();
      const commentBodies = comments.nodes.map((c) => ({ body: c.body }));
      const prevCount = parseRetryCount(commentBodies);
      const retryCount = prevCount + 1;

      // 2. Apply agent-failed label (create if needed)
      const labels = await issue.labels();
      if (!labels.nodes.find((l) => l.name === "agent-failed")) {
        const team = await issue.team;
        const teamLabels = await team.labels();
        let label = teamLabels.nodes.find((l) => l.name === "agent-failed");
        if (!label) {
          const payload = await client.createIssueLabel({
            name: "agent-failed",
            teamId: team.id,
            color: "#ef4444",
          });
          label = await payload.issueLabel;
        }
        const currentLabelIds = labels.nodes.map((l) => l.id);
        await issue.update({ labelIds: [...currentLabelIds, label.id] });
      }
      console.log(`Label agent-failed applied to ${issueId}`);

      // 3. Post retry comment
      await client.createComment({
        issueId: issue.id,
        body: `[agent-retry: ${retryCount}] Automated agent run failed (attempt ${retryCount}). ${handoffMsg}.`,
      });
      console.log(`Posted retry comment (attempt ${retryCount}) to ${issueId}`);
    } catch (err) {
      console.error(`Error handling failure: ${err.message}`);
      process.exit(1);
    }
  }
```

Update `parseArgs` to also extract `issueId` and `handoffMsg` for the `handle-failure` command:

```javascript
function parseArgs(argv) {
  const args = { command: null, maxDaily: 2, team: "DVA", issueId: null, handoffMsg: "" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--max-daily" && argv[i + 1]) {
      args.maxDaily = parseInt(argv[i + 1], 10);
      i++;
    } else if (argv[i] === "--team" && argv[i + 1]) {
      args.team = argv[i + 1];
      i++;
    } else if (argv[i] === "--help") {
      args.command = "help";
    } else if (!args.command) {
      args.command = argv[i];
    } else if (args.command === "handle-failure" && !args.issueId) {
      args.issueId = argv[i];
    } else if (args.command === "handle-failure" && !args.handoffMsg) {
      args.handoffMsg = argv[i];
    }
  }
  return args;
}
```

Key differences from the earlier version:
- Uses `fileURLToPath` for reliable `isMain` detection across platforms (including Windows)
- Uses `filterForScheduler` instead of duplicating filtering logic inline
- Uses `@linear/sdk` directly via `fetchIssueComments` instead of a non-existent `linear.mjs comments` subcommand
- `handle-failure` command reuses `parseRetryCount` and consolidates all failure-path logic (label + comment) in one tested script
- Single-candidate filtering is by design — one task per scheduler run, matching spec's "one task per scheduler run, rate limited to N per day"

- [ ] **Step 2: Verify the help command works**

Run: `node scripts/agent-scheduler.mjs --help`
Expected: Prints usage and exits 0

- [ ] **Step 3: Run all tests to verify nothing is broken**

Run: `node --test tests/agent-scheduler.test.mjs`
Expected: PASS — all tests

- [ ] **Step 4: Commit**

```bash
git add scripts/agent-scheduler.mjs
git commit -m "DVA-19: add CLI entry point for agent-scheduler"
```

---

## Chunk 2: GitHub Actions Workflows

### Task 5: Agent Worker Workflow

**Files:**
- Create: `.github/workflows/agent-worker.yml`

- [ ] **Step 1: Write the worker workflow**

This includes the complete failure handler with retry count increment and label application. The handler uses `scripts/linear.mjs` for status revert and `scripts/agent-scheduler.mjs handle-failure` for retry tracking (count increment, label application, and comment posting).

```yaml
# .github/workflows/agent-worker.yml
name: Agent Worker

on:
  workflow_dispatch:
    inputs:
      issue_id:
        description: "Linear issue ID (e.g., DVA-19)"
        required: true
        type: string
      issue_title:
        description: "Issue title for logs"
        required: true
        type: string

permissions:
  contents: write
  pull-requests: write
  issues: write

concurrency:
  group: agent-worker-${{ inputs.issue_id }}
  cancel-in-progress: false

jobs:
  run-agent:
    runs-on: ubuntu-latest
    timeout-minutes: 180
    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Install dependencies
        run: npm ci

      - name: Install Claude Code
        run: npm install -g @anthropic-ai/claude-code

      - name: Run agent
        id: agent
        run: |
          echo "start_time=$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$GITHUB_OUTPUT"
          claude -p "Pick up ${{ inputs.issue_id }}: ${{ inputs.issue_title }}. Follow the workflow protocol in CLAUDE.md. This is an automated scheduled run."
          echo "end_time=$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$GITHUB_OUTPUT"
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          LINEAR_API_KEY: ${{ secrets.LINEAR_API_KEY }}
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

      - name: Job summary (success)
        if: success()
        run: |
          cat >> "$GITHUB_STEP_SUMMARY" <<EOF
          ## Agent Run Complete

          | Field | Value |
          |-------|-------|
          | Issue | ${{ inputs.issue_id }}: ${{ inputs.issue_title }} |
          | Linear | https://linear.app/dvaucrosson/issue/${{ inputs.issue_id }} |
          | Started | ${{ steps.agent.outputs.start_time }} |
          | Finished | ${{ steps.agent.outputs.end_time }} |
          | Outcome | Success |
          EOF

      - name: Handle failure
        if: failure()
        run: |
          # Check for handoff file
          HANDOFF_FILE=".claude/handoffs/${{ inputs.issue_id }}.md"
          HANDOFF_MSG=""
          if [ -f "$HANDOFF_FILE" ]; then
            HANDOFF_MSG="Handoff file exists at \`$HANDOFF_FILE\`"
          else
            HANDOFF_MSG="No handoff file found"
          fi

          # Move issue back to Todo
          node scripts/linear.mjs status "${{ inputs.issue_id }}" "Todo" || echo "Warning: Could not update Linear status"

          # Read existing retry count, apply label, and post comment
          # Uses agent-scheduler.mjs handle-failure command to reuse tested logic
          # Capture stdout to get the retry count for the summary
          FAILURE_OUTPUT=$(node scripts/agent-scheduler.mjs handle-failure "${{ inputs.issue_id }}" "$HANDOFF_MSG" 2>&1 || echo "Warning: failure handling incomplete")
          echo "$FAILURE_OUTPUT"

          # Write failure summary
          cat >> "$GITHUB_STEP_SUMMARY" <<EOF
          ## Agent Run Failed

          | Field | Value |
          |-------|-------|
          | Issue | ${{ inputs.issue_id }}: ${{ inputs.issue_title }} |
          | Linear | https://linear.app/dvaucrosson/issue/${{ inputs.issue_id }} |
          | Outcome | Failed |
          | Handoff | ${HANDOFF_MSG} |
          | Details | See Linear comment for retry count |
          EOF
        env:
          LINEAR_API_KEY: ${{ secrets.LINEAR_API_KEY }}
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

Key design notes:
- Failure handling delegates to `node scripts/agent-scheduler.mjs handle-failure` to reuse tested logic (`parseRetryCount`) and avoid fragile inline scripts with shell-embedded JavaScript
- All failure-handler operations are best-effort (`|| echo "Warning:..."`) to avoid masking the original failure
- The `handle-failure` command is implemented in Task 4 (Chunk 1) alongside the `next` command

- [ ] **Step 2: Validate YAML syntax**

Run: `node -e "import('node:fs').then(fs => { fs.readFileSync('.github/workflows/agent-worker.yml', 'utf8'); console.log('File readable, checking structure...'); })"`

Then manually verify: triggers, permissions, concurrency, job name, steps all look correct.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/agent-worker.yml
git commit -m "DVA-19: add agent-worker workflow with failure handling"
```

---

### Task 6: Agent Scheduler Workflow

**Files:**
- Create: `.github/workflows/agent-scheduler.yml`

- [ ] **Step 1: Write the scheduler workflow**

```yaml
# .github/workflows/agent-scheduler.yml
name: Agent Scheduler

on:
  schedule:
    - cron: "0 */6 * * *"
  workflow_dispatch:

concurrency:
  group: agent-scheduler
  cancel-in-progress: true

permissions:
  actions: write
  contents: read

jobs:
  schedule-agent:
    runs-on: ubuntu-latest
    # Kill switch: must be explicitly set to "true"
    if: ${{ vars.AGENT_AUTOPILOT == 'true' }}
    steps:
      - name: Kill switch check
        run: echo "Autopilot enabled — proceeding with task selection"

      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Install dependencies
        run: npm ci

      - name: Select next task
        id: select
        run: node scripts/agent-scheduler.mjs next --max-daily ${{ vars.AGENT_MAX_DAILY_RUNS || '2' }} --team DVA
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          LINEAR_API_KEY: ${{ secrets.LINEAR_API_KEY }}

      - name: Dispatch agent worker
        if: steps.select.outputs.task != 'none' && steps.select.outputs.task != ''
        run: |
          gh workflow run agent-worker.yml \
            -f issue_id="${{ steps.select.outputs.task }}" \
            -f issue_title="${{ steps.select.outputs.task_title }}"
          echo "Dispatched agent-worker for ${{ steps.select.outputs.task }}"
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

      - name: Post Linear notification
        if: steps.select.outputs.task != 'none' && steps.select.outputs.task != ''
        run: |
          node scripts/linear.mjs comment "${{ steps.select.outputs.task }}" \
            "Automated agent run dispatched via scheduled pickup."
        env:
          LINEAR_API_KEY: ${{ secrets.LINEAR_API_KEY }}

      - name: No task available
        if: steps.select.outputs.task == 'none' || steps.select.outputs.task == ''
        run: echo "No task selected — skipping dispatch"
```

- [ ] **Step 2: Validate YAML syntax**

Run: `node -e "import('node:fs').then(fs => { fs.readFileSync('.github/workflows/agent-scheduler.yml', 'utf8'); console.log('File readable'); })"`

Manually verify: cron expression, kill switch condition, step outputs flow correctly.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/agent-scheduler.yml
git commit -m "DVA-19: add agent-scheduler workflow"
```

---

## Chunk 3: Verification and Wrap-up

### Task 7: Run Full Test Suite

**Files:** None (verification only)

- [ ] **Step 1: Run all project tests**

Run: `npm test`
Expected: All tests pass, including the new `agent-scheduler.test.mjs`

- [ ] **Step 2: Verify workflow YAML files are readable**

Run: `node -e "import('node:fs').then(fs => { for (const f of ['agent-scheduler.yml', 'agent-worker.yml']) { const content = fs.readFileSync('.github/workflows/' + f, 'utf8'); console.log(f + ': ' + content.split('\\n').length + ' lines, OK'); } })"`

- [ ] **Step 3: Verify the scheduler CLI runs (help mode)**

Run: `node scripts/agent-scheduler.mjs --help`
Expected: Prints usage text and exits 0

---

### Task 8: Pre-PR Review and PR Creation

**Files:** None (process steps)

- [ ] **Step 1: Run pre-PR review**

Run: `node scripts/pre-pr-review.mjs`
Expected: All 5 gates pass (tests, security, conventions, code quality, diff size). Fix any failures before proceeding.

- [ ] **Step 2: Ensure all changes are committed**

Run: `git status` — should show clean working tree.

- [ ] **Step 3: Verify commit history**

Run: `git log --oneline` — should show the incremental commits from this implementation.

- [ ] **Step 4: Push and create PR**

```bash
git push -u origin HEAD
gh pr create --title "DVA-19: Scheduled Agent Runs — Cron-Based Task Pickup" --body "$(cat <<'EOF'
## Summary
- Add `agent-scheduler.yml` workflow (cron every 6h) with kill switch and rate limiting
- Add `agent-worker.yml` workflow (workflow_dispatch) to run Claude Code on a Linear issue
- Add `scripts/agent-scheduler.mjs` with rate limit checking, retry count parsing, and task filtering
- Add `tests/agent-scheduler.test.mjs` with unit tests for all scheduler logic

## Test plan
- [ ] Unit tests pass (`npm test`)
- [ ] Pre-PR review passes (`node scripts/pre-pr-review.mjs`)
- [ ] Set `AGENT_AUTOPILOT=true` repo variable and verify scheduler runs
- [ ] Manually dispatch `agent-worker.yml` with a test issue to verify end-to-end
- [ ] Verify kill switch: set `AGENT_AUTOPILOT=false`, confirm scheduler skips
- [ ] Verify rate limit: check that exceeding `AGENT_MAX_DAILY_RUNS` blocks dispatch
EOF
)"
```
