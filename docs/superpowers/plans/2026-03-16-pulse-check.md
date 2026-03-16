# DVA-51: Pulse Check Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an automated health monitoring system that detects stuck agent workflow runs, diagnoses root causes, and escalates through three recovery levels.

**Architecture:** A `scripts/pulse-check.mjs` script with dependency-injected pure functions, invoked by a thin `pulse-check.yml` GitHub Actions cron workflow on `ubuntu-latest`. State persists across ephemeral runners via the `PULSE_CHECK_STATE` GitHub repo variable.

**Tech Stack:** Node.js 22, `node:test` runner, `gh` CLI for GitHub API, `scripts/linear.mjs` for Linear integration.

**Spec:** `docs/superpowers/specs/2026-03-16-pulse-check-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `scripts/pulse-check.mjs` | Create | All detection, classification, diagnosis, recovery, reporting, state management logic |
| `tests/pulse-check.test.mjs` | Create | Unit tests for all pure functions + orchestration |
| `.github/workflows/pulse-check.yml` | Create | Thin cron workflow that invokes the script |
| `.gitignore` | Modify | No changes needed (state is in repo variable, not local file) |

---

## Chunk 1: Pure Functions — Classification & State

### Task 1: Classification functions

**Files:**
- Create: `scripts/pulse-check.mjs`
- Create: `tests/pulse-check.test.mjs`

- [ ] **Step 1: Write failing tests for `classifyRun`**

```js
// tests/pulse-check.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyRun } from "../scripts/pulse-check.mjs";

describe("classifyRun", () => {
  const now = new Date("2026-03-16T01:00:00Z").getTime();

  it("returns healthy for a recently queued run", () => {
    const run = { status: "queued", created_at: "2026-03-16T00:59:00Z" };
    assert.equal(classifyRun(run, now), "healthy");
  });

  it("returns stuck-queued for a run queued over 2 minutes", () => {
    const run = { status: "queued", created_at: "2026-03-16T00:57:00Z" };
    assert.equal(classifyRun(run, now), "stuck-queued");
  });

  it("returns healthy for a recently started run", () => {
    const run = { status: "in_progress", run_started_at: "2026-03-16T00:30:00Z" };
    assert.equal(classifyRun(run, now), "healthy");
  });

  it("returns stuck-running for a run over 60 minutes", () => {
    const run = { status: "in_progress", run_started_at: "2026-03-15T23:50:00Z" };
    assert.equal(classifyRun(run, now), "stuck-running");
  });

  it("uses created_at as fallback when run_started_at is missing", () => {
    const run = { status: "in_progress", created_at: "2026-03-15T23:50:00Z" };
    assert.equal(classifyRun(run, now), "stuck-running");
  });

  it("returns stuck-queued at exactly 2 minutes (>= threshold boundary)", () => {
    const run = { status: "queued", created_at: "2026-03-16T00:58:00Z" };
    assert.equal(classifyRun(run, now), "stuck-queued");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/pulse-check.test.mjs`
Expected: FAIL — `classifyRun` is not exported

- [ ] **Step 3: Implement `classifyRun` and constants**

```js
// scripts/pulse-check.mjs
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WORKFLOW_FILE = "agent-worker.yml";
const QUEUE_TIMEOUT_MS = 2 * 60 * 1000;
const RUNNING_TIMEOUT_MS = 60 * 60 * 1000;
const MAX_STUCK_OBSERVATIONS = 3;
const MAX_PULSE_RETRIES = 2;
const ISSUE_RE = /\b([A-Z]{1,5}-\d+)\b/;

// ---------------------------------------------------------------------------
// Classification (pure)
// ---------------------------------------------------------------------------

/**
 * Classify a workflow run as healthy, stuck-queued, or stuck-running.
 *
 * @param {object} run - GitHub Actions workflow run object
 * @param {number} now - Current timestamp in ms
 * @returns {"healthy" | "stuck-queued" | "stuck-running"}
 */
export function classifyRun(run, now) {
  if (run.status === "queued") {
    const queuedMs = now - new Date(run.created_at).getTime();
    return queuedMs >= QUEUE_TIMEOUT_MS ? "stuck-queued" : "healthy";
  }
  if (run.status === "in_progress") {
    const runningMs = now - new Date(run.run_started_at || run.created_at).getTime();
    return runningMs >= RUNNING_TIMEOUT_MS ? "stuck-running" : "healthy";
  }
  return "healthy";
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/pulse-check.test.mjs`
Expected: 6 tests PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/pulse-check.mjs tests/pulse-check.test.mjs
git commit -m "DVA-51: Add classifyRun with tests"
```

---

### Task 2: State management functions

**Files:**
- Modify: `scripts/pulse-check.mjs`
- Modify: `tests/pulse-check.test.mjs`

- [ ] **Step 1: Write failing tests for state functions**

```js
// Append to tests/pulse-check.test.mjs
import {
  classifyRun,
  emptyState,
  pruneState,
  canRetry,
  incrementBudget,
} from "../scripts/pulse-check.mjs";

describe("emptyState", () => {
  it("returns valid empty structure", () => {
    const s = emptyState();
    assert.deepEqual(s, { runs: {}, retryBudget: {} });
  });
});

describe("canRetry", () => {
  it("returns true when budget count is 0", () => {
    const state = { runs: {}, retryBudget: { "DVA-47": { today: "2026-03-16", count: 0 } } };
    assert.equal(canRetry("DVA-47", state), true);
  });

  it("returns true when budget count is 1 (below default max of 2)", () => {
    const state = { runs: {}, retryBudget: { "DVA-47": { today: "2026-03-16", count: 1 } } };
    assert.equal(canRetry("DVA-47", state), true);
  });

  it("returns false when budget count equals max", () => {
    const state = { runs: {}, retryBudget: { "DVA-47": { today: "2026-03-16", count: 2 } } };
    assert.equal(canRetry("DVA-47", state), false);
  });

  it("returns true when issue has no budget entry yet", () => {
    const state = { runs: {}, retryBudget: {} };
    assert.equal(canRetry("DVA-47", state), true);
  });

  it("resets budget when today has changed", () => {
    const state = { runs: {}, retryBudget: { "DVA-47": { today: "2026-03-15", count: 2 } } };
    assert.equal(canRetry("DVA-47", state, 2, "2026-03-16"), true);
  });
});

describe("incrementBudget", () => {
  it("creates a new entry when none exists", () => {
    const state = { runs: {}, retryBudget: {} };
    incrementBudget("DVA-47", state, "2026-03-16");
    assert.deepEqual(state.retryBudget["DVA-47"], { today: "2026-03-16", count: 1 });
  });

  it("increments existing entry", () => {
    const state = { runs: {}, retryBudget: { "DVA-47": { today: "2026-03-16", count: 1 } } };
    incrementBudget("DVA-47", state, "2026-03-16");
    assert.equal(state.retryBudget["DVA-47"].count, 2);
  });

  it("resets count on new day before incrementing", () => {
    const state = { runs: {}, retryBudget: { "DVA-47": { today: "2026-03-15", count: 2 } } };
    incrementBudget("DVA-47", state, "2026-03-16");
    assert.deepEqual(state.retryBudget["DVA-47"], { today: "2026-03-16", count: 1 });
  });
});

describe("pruneState", () => {
  it("removes entries for run IDs not in the active set", () => {
    const state = {
      runs: {
        "111": { issueId: "DVA-1", seenCount: 1 },
        "222": { issueId: "DVA-2", seenCount: 2 },
      },
      retryBudget: {},
    };
    const activeRunIds = new Set(["111"]);
    pruneState(state, activeRunIds);
    assert.equal(Object.keys(state.runs).length, 1);
    assert.ok(state.runs["111"]);
    assert.ok(!state.runs["222"]);
  });

  it("keeps all entries when all runs are active", () => {
    const state = {
      runs: { "111": { issueId: "DVA-1" }, "222": { issueId: "DVA-2" } },
      retryBudget: {},
    };
    pruneState(state, new Set(["111", "222"]));
    assert.equal(Object.keys(state.runs).length, 2);
  });

  it("handles empty state", () => {
    const state = { runs: {}, retryBudget: {} };
    pruneState(state, new Set());
    assert.deepEqual(state.runs, {});
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/pulse-check.test.mjs`
Expected: FAIL — `emptyState`, `canRetry`, `incrementBudget`, `pruneState` not exported

- [ ] **Step 3: Implement state functions**

Add to `scripts/pulse-check.mjs`:

```js
// ---------------------------------------------------------------------------
// State management (pure)
// ---------------------------------------------------------------------------

/** Return a valid empty state structure. */
export function emptyState() {
  return { runs: {}, retryBudget: {} };
}

/**
 * Check whether an issue can be retried under its daily budget.
 *
 * @param {string} issueId
 * @param {object} state
 * @param {number} [maxRetries=MAX_PULSE_RETRIES]
 * @param {string} [today] - ISO date string (YYYY-MM-DD), defaults to current date
 * @returns {boolean}
 */
export function canRetry(issueId, state, maxRetries = MAX_PULSE_RETRIES, today = null) {
  const todayStr = today || new Date().toISOString().slice(0, 10);
  const entry = state.retryBudget[issueId];
  if (!entry) return true;
  if (entry.today !== todayStr) return true; // budget resets on new day
  return entry.count < maxRetries;
}

/**
 * Increment the retry budget for an issue. Resets if the day has changed.
 *
 * @param {string} issueId
 * @param {object} state - mutated in place
 * @param {string} today - ISO date string (YYYY-MM-DD)
 */
export function incrementBudget(issueId, state, today) {
  const entry = state.retryBudget[issueId];
  if (!entry || entry.today !== today) {
    state.retryBudget[issueId] = { today, count: 1 };
  } else {
    entry.count += 1;
  }
}

/**
 * Remove state entries for runs that are no longer active.
 *
 * @param {object} state - mutated in place
 * @param {Set<string>} activeRunIds - run IDs still active
 */
export function pruneState(state, activeRunIds) {
  for (const runId of Object.keys(state.runs)) {
    if (!activeRunIds.has(runId)) {
      delete state.runs[runId];
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/pulse-check.test.mjs`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/pulse-check.mjs tests/pulse-check.test.mjs
git commit -m "DVA-51: Add state management functions with tests"
```

---

### Task 3: `extractIssueFromRun` and `isPulseCheckRun` helpers

**Files:**
- Modify: `scripts/pulse-check.mjs`
- Modify: `tests/pulse-check.test.mjs`

- [ ] **Step 1: Write failing tests**

```js
import {
  extractIssueFromRun,
  isPulseCheckRun,
} from "../scripts/pulse-check.mjs";

describe("extractIssueFromRun", () => {
  it("extracts issue ID from run inputs", () => {
    const run = { inputs: { issue_id: "DVA-47" } };
    assert.equal(extractIssueFromRun(run), "DVA-47");
  });

  it("extracts issue ID from run name", () => {
    const run = { name: "Agent Worker: DVA-47 — Some title" };
    assert.equal(extractIssueFromRun(run), "DVA-47");
  });

  it("returns unknown when no issue ID found", () => {
    const run = { name: "Agent Worker" };
    assert.equal(extractIssueFromRun(run), "unknown");
  });
});

describe("isPulseCheckRun", () => {
  it("returns true for PULSE-CHECK issue_id input", () => {
    const run = { inputs: { issue_id: "PULSE-CHECK" }, name: "" };
    assert.equal(isPulseCheckRun(run), true);
  });

  it("returns true for PULSE-CHECK in run name", () => {
    const run = { name: "Agent Worker: PULSE-CHECK — Investigate" };
    assert.equal(isPulseCheckRun(run), true);
  });

  it("returns false for normal runs", () => {
    const run = { inputs: { issue_id: "DVA-47" }, name: "Agent Worker: DVA-47" };
    assert.equal(isPulseCheckRun(run), false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/pulse-check.test.mjs`
Expected: FAIL

- [ ] **Step 3: Implement helpers**

Add to `scripts/pulse-check.mjs`:

```js
// ---------------------------------------------------------------------------
// Run inspection helpers (pure)
// ---------------------------------------------------------------------------

/**
 * Extract the Linear issue ID from a workflow run.
 *
 * @param {object} run
 * @returns {string} Issue ID or "unknown"
 */
export function extractIssueFromRun(run) {
  if (run.inputs?.issue_id && run.inputs.issue_id !== "PULSE-CHECK") {
    return run.inputs.issue_id;
  }
  const match = (run.name || run.display_title || "").match(ISSUE_RE);
  return match ? match[1] : "unknown";
}

/**
 * Check if a run is a pulse-check investigation dispatch.
 *
 * @param {object} run
 * @returns {boolean}
 */
export function isPulseCheckRun(run) {
  if (run.inputs?.issue_id === "PULSE-CHECK") return true;
  if ((run.name || "").includes("PULSE-CHECK")) return true;
  return false;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/pulse-check.test.mjs`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/pulse-check.mjs tests/pulse-check.test.mjs
git commit -m "DVA-51: Add run inspection helpers with tests"
```

---

## Chunk 2: Diagnosis & Recovery Logic

### Task 4: `diagnose` function

**Files:**
- Modify: `scripts/pulse-check.mjs`
- Modify: `tests/pulse-check.test.mjs`

- [ ] **Step 1: Write failing tests for `diagnose`**

```js
import { diagnose } from "../scripts/pulse-check.mjs";

describe("diagnose", () => {
  it("returns runner-offline for stuck-queued with no online runners", () => {
    const result = diagnose("stuck-queued", { online: false }, null);
    assert.equal(result, "runner-offline");
  });

  it("returns transient for stuck-queued with runner online", () => {
    const result = diagnose("stuck-queued", { online: true }, null);
    assert.equal(result, "transient");
  });

  it("returns log-errors for stuck-running with error logs", () => {
    const result = diagnose("stuck-running", { online: true }, "Error: permission denied");
    assert.equal(result, "log-errors");
  });

  it("returns no-errors for stuck-running with clean logs", () => {
    const result = diagnose("stuck-running", { online: true }, null);
    assert.equal(result, "no-errors");
  });

  it("returns runner-offline for stuck-running with offline runner", () => {
    const result = diagnose("stuck-running", { online: false }, null);
    assert.equal(result, "runner-offline");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/pulse-check.test.mjs`
Expected: FAIL

- [ ] **Step 3: Implement `diagnose`**

Add to `scripts/pulse-check.mjs`:

```js
// ---------------------------------------------------------------------------
// Diagnosis (pure)
// ---------------------------------------------------------------------------

/**
 * Diagnose why a run is stuck.
 *
 * @param {"stuck-queued" | "stuck-running"} classification
 * @param {{ online: boolean }} runnerStatus
 * @param {string | null} logSummary - Error summary from run logs, or null
 * @returns {"runner-offline" | "transient" | "log-errors" | "no-errors"}
 */
export function diagnose(classification, runnerStatus, logSummary) {
  if (!runnerStatus.online) return "runner-offline";
  if (classification === "stuck-queued") return "transient";
  if (logSummary) return "log-errors";
  return "no-errors";
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/pulse-check.test.mjs`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/pulse-check.mjs tests/pulse-check.test.mjs
git commit -m "DVA-51: Add diagnose function with tests"
```

---

### Task 5: `decideAction` function

**Files:**
- Modify: `scripts/pulse-check.mjs`
- Modify: `tests/pulse-check.test.mjs`

- [ ] **Step 1: Write failing tests for `decideAction`**

```js
import { decideAction } from "../scripts/pulse-check.mjs";

describe("decideAction", () => {
  const baseRunState = { seenCount: 0, investigationDispatched: false };

  it("cancels and requeues for runner-offline (Level 1)", () => {
    const result = decideAction("runner-offline", baseRunState, 0);
    assert.equal(result.action, "cancel-requeue");
    assert.equal(result.level, 1);
  });

  it("waits for transient diagnosis", () => {
    const result = decideAction("transient", baseRunState, 0);
    assert.equal(result.action, "wait");
  });

  it("cancels and requeues for log-errors (Level 1)", () => {
    const result = decideAction("log-errors", baseRunState, 0);
    assert.equal(result.action, "cancel-requeue");
    assert.equal(result.level, 1);
  });

  it("waits for no-errors with low seenCount", () => {
    const result = decideAction("no-errors", { seenCount: 1, investigationDispatched: false }, 0);
    assert.equal(result.action, "wait");
  });

  it("force-cancels for no-errors when seenCount hits MAX_STUCK_OBSERVATIONS", () => {
    const result = decideAction("no-errors", { seenCount: 3, investigationDispatched: false }, 0);
    assert.equal(result.action, "cancel-requeue");
    assert.equal(result.level, 1);
  });

  it("returns Level 2 cancel when budget count is 1", () => {
    const result = decideAction("runner-offline", baseRunState, 1);
    assert.equal(result.action, "cancel-requeue");
    assert.equal(result.level, 2);
  });

  it("returns Level 2 cancel even for transient diagnosis (force-cancel regardless)", () => {
    const result = decideAction("transient", baseRunState, 1);
    assert.equal(result.action, "cancel-requeue");
    assert.equal(result.level, 2);
  });

  it("returns Level 3 halt when budget count is 2+", () => {
    const result = decideAction("runner-offline", baseRunState, 2);
    assert.equal(result.action, "halt-incident");
    assert.equal(result.level, 3);
  });

  it("dispatches Claude investigation for unknown diagnosis at Level 1", () => {
    const result = decideAction("no-errors", { seenCount: 1, investigationDispatched: false }, 0);
    // First time with no-errors and low seenCount: wait
    assert.equal(result.action, "wait");
  });

  it("flags investigation dispatch for unknown after multiple observations", () => {
    // seenCount = 2 (below MAX_STUCK_OBSERVATIONS=3), but this should also trigger investigation consideration
    const result = decideAction("no-errors", { seenCount: 2, investigationDispatched: false }, 0);
    assert.equal(result.action, "investigate");
  });

  it("skips investigation if already dispatched", () => {
    const result = decideAction("no-errors", { seenCount: 2, investigationDispatched: true }, 0);
    assert.equal(result.action, "wait");
  });
});

describe("decideAction — PULSE-CHECK investigator runs", () => {
  it("immediately halts for stuck PULSE-CHECK runs", () => {
    const result = decideAction("no-errors", { seenCount: 0, investigationDispatched: false }, 0, true);
    assert.equal(result.action, "halt-incident");
    assert.equal(result.level, 3);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/pulse-check.test.mjs`
Expected: FAIL

- [ ] **Step 3: Implement `decideAction`**

Add to `scripts/pulse-check.mjs`:

```js
// ---------------------------------------------------------------------------
// Decision logic (pure)
// ---------------------------------------------------------------------------

/**
 * Decide what action to take for a stuck run.
 *
 * @param {string} diagnosis - Output of diagnose()
 * @param {{ seenCount: number, investigationDispatched: boolean }} runState
 * @param {number} budgetCount - retryBudget[issueId].count
 * @param {boolean} [isPulseCheck=false] - True if this is a PULSE-CHECK investigator run
 * @returns {{ action: "wait" | "cancel-requeue" | "halt-incident" | "investigate", level?: number }}
 */
export function decideAction(diagnosis, runState, budgetCount, isPulseCheck = false) {
  // Stuck PULSE-CHECK investigator → immediate Level 3
  if (isPulseCheck) {
    return { action: "halt-incident", level: 3 };
  }

  // Level 3: budget exhausted
  if (budgetCount >= MAX_PULSE_RETRIES) {
    return { action: "halt-incident", level: 3 };
  }

  const level = budgetCount === 0 ? 1 : 2;

  // Level 2: always cancel-requeue regardless of diagnosis
  if (level === 2) {
    return { action: "cancel-requeue", level: 2 };
  }

  // Level 1 decision tree
  if (diagnosis === "runner-offline" || diagnosis === "log-errors") {
    return { action: "cancel-requeue", level: 1 };
  }

  // No errors: check observation count for force-cancel
  if (runState.seenCount >= MAX_STUCK_OBSERVATIONS) {
    return { action: "cancel-requeue", level: 1 };
  }

  // Dispatch Claude investigation after 2 observations with no errors
  if (diagnosis === "no-errors" && runState.seenCount >= 2 && !runState.investigationDispatched) {
    return { action: "investigate" };
  }

  return { action: "wait" };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/pulse-check.test.mjs`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/pulse-check.mjs tests/pulse-check.test.mjs
git commit -m "DVA-51: Add decideAction with recovery level logic and tests"
```

---

## Chunk 3: Orchestrate + Side-Effectful Functions

### Task 6: `orchestrate` function

**Files:**
- Modify: `scripts/pulse-check.mjs`
- Modify: `tests/pulse-check.test.mjs`

- [ ] **Step 1: Write failing tests for `orchestrate`**

Tests inject all dependencies as mocks, same pattern as `rollback.mjs`.

```js
import { orchestrate } from "../scripts/pulse-check.mjs";

describe("orchestrate", () => {
  const NOW = new Date("2026-03-16T01:00:00Z").getTime();
  const TODAY = "2026-03-16";

  function baseDeps(overrides = {}) {
    return {
      fetchRuns: async () => [],
      fetchRunners: async () => ({ online: true }),
      fetchRunLogs: async () => null,
      cancelRun: async () => {},
      dispatchRun: async () => {},
      loadState: async () => ({ runs: {}, retryBudget: {} }),
      saveState: async () => {},
      postLinearComment: async () => {},
      createGitHubIssue: async () => {},
      logAudit: async () => {},
      countDailyRuns: async () => 0,
      now: NOW,
      today: TODAY,
      ...overrides,
    };
  }

  it("takes no action when no active runs", async () => {
    const actions = [];
    const deps = baseDeps({ logAudit: async (msg) => actions.push(msg) });
    const result = await orchestrate(deps);
    assert.equal(result.actionsCount, 0);
    assert.equal(actions.length, 1); // healthy log
  });

  it("takes no action for healthy runs", async () => {
    const deps = baseDeps({
      fetchRuns: async () => [
        { id: 100, status: "in_progress", run_started_at: "2026-03-16T00:50:00Z", name: "Agent Worker: DVA-47" },
      ],
    });
    const result = await orchestrate(deps);
    assert.equal(result.actionsCount, 0);
  });

  it("cancels and requeues stuck-queued run with offline runner", async () => {
    const cancelled = [];
    const dispatched = [];
    const comments = [];
    const deps = baseDeps({
      fetchRuns: async () => [
        { id: 100, status: "queued", created_at: "2026-03-16T00:55:00Z", inputs: { issue_id: "DVA-47", issue_title: "Test task" }, name: "Agent Worker: DVA-47" },
      ],
      fetchRunners: async () => ({ online: false }),
      cancelRun: async (id) => cancelled.push(id),
      dispatchRun: async (issueId, title) => dispatched.push({ issueId, title }),
      postLinearComment: async (id, msg) => comments.push({ id, msg }),
    });
    const result = await orchestrate(deps);
    assert.equal(result.actionsCount, 1);
    assert.deepEqual(cancelled, [100]);
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].issueId, "DVA-47");
    assert.equal(comments.length, 1);
  });

  it("waits for stuck-queued run with online runner (increments seenCount)", async () => {
    let savedState = null;
    const deps = baseDeps({
      fetchRuns: async () => [
        { id: 100, status: "queued", created_at: "2026-03-16T00:55:00Z", inputs: { issue_id: "DVA-47" }, name: "Agent Worker: DVA-47" },
      ],
      fetchRunners: async () => ({ online: true }),
      saveState: async (s) => { savedState = s; },
    });
    await orchestrate(deps);
    assert.equal(savedState.runs["100"].seenCount, 1);
  });

  it("escalates to Level 3 when budget exhausted", async () => {
    const cancelled = [];
    const issues = [];
    const deps = baseDeps({
      fetchRuns: async () => [
        { id: 100, status: "queued", created_at: "2026-03-16T00:55:00Z", inputs: { issue_id: "DVA-47", issue_title: "Test" }, name: "Agent Worker: DVA-47" },
      ],
      fetchRunners: async () => ({ online: false }),
      loadState: async () => ({
        runs: {},
        retryBudget: { "DVA-47": { today: "2026-03-16", count: 2 } },
      }),
      cancelRun: async (id) => cancelled.push(id),
      createGitHubIssue: async (title, body) => issues.push({ title, body }),
    });
    const result = await orchestrate(deps);
    assert.equal(cancelled.length, 1);
    assert.equal(issues.length, 1);
    assert.ok(issues[0].title.includes("DVA-47"));
  });

  it("immediately halts for stuck PULSE-CHECK investigator run", async () => {
    const issues = [];
    const deps = baseDeps({
      fetchRuns: async () => [
        { id: 200, status: "in_progress", run_started_at: "2026-03-15T23:00:00Z", inputs: { issue_id: "PULSE-CHECK" }, name: "Agent Worker: PULSE-CHECK" },
      ],
      createGitHubIssue: async (title, body) => issues.push({ title, body }),
      cancelRun: async () => {},
    });
    const result = await orchestrate(deps);
    assert.equal(issues.length, 1);
  });

  it("handles multiple stuck runs independently in same cycle", async () => {
    const cancelled = [];
    const dispatched = [];
    const deps = baseDeps({
      fetchRuns: async () => [
        { id: 100, status: "queued", created_at: "2026-03-16T00:55:00Z", inputs: { issue_id: "DVA-47", issue_title: "Task A" }, name: "Agent Worker: DVA-47" },
        { id: 200, status: "queued", created_at: "2026-03-16T00:56:00Z", inputs: { issue_id: "DVA-48", issue_title: "Task B" }, name: "Agent Worker: DVA-48" },
      ],
      fetchRunners: async () => ({ online: false }),
      cancelRun: async (id) => cancelled.push(id),
      dispatchRun: async (issueId, title) => dispatched.push({ issueId, title }),
      postLinearComment: async () => {},
    });
    const result = await orchestrate(deps);
    assert.equal(result.actionsCount, 2);
    assert.deepEqual(cancelled, [100, 200]);
    assert.equal(dispatched.length, 2);
  });

  it("skips Claude investigation dispatch when daily quota is full", async () => {
    const dispatched = [];
    let savedState = null;
    const deps = baseDeps({
      fetchRuns: async () => [
        { id: 100, status: "in_progress", run_started_at: "2026-03-15T23:50:00Z", inputs: { issue_id: "DVA-47" }, name: "Agent Worker: DVA-47" },
      ],
      loadState: async () => ({
        runs: { "100": { issueId: "DVA-47", seenCount: 2, investigationDispatched: false, classification: "stuck-running", diagnosis: null, firstSeenAt: "2026-03-16T00:40:00Z", lastActionAt: null, logSummary: null } },
        retryBudget: {},
      }),
      fetchRunLogs: async () => null,
      countDailyRuns: async () => 4, // quota full
      dispatchRun: async (id, t) => dispatched.push(id),
      saveState: async (s) => { savedState = s; },
    });
    await orchestrate(deps);
    assert.equal(dispatched.length, 0); // investigation NOT dispatched
  });

  // Note: "Concurrent cycle prevention" is enforced by the workflow's concurrency group,
  // not by the script. This cannot be unit tested — it is verified by the workflow YAML
  // having `concurrency: { group: pulse-check, cancel-in-progress: true }`.

  it("Level 3 notifies all affected issues, not just the trigger", async () => {
    const comments = [];
    const deps = baseDeps({
      fetchRuns: async () => [
        { id: 100, status: "queued", created_at: "2026-03-16T00:55:00Z", inputs: { issue_id: "DVA-47", issue_title: "Task A" }, name: "Agent Worker: DVA-47" },
        { id: 200, status: "in_progress", run_started_at: "2026-03-16T00:50:00Z", inputs: { issue_id: "DVA-48" }, name: "Agent Worker: DVA-48" },
      ],
      fetchRunners: async () => ({ online: false }),
      loadState: async () => ({
        runs: { "200": { issueId: "DVA-48", seenCount: 1, classification: "healthy", diagnosis: null, firstSeenAt: "2026-03-16T00:50:00Z", lastActionAt: null, investigationDispatched: false, logSummary: null } },
        retryBudget: { "DVA-47": { today: "2026-03-16", count: 2 } },
      }),
      cancelRun: async () => {},
      postLinearComment: async (id, msg) => comments.push(id),
      createGitHubIssue: async () => {},
    });
    await orchestrate(deps);
    // Should notify both DVA-47 (trigger) and DVA-48 (affected)
    assert.ok(comments.includes("DVA-47"));
    assert.ok(comments.includes("DVA-48"));
  });

  it("prunes state for runs no longer active", async () => {
    let savedState = null;
    const deps = baseDeps({
      fetchRuns: async () => [],
      loadState: async () => ({
        runs: { "999": { issueId: "DVA-99", seenCount: 5 } },
        retryBudget: {},
      }),
      saveState: async (s) => { savedState = s; },
    });
    await orchestrate(deps);
    assert.equal(Object.keys(savedState.runs).length, 0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/pulse-check.test.mjs`
Expected: FAIL

- [ ] **Step 3: Implement `orchestrate`**

Add to `scripts/pulse-check.mjs`:

```js
// ---------------------------------------------------------------------------
// Orchestration (side-effectful, dependency-injected)
// ---------------------------------------------------------------------------

/**
 * Main pulse-check orchestration.
 *
 * @param {object} deps - All side-effectful dependencies injected
 * @returns {{ actionsCount: number, details: object[] }}
 */
export async function orchestrate(deps) {
  const {
    fetchRuns, fetchRunners, fetchRunLogs, cancelRun, dispatchRun,
    loadState, saveState, postLinearComment, createGitHubIssue,
    logAudit, countDailyRuns, now, today,
  } = deps;

  const state = await loadState();
  const runs = await fetchRuns();
  const runnerStatus = await fetchRunners();

  // Prune state entries for runs no longer active
  const activeRunIds = new Set(runs.map((r) => String(r.id)));
  pruneState(state, activeRunIds);

  if (runs.length === 0) {
    await logAudit("[pulse-check] All clear: no active runs");
    await saveState(state);
    return { actionsCount: 0, details: [] };
  }

  const details = [];
  let actionsCount = 0;

  for (const run of runs) {
    const runId = String(run.id);
    const classification = classifyRun(run, now);

    if (classification === "healthy") continue;

    const issueId = extractIssueFromRun(run);
    const issueTitle = run.inputs?.issue_title || run.display_title || run.name || "";
    const pulseCheck = isPulseCheckRun(run);

    // Ensure state entry exists
    if (!state.runs[runId]) {
      state.runs[runId] = {
        issueId,
        classification,
        firstSeenAt: new Date(now).toISOString(),
        seenCount: 0,
        lastActionAt: null,
        diagnosis: null,
        investigationDispatched: false,
      };
    }

    const runState = state.runs[runId];
    runState.seenCount += 1;
    runState.classification = classification;

    // Diagnose
    const logSummary = classification === "stuck-running"
      ? await fetchRunLogs(run.id)
      : null;
    const diagnosis = diagnose(classification, runnerStatus, logSummary);
    runState.diagnosis = diagnosis;
    runState.logSummary = logSummary || null;

    // Get budget count (resets daily)
    const budgetEntry = state.retryBudget[issueId];
    const budgetCount = (budgetEntry && budgetEntry.today === today)
      ? budgetEntry.count
      : 0;

    // Decide action
    const decision = decideAction(diagnosis, runState, budgetCount, pulseCheck);

    if (decision.action === "wait") {
      continue;
    }

    if (decision.action === "investigate") {
      const dailyCount = await countDailyRuns();
      if (dailyCount < 4 && !runState.investigationDispatched) {
        await dispatchRun("PULSE-CHECK", `Investigate stuck agent ${issueId} (run ${runId})`);
        runState.investigationDispatched = true;
        await logAudit(`[pulse-check] Dispatched Claude investigation for ${issueId} (run ${runId})`);
        actionsCount++;
        details.push({ runId, issueId, action: "investigate", diagnosis });
      }
      continue;
    }

    if (decision.action === "cancel-requeue") {
      await cancelRun(run.id);
      incrementBudget(issueId, state, today);
      runState.lastActionAt = new Date(now).toISOString();

      const levelMsg = `Level ${decision.level} recovery`;
      await postLinearComment(issueId,
        `Pulse check: ${issueId} ${classification} (${diagnosis}). ${levelMsg} — cancelled run ${runId} and re-queued.`
      );
      await dispatchRun(issueId, issueTitle);
      await logAudit(`[pulse-check] ${levelMsg}: cancelled ${runId} (${issueId}), diagnosis: ${diagnosis}`);

      actionsCount++;
      details.push({ runId, issueId, action: "cancel-requeue", level: decision.level, diagnosis });
      continue;
    }

    if (decision.action === "halt-incident") {
      // Cancel ALL active runs
      for (const r of runs) {
        await cancelRun(r.id);
      }

      const timeline = Object.entries(state.runs)
        .map(([id, s]) => `- Run ${id} (${s.issueId}): ${s.classification}, seen ${s.seenCount}x, diagnosis: ${s.diagnosis}`)
        .join("\n");

      const incidentTitle = `Pulse Check Incident: ${issueId} stuck after ${budgetCount} recovery attempts`;
      // Collect log excerpts from all tracked runs
      const logExcerpts = Object.entries(state.runs)
        .filter(([, s]) => s.logSummary)
        .map(([id, s]) => `- Run ${id} (${s.issueId}):\n  ${s.logSummary}`)
        .join("\n");

      const incidentBody = [
        `## Incident Summary`,
        ``,
        `**Task:** ${issueId} — ${issueTitle}`,
        `**Classification:** ${classification}`,
        `**Diagnosis:** ${diagnosis}`,
        `**Recovery attempts:** ${budgetCount}`,
        `**Runner status:** ${runnerStatus.online ? "online" : "offline"}`,
        ``,
        `## Timeline`,
        ``,
        timeline,
        ...(logExcerpts ? [``, `## Log Excerpts`, ``, logExcerpts] : []),
        ``,
        `## Action Taken`,
        ``,
        `All active agent-worker runs have been cancelled.`,
      ].join("\n");

      await createGitHubIssue(incidentTitle, incidentBody);

      // Notify ALL affected issues, not just the triggering one
      const affectedIssues = new Set(
        Object.values(state.runs).map((s) => s.issueId).filter((id) => id !== "unknown")
      );
      affectedIssues.add(issueId);
      for (const affected of affectedIssues) {
        await postLinearComment(affected,
          `Pulse check incident: ${issueId} stuck after ${budgetCount} recovery attempts. All agents halted. See GitHub issue for details.`
        );
      }
      await logAudit(`[pulse-check] Level 3 incident: ${issueId} — all agents halted`);

      actionsCount++;
      details.push({ runId, issueId, action: "halt-incident", level: 3, diagnosis });
      break; // Stop processing — we've halted everything
    }
  }

  // Log healthy summary if no actions taken
  if (actionsCount === 0) {
    const summary = runs.map((r) => {
      const id = extractIssueFromRun(r);
      const elapsed = Math.floor((now - new Date(r.run_started_at || r.created_at).getTime()) / 1000);
      const mins = Math.floor(elapsed / 60);
      const secs = elapsed % 60;
      return `${id} (${mins}m ${secs}s)`;
    }).join(", ");
    await logAudit(`[pulse-check] All clear: ${runs.length} active run(s): ${summary}, runner ${runnerStatus.online ? "online" : "offline"}`);
  }

  await saveState(state);
  return { actionsCount, details };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/pulse-check.test.mjs`
Expected: All tests PASS

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: All 359+ tests PASS (existing + new pulse-check tests)

- [ ] **Step 6: Commit**

```bash
git add scripts/pulse-check.mjs tests/pulse-check.test.mjs
git commit -m "DVA-51: Add orchestrate function with full recovery logic and tests"
```

---

## Chunk 4: CLI Entry Point + Side-Effect Wrappers + Workflow

### Task 7: CLI entry point and side-effect wrappers

**Files:**
- Modify: `scripts/pulse-check.mjs`

- [ ] **Step 1: Add side-effect wrappers and CLI main block**

These are the real implementations of the injected deps, wrapping `gh` CLI and `scripts/linear.mjs`. Not unit tested (they call external systems); tested via integration in CI.

Add to `scripts/pulse-check.mjs`:

```js
// ---------------------------------------------------------------------------
// Side-effect wrappers (not unit tested — integration only)
// ---------------------------------------------------------------------------

function ghApi(endpoint) {
  try {
    const output = execSync(`gh api "${endpoint}"`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return JSON.parse(output);
  } catch {
    return null;
  }
}

async function realFetchRuns() {
  const data = ghApi(
    `/repos/{owner}/{repo}/actions/workflows/${WORKFLOW_FILE}/runs?status=queued&status=in_progress&per_page=30`
  );
  return data?.workflow_runs || [];
}

async function realFetchRunners() {
  const data = ghApi(`/repos/{owner}/{repo}/actions/runners`);
  const runners = data?.runners || [];
  const online = runners.some((r) => r.status === "online");
  return { online, runners };
}

async function realFetchRunLogs(runId) {
  try {
    const output = execSync(`gh run view ${runId} --log`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 30000,
    });
    // Take last 100 lines (JS-side, no shell pipe needed)
    const lines = output.split("\n").slice(-100).join("\n");
    // Search for error patterns
    const errorPatterns = [/Error:/i, /permission denied/i, /rate limit/i, /FATAL/i, /failed/i];
    const matches = errorPatterns
      .filter((p) => p.test(lines))
      .map((p) => lines.match(new RegExp(`.*${p.source}.*`, "im"))?.[0]?.trim())
      .filter(Boolean);
    return matches.length > 0 ? matches.join("\n") : null;
  } catch {
    return null;
  }
}

async function realCancelRun(runId) {
  execSync(`gh run cancel ${runId}`, { stdio: "pipe" });
}

async function realDispatchRun(issueId, issueTitle) {
  execSync(
    `gh workflow run ${WORKFLOW_FILE} -f issue_id="${issueId}" -f issue_title="${issueTitle}"`,
    { stdio: "pipe" }
  );
}

async function realLoadState() {
  try {
    const output = execSync(
      `gh api repos/{owner}/{repo}/actions/variables/PULSE_CHECK_STATE --jq '.value'`,
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
    );
    return JSON.parse(output.trim()) || emptyState();
  } catch {
    return emptyState();
  }
}

async function realSaveState(state) {
  const json = JSON.stringify(state);
  try {
    execSync(
      `gh api --method PATCH repos/{owner}/{repo}/actions/variables/PULSE_CHECK_STATE -f name=PULSE_CHECK_STATE -f value='${json.replace(/'/g, "'\\''")}'`,
      { stdio: "pipe" }
    );
  } catch {
    // Variable might not exist yet — create it
    execSync(
      `gh api --method POST repos/{owner}/{repo}/actions/variables -f name=PULSE_CHECK_STATE -f value='${json.replace(/'/g, "'\\''")}'`,
      { stdio: "pipe" }
    );
  }
}

async function realPostLinearComment(issueId, message) {
  if (issueId === "unknown" || issueId === "PULSE-CHECK") return;
  try {
    execSync(
      `node ${join(__dirname, "linear.mjs")} comment "${issueId}" "${message.replace(/"/g, '\\"')}"`,
      { stdio: "pipe", env: { ...process.env } }
    );
  } catch {
    // Best effort — don't fail pulse check on Linear errors
  }
}

async function realCreateGitHubIssue(title, body) {
  execSync(
    `gh issue create --title "${title.replace(/"/g, '\\"')}" --body "${body.replace(/"/g, '\\"')}" --label incident`,
    { stdio: "pipe" }
  );
}

async function realLogAudit(message) {
  try {
    execSync(
      `node ${join(__dirname, "audit.mjs")} log pulse-check "${message.replace(/"/g, '\\"')}"`,
      { stdio: "pipe" }
    );
  } catch {
    console.log(message);
  }
}

async function realCountDailyRuns() {
  const data = ghApi(
    `/repos/{owner}/{repo}/actions/workflows/${WORKFLOW_FILE}/runs?per_page=30`
  );
  const runs = data?.workflow_runs || [];
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  return runs.filter((r) => new Date(r.created_at).getTime() > cutoff).length;
}

// ---------------------------------------------------------------------------
// CLI (imports are at the top of the file from Task 1)
// ---------------------------------------------------------------------------

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const command = process.argv[2];

  if (command === "check") {
    const now = Date.now();
    const today = new Date(now).toISOString().slice(0, 10);

    const result = await orchestrate({
      fetchRuns: realFetchRuns,
      fetchRunners: realFetchRunners,
      fetchRunLogs: realFetchRunLogs,
      cancelRun: realCancelRun,
      dispatchRun: realDispatchRun,
      loadState: realLoadState,
      saveState: realSaveState,
      postLinearComment: realPostLinearComment,
      createGitHubIssue: realCreateGitHubIssue,
      logAudit: realLogAudit,
      countDailyRuns: realCountDailyRuns,
      now,
      today,
    });

    console.log(`Pulse check complete: ${result.actionsCount} action(s) taken`);
    if (result.details.length > 0) {
      for (const d of result.details) {
        console.log(`  ${d.issueId}: ${d.action} (${d.diagnosis})`);
      }
    }
  } else {
    console.log("Usage: node scripts/pulse-check.mjs check");
    console.log("");
    console.log("Commands:");
    console.log("  check    Run pulse check on active agent workflows");
  }
}
```

Note: All imports (`execSync`, `dirname`, `join`, `fileURLToPath`, `pathToFileURL`) and the `__dirname` constant are already at the top of the file from Task 1. The side-effect wrappers use them directly.

- [ ] **Step 2: Run full test suite**

Run: `npm test`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add scripts/pulse-check.mjs
git commit -m "DVA-51: Add CLI entry point and side-effect wrappers"
```

---

### Task 8: GitHub Actions workflow

**Files:**
- Create: `.github/workflows/pulse-check.yml`

- [ ] **Step 1: Create the workflow file**

```yaml
name: Pulse Check

on:
  schedule:
    - cron: "*/10 * * * *"
  workflow_dispatch:

concurrency:
  group: pulse-check
  cancel-in-progress: true

permissions:
  contents: read
  actions: write
  issues: write

jobs:
  pulse-check:
    runs-on: ubuntu-latest
    if: ${{ vars.AGENT_AUTOPILOT == 'true' }}
    steps:
      - name: Autopilot gate
        run: echo "Autopilot enabled — running pulse check"

      - name: Checkout
        uses: actions/checkout@v5

      - name: Setup Node.js
        uses: actions/setup-node@v5
        with:
          node-version: 22

      - name: Install dependencies
        run: npm ci

      - name: Run pulse check
        run: node scripts/pulse-check.mjs check
        env:
          GITHUB_TOKEN: ${{ secrets.PAT_WITH_WORKFLOW }}
          LINEAR_API_KEY: ${{ secrets.LINEAR_API_KEY }}
```

- [ ] **Step 2: Run `pre-pr-review.mjs` to verify conventions and security**

Run: `node scripts/pre-pr-review.mjs`
Expected: All 5 gates pass (no hardcoded secrets, conventions followed)

- [ ] **Step 3: Run full test suite one final time**

Run: `npm test`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/pulse-check.yml
git commit -m "DVA-51: Add pulse-check cron workflow"
```

---

### Task 9: Final integration commit and PR

**Files:**
- No new files — just verification and PR creation

- [ ] **Step 1: Run pre-PR review**

Run: `node scripts/pre-pr-review.mjs`
Expected: All 5 gates pass

- [ ] **Step 2: Push branch and create PR**

```bash
git push origin HEAD
gh pr create --title "DVA-51: Pulse check — automated agent health monitoring" \
  --body "$(cat <<'EOF'
## Summary
- Adds `scripts/pulse-check.mjs` with detection, classification, diagnosis, recovery (3 levels), and Claude escalation
- Adds `pulse-check.yml` cron workflow running every 10 minutes on `ubuntu-latest`
- State persists across ephemeral runners via `PULSE_CHECK_STATE` repo variable
- Separate retry budget from daily task quota

## Test plan
- [ ] Verify all new tests pass (`npm test`)
- [ ] Verify pre-PR review passes (`node scripts/pre-pr-review.mjs`)
- [ ] Create `PULSE_CHECK_STATE` repo variable (initially `{}`)
- [ ] Ensure `PAT_WITH_WORKFLOW` has Variables write permission
- [ ] Enable `AGENT_AUTOPILOT=true` and verify pulse-check workflow runs on schedule
- [ ] Test manually: `gh workflow run pulse-check.yml` and check job output

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```
