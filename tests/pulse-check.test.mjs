// tests/pulse-check.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyRun,
  emptyState,
  canRetry,
  incrementBudget,
  pruneState,
  extractIssueFromRun,
  isPulseCheckRun,
  diagnose,
  decideAction,
  orchestrate,
} from "../scripts/pulse-check.mjs";

describe("classifyRun", () => {
  it("returns healthy for a queued run under 2 minutes", () => {
    const now = new Date("2026-03-15T12:02:00Z");
    const run = {
      status: "queued",
      created_at: "2026-03-15T12:01:00Z",
    };
    assert.equal(classifyRun(run, now), "healthy");
  });

  it("returns stuck-queued for a queued run at exactly 2 minutes", () => {
    const now = new Date("2026-03-15T12:02:00Z");
    const run = {
      status: "queued",
      created_at: "2026-03-15T12:00:00Z",
    };
    assert.equal(classifyRun(run, now), "stuck-queued");
  });

  it("returns stuck-queued for a queued run over 2 minutes", () => {
    const now = new Date("2026-03-15T12:05:00Z");
    const run = {
      status: "queued",
      created_at: "2026-03-15T12:00:00Z",
    };
    assert.equal(classifyRun(run, now), "stuck-queued");
  });

  it("returns healthy for an in_progress run under 60 minutes", () => {
    const now = new Date("2026-03-15T12:30:00Z");
    const run = {
      status: "in_progress",
      run_started_at: "2026-03-15T12:00:00Z",
      created_at: "2026-03-15T11:59:00Z",
    };
    assert.equal(classifyRun(run, now), "healthy");
  });

  it("returns stuck-running for an in_progress run at exactly 60 minutes", () => {
    const now = new Date("2026-03-15T13:00:00Z");
    const run = {
      status: "in_progress",
      run_started_at: "2026-03-15T12:00:00Z",
      created_at: "2026-03-15T11:59:00Z",
    };
    assert.equal(classifyRun(run, now), "stuck-running");
  });

  it("returns stuck-running for an in_progress run over 60 minutes", () => {
    const now = new Date("2026-03-15T14:00:00Z");
    const run = {
      status: "in_progress",
      run_started_at: "2026-03-15T12:00:00Z",
      created_at: "2026-03-15T11:59:00Z",
    };
    assert.equal(classifyRun(run, now), "stuck-running");
  });

  it("falls back to created_at when run_started_at is missing for in_progress", () => {
    const now = new Date("2026-03-15T13:01:00Z");
    const run = {
      status: "in_progress",
      created_at: "2026-03-15T12:00:00Z",
    };
    assert.equal(classifyRun(run, now), "stuck-running");
  });

  it("returns healthy for completed runs", () => {
    const now = new Date("2026-03-15T14:00:00Z");
    const run = {
      status: "completed",
      created_at: "2026-03-15T12:00:00Z",
    };
    assert.equal(classifyRun(run, now), "healthy");
  });

  it("returns healthy for unknown statuses", () => {
    const now = new Date("2026-03-15T14:00:00Z");
    const run = {
      status: "waiting",
      created_at: "2026-03-15T12:00:00Z",
    };
    assert.equal(classifyRun(run, now), "healthy");
  });
});

describe("emptyState", () => {
  it("returns an object with empty runs and retryBudget", () => {
    const state = emptyState();
    assert.deepEqual(state, { runs: {}, retryBudget: {} });
  });

  it("returns a new object each call", () => {
    const a = emptyState();
    const b = emptyState();
    assert.notEqual(a, b);
    assert.notEqual(a.runs, b.runs);
  });
});

describe("canRetry", () => {
  it("returns true when no budget entry exists for the issue", () => {
    const state = emptyState();
    assert.equal(canRetry("DVA-10", state), true);
  });

  it("returns true when count is 0", () => {
    const state = { runs: {}, retryBudget: { "DVA-10": { count: 0, day: "2026-03-15" } } };
    assert.equal(canRetry("DVA-10", state), true);
  });

  it("returns true when count is 1 (under default max of 2)", () => {
    const state = { runs: {}, retryBudget: { "DVA-10": { count: 1, day: "2026-03-15" } } };
    assert.equal(canRetry("DVA-10", state, 2, "2026-03-15"), true);
  });

  it("returns false when count equals maxRetries", () => {
    const state = { runs: {}, retryBudget: { "DVA-10": { count: 2, day: "2026-03-15" } } };
    assert.equal(canRetry("DVA-10", state, 2, "2026-03-15"), false);
  });

  it("returns false when count exceeds maxRetries", () => {
    const state = { runs: {}, retryBudget: { "DVA-10": { count: 5, day: "2026-03-15" } } };
    assert.equal(canRetry("DVA-10", state, 2, "2026-03-15"), false);
  });

  it("resets budget and returns true when day has changed", () => {
    const state = { runs: {}, retryBudget: { "DVA-10": { count: 2, day: "2026-03-14" } } };
    assert.equal(canRetry("DVA-10", state, 2, "2026-03-15"), true);
  });

  it("uses custom maxRetries", () => {
    const state = { runs: {}, retryBudget: { "DVA-10": { count: 3, day: "2026-03-15" } } };
    assert.equal(canRetry("DVA-10", state, 5, "2026-03-15"), true);
  });
});

describe("incrementBudget", () => {
  it("creates a new budget entry when none exists", () => {
    const state = emptyState();
    incrementBudget("DVA-10", state, "2026-03-15");
    assert.deepEqual(state.retryBudget["DVA-10"], { count: 1, day: "2026-03-15" });
  });

  it("increments existing budget entry", () => {
    const state = { runs: {}, retryBudget: { "DVA-10": { count: 1, day: "2026-03-15" } } };
    incrementBudget("DVA-10", state, "2026-03-15");
    assert.equal(state.retryBudget["DVA-10"].count, 2);
  });

  it("resets count on a new day", () => {
    const state = { runs: {}, retryBudget: { "DVA-10": { count: 5, day: "2026-03-14" } } };
    incrementBudget("DVA-10", state, "2026-03-15");
    assert.deepEqual(state.retryBudget["DVA-10"], { count: 1, day: "2026-03-15" });
  });
});

describe("pruneState", () => {
  it("removes inactive run entries", () => {
    const state = {
      runs: { "111": { classification: "healthy" }, "222": { classification: "stuck-queued" } },
      retryBudget: {},
    };
    pruneState(state, new Set(["111"]));
    assert.deepEqual(Object.keys(state.runs), ["111"]);
  });

  it("keeps all active run entries", () => {
    const state = {
      runs: { "111": { classification: "healthy" }, "222": { classification: "healthy" } },
      retryBudget: {},
    };
    pruneState(state, new Set(["111", "222"]));
    assert.deepEqual(Object.keys(state.runs).sort(), ["111", "222"]);
  });

  it("handles empty state", () => {
    const state = emptyState();
    pruneState(state, new Set(["111"]));
    assert.deepEqual(state.runs, {});
  });

  it("handles empty activeRunIds set", () => {
    const state = {
      runs: { "111": { classification: "healthy" } },
      retryBudget: {},
    };
    pruneState(state, new Set());
    assert.deepEqual(state.runs, {});
  });
});

describe("extractIssueFromRun", () => {
  it("extracts issue ID from run.inputs.issue_id", () => {
    const run = { inputs: { issue_id: "DVA-10" }, name: "agent-worker", display_title: "some title" };
    assert.equal(extractIssueFromRun(run), "DVA-10");
  });

  it("skips PULSE-CHECK input and falls back to name", () => {
    const run = { inputs: { issue_id: "PULSE-CHECK" }, name: "DVA-15 agent run", display_title: "" };
    assert.equal(extractIssueFromRun(run), "DVA-15");
  });

  it("extracts issue ID from run.name via regex", () => {
    const run = { inputs: {}, name: "Agent: DVA-22 fix auth", display_title: "" };
    assert.equal(extractIssueFromRun(run), "DVA-22");
  });

  it("extracts issue ID from run.display_title via regex", () => {
    const run = { inputs: {}, name: "agent-worker", display_title: "DVA-33: Fix bug" };
    assert.equal(extractIssueFromRun(run), "DVA-33");
  });

  it("returns unknown when no issue ID found anywhere", () => {
    const run = { inputs: {}, name: "agent-worker", display_title: "routine maintenance" };
    assert.equal(extractIssueFromRun(run), "unknown");
  });

  it("returns unknown when inputs is missing entirely", () => {
    const run = { name: "worker", display_title: "no issue here" };
    assert.equal(extractIssueFromRun(run), "unknown");
  });

  it("handles missing name and display_title gracefully", () => {
    const run = { inputs: {} };
    assert.equal(extractIssueFromRun(run), "unknown");
  });
});

describe("isPulseCheckRun", () => {
  it("returns true when inputs.issue_id is PULSE-CHECK", () => {
    const run = { inputs: { issue_id: "PULSE-CHECK" }, name: "agent-worker" };
    assert.equal(isPulseCheckRun(run), true);
  });

  it("returns true when name includes PULSE-CHECK", () => {
    const run = { inputs: {}, name: "PULSE-CHECK monitor" };
    assert.equal(isPulseCheckRun(run), true);
  });

  it("returns true when display_title includes PULSE-CHECK", () => {
    const run = { inputs: {}, name: "agent-worker", display_title: "PULSE-CHECK scan" };
    assert.equal(isPulseCheckRun(run), true);
  });

  it("returns false for a normal run", () => {
    const run = { inputs: { issue_id: "DVA-10" }, name: "agent-worker", display_title: "DVA-10: Fix" };
    assert.equal(isPulseCheckRun(run), false);
  });

  it("returns false when inputs is missing", () => {
    const run = { name: "agent-worker" };
    assert.equal(isPulseCheckRun(run), false);
  });
});

describe("diagnose", () => {
  it("returns runner-offline for stuck-queued with offline runner", () => {
    assert.equal(diagnose("stuck-queued", { online: false }, null), "runner-offline");
  });

  it("returns transient for stuck-queued with online runner", () => {
    assert.equal(diagnose("stuck-queued", { online: true }, null), "transient");
  });

  it("returns log-errors for stuck-running with error logs", () => {
    assert.equal(diagnose("stuck-running", { online: true }, "Error: OOM killed"), "log-errors");
  });

  it("returns no-errors for stuck-running with clean logs", () => {
    assert.equal(diagnose("stuck-running", { online: true }, null), "no-errors");
  });

  it("returns runner-offline for stuck-running with offline runner", () => {
    assert.equal(diagnose("stuck-running", { online: false }, "Error: timeout"), "runner-offline");
  });
});

describe("decideAction", () => {
  it("returns cancel-requeue Level 1 for runner-offline (budget 0)", () => {
    const result = decideAction("runner-offline", { seenCount: 1, investigationDispatched: false }, 0);
    assert.deepEqual(result, { action: "cancel-requeue", level: 1 });
  });

  it("returns wait for transient diagnosis", () => {
    const result = decideAction("transient", { seenCount: 1, investigationDispatched: false }, 0);
    assert.deepEqual(result, { action: "wait" });
  });

  it("returns cancel-requeue Level 1 for log-errors (budget 0)", () => {
    const result = decideAction("log-errors", { seenCount: 1, investigationDispatched: false }, 0);
    assert.deepEqual(result, { action: "cancel-requeue", level: 1 });
  });

  it("returns wait for no-errors with low seenCount", () => {
    const result = decideAction("no-errors", { seenCount: 1, investigationDispatched: false }, 0);
    assert.deepEqual(result, { action: "wait" });
  });

  it("returns cancel-requeue Level 1 when seenCount hits MAX_STUCK_OBSERVATIONS (3)", () => {
    const result = decideAction("no-errors", { seenCount: 3, investigationDispatched: false }, 0);
    assert.deepEqual(result, { action: "cancel-requeue", level: 1 });
  });

  it("returns cancel-requeue Level 2 when budget count is 1 (regardless of diagnosis)", () => {
    const result = decideAction("no-errors", { seenCount: 1, investigationDispatched: false }, 1);
    assert.deepEqual(result, { action: "cancel-requeue", level: 2 });
  });

  it("returns cancel-requeue Level 2 even for transient diagnosis (force-cancel)", () => {
    const result = decideAction("transient", { seenCount: 1, investigationDispatched: false }, 1);
    assert.deepEqual(result, { action: "cancel-requeue", level: 2 });
  });

  it("returns halt-incident Level 3 when budget count is 2+", () => {
    const result = decideAction("no-errors", { seenCount: 1, investigationDispatched: false }, 2);
    assert.deepEqual(result, { action: "halt-incident", level: 3 });
  });

  it("returns investigate for no-errors + seenCount 2 + not dispatched yet", () => {
    const result = decideAction("no-errors", { seenCount: 2, investigationDispatched: false }, 0);
    assert.deepEqual(result, { action: "investigate" });
  });

  it("returns wait (skip investigation) if already dispatched", () => {
    const result = decideAction("no-errors", { seenCount: 2, investigationDispatched: true }, 0);
    assert.deepEqual(result, { action: "wait" });
  });

  it("returns halt-incident Level 3 immediately for PULSE-CHECK runs", () => {
    const result = decideAction("no-errors", { seenCount: 1, investigationDispatched: false }, 0, true);
    assert.deepEqual(result, { action: "halt-incident", level: 3 });
  });
});

// --- orchestrate tests ---

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

describe("orchestrate", () => {
  it("no active runs returns actionsCount 0 and logs All clear", async () => {
    const logs = [];
    const result = await orchestrate(baseDeps({
      logAudit: async (msg) => logs.push(msg),
    }));
    assert.equal(result.actionsCount, 0);
    assert.deepEqual(result.details, []);
    assert.ok(logs.some((m) => m.includes("All clear")));
  });

  it("healthy runs return actionsCount 0", async () => {
    const logs = [];
    const result = await orchestrate(baseDeps({
      fetchRuns: async () => [
        { id: 100, status: "in_progress", run_started_at: "2026-03-16T00:30:00Z", created_at: "2026-03-16T00:29:00Z", inputs: { issue_id: "DVA-10" }, name: "agent-worker", display_title: "DVA-10: Fix" },
      ],
      logAudit: async (msg) => logs.push(msg),
    }));
    assert.equal(result.actionsCount, 0);
    assert.ok(logs.some((m) => m.includes("All clear") && m.includes("1 active run")));
  });

  it("stuck-queued + runner offline cancels run, dispatches requeue, posts Linear comment", async () => {
    const cancelled = [];
    const dispatched = [];
    const comments = [];
    const result = await orchestrate(baseDeps({
      fetchRuns: async () => [
        { id: 200, status: "queued", created_at: "2026-03-16T00:50:00Z", inputs: { issue_id: "DVA-11", issue_title: "Fix auth" }, name: "agent-worker", display_title: "DVA-11: Fix auth" },
      ],
      fetchRunners: async () => ({ online: false }),
      cancelRun: async (id) => cancelled.push(id),
      dispatchRun: async (issueId, title) => dispatched.push({ issueId, title }),
      postLinearComment: async (issueId, body) => comments.push({ issueId, body }),
    }));
    assert.equal(result.actionsCount, 1);
    assert.equal(result.details[0].action, "cancel-requeue");
    assert.deepEqual(cancelled, [200]);
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].issueId, "DVA-11");
    assert.equal(comments.length, 1);
    assert.ok(comments[0].body.includes("DVA-11"));
  });

  it("stuck-queued + runner online increments seenCount, no action (transient wait)", async () => {
    let savedState = null;
    const result = await orchestrate(baseDeps({
      fetchRuns: async () => [
        { id: 300, status: "queued", created_at: "2026-03-16T00:50:00Z", inputs: { issue_id: "DVA-12" }, name: "agent-worker", display_title: "DVA-12: task" },
      ],
      fetchRunners: async () => ({ online: true }),
      saveState: async (s) => { savedState = s; },
    }));
    assert.equal(result.actionsCount, 0);
    assert.ok(savedState);
    assert.equal(savedState.runs["300"].seenCount, 1);
  });

  it("budget exhausted triggers Level 3 halt-incident and creates GitHub issue", async () => {
    const cancelled = [];
    let ghIssueCreated = false;
    const result = await orchestrate(baseDeps({
      fetchRuns: async () => [
        { id: 400, status: "queued", created_at: "2026-03-16T00:50:00Z", inputs: { issue_id: "DVA-13", issue_title: "Broken task" }, name: "agent-worker", display_title: "DVA-13: Broken" },
      ],
      fetchRunners: async () => ({ online: false }),
      loadState: async () => ({
        runs: {},
        retryBudget: { "DVA-13": { count: 2, day: TODAY } },
      }),
      cancelRun: async (id) => cancelled.push(id),
      createGitHubIssue: async () => { ghIssueCreated = true; },
    }));
    assert.equal(result.actionsCount, 1);
    assert.equal(result.details[0].action, "halt-incident");
    assert.equal(result.details[0].level, 3);
    assert.ok(ghIssueCreated);
    assert.deepEqual(cancelled, [400]);
  });

  it("Level 2 recovery when budget count is 1 (cancel-requeue regardless of diagnosis)", async () => {
    const cancelled = [];
    const dispatched = [];
    const comments = [];
    const result = await orchestrate(baseDeps({
      fetchRuns: async () => [
        { id: 600, status: "queued", created_at: "2026-03-16T00:55:00Z", inputs: { issue_id: "DVA-20", issue_title: "Level 2 task" }, name: "agent-worker", display_title: "DVA-20: Level 2 task" },
      ],
      fetchRunners: async () => ({ online: true }), // runner is online — but Level 2 cancels regardless
      loadState: async () => ({
        runs: {},
        retryBudget: { "DVA-20": { count: 1, day: TODAY } },
      }),
      cancelRun: async (id) => cancelled.push(id),
      dispatchRun: async (issueId, title) => dispatched.push({ issueId, title }),
      postLinearComment: async (id, msg) => comments.push({ id, msg }),
    }));
    assert.equal(result.actionsCount, 1);
    assert.deepEqual(cancelled, [600]);
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].issueId, "DVA-20");
    assert.equal(result.details[0].level, 2);
    assert.equal(comments.length, 1);
  });

  it("stuck PULSE-CHECK investigator triggers immediate Level 3", async () => {
    const cancelled = [];
    let ghIssueCreated = false;
    const result = await orchestrate(baseDeps({
      fetchRuns: async () => [
        { id: 500, status: "queued", created_at: "2026-03-16T00:50:00Z", inputs: { issue_id: "PULSE-CHECK" }, name: "PULSE-CHECK monitor", display_title: "PULSE-CHECK" },
      ],
      fetchRunners: async () => ({ online: true }),
      cancelRun: async (id) => cancelled.push(id),
      createGitHubIssue: async () => { ghIssueCreated = true; },
    }));
    assert.equal(result.actionsCount, 1);
    assert.equal(result.details[0].action, "halt-incident");
    assert.equal(result.details[0].level, 3);
    assert.ok(ghIssueCreated);
  });

  it("prunes state for inactive runs", async () => {
    let savedState = null;
    await orchestrate(baseDeps({
      fetchRuns: async () => [],
      loadState: async () => ({
        runs: { "999": { issueId: "DVA-99", classification: "stuck-queued", seenCount: 3 } },
        retryBudget: {},
      }),
      saveState: async (s) => { savedState = s; },
    }));
    assert.ok(savedState);
    assert.deepEqual(savedState.runs, {});
  });

  it("multiple stuck runs handled independently (both cancelled)", async () => {
    const cancelled = [];
    const dispatched = [];
    const result = await orchestrate(baseDeps({
      fetchRuns: async () => [
        { id: 601, status: "queued", created_at: "2026-03-16T00:50:00Z", inputs: { issue_id: "DVA-20", issue_title: "Task A" }, name: "agent-worker", display_title: "DVA-20" },
        { id: 602, status: "queued", created_at: "2026-03-16T00:50:00Z", inputs: { issue_id: "DVA-21", issue_title: "Task B" }, name: "agent-worker", display_title: "DVA-21" },
      ],
      fetchRunners: async () => ({ online: false }),
      cancelRun: async (id) => cancelled.push(id),
      dispatchRun: async (issueId, title) => dispatched.push({ issueId, title }),
    }));
    assert.equal(result.actionsCount, 2);
    assert.deepEqual(cancelled, [601, 602]);
    assert.equal(dispatched.length, 2);
  });

  it("skips Claude investigation when daily quota full (countDailyRuns returns 4)", async () => {
    const dispatched = [];
    const result = await orchestrate(baseDeps({
      fetchRuns: async () => [
        { id: 700, status: "in_progress", run_started_at: "2026-03-15T23:00:00Z", created_at: "2026-03-15T22:59:00Z", inputs: { issue_id: "DVA-30" }, name: "agent-worker", display_title: "DVA-30" },
      ],
      fetchRunners: async () => ({ online: true }),
      fetchRunLogs: async () => null,
      loadState: async () => ({
        runs: {
          "700": {
            issueId: "DVA-30",
            classification: "stuck-running",
            firstSeenAt: "2026-03-16T00:00:00Z",
            seenCount: 1,
            lastActionAt: null,
            diagnosis: null,
            investigationDispatched: false,
            logSummary: null,
          },
        },
        retryBudget: {},
      }),
      countDailyRuns: async () => 4,
      dispatchRun: async (issueId, title) => dispatched.push({ issueId, title }),
    }));
    // seenCount becomes 2 (1 existing + 1 increment), no-errors + seenCount 2 => investigate
    // but countDailyRuns is 4, so investigation is skipped
    assert.equal(result.actionsCount, 0);
    assert.equal(dispatched.length, 0);
  });

  it("Level 3 notifies ALL affected issues (2 issues both get Linear comments)", async () => {
    const comments = [];
    const result = await orchestrate(baseDeps({
      fetchRuns: async () => [
        { id: 801, status: "queued", created_at: "2026-03-16T00:50:00Z", inputs: { issue_id: "DVA-40", issue_title: "Task X" }, name: "agent-worker", display_title: "DVA-40" },
        { id: 802, status: "queued", created_at: "2026-03-16T00:50:00Z", inputs: { issue_id: "DVA-41", issue_title: "Task Y" }, name: "agent-worker", display_title: "DVA-41" },
      ],
      fetchRunners: async () => ({ online: false }),
      loadState: async () => ({
        runs: {
          "802": {
            issueId: "DVA-41",
            classification: "stuck-queued",
            firstSeenAt: "2026-03-16T00:00:00Z",
            seenCount: 1,
            lastActionAt: null,
            diagnosis: null,
            investigationDispatched: false,
            logSummary: null,
          },
        },
        retryBudget: { "DVA-40": { count: 2, day: TODAY } },
      }),
      cancelRun: async () => {},
      createGitHubIssue: async () => {},
      postLinearComment: async (issueId, body) => comments.push({ issueId, body }),
    }));
    assert.equal(result.actionsCount, 1);
    assert.equal(result.details[0].action, "halt-incident");
    // Both DVA-40 and DVA-41 should receive notifications
    const notifiedIssues = comments.map((c) => c.issueId).sort();
    assert.ok(notifiedIssues.includes("DVA-40"), "DVA-40 should be notified");
    assert.ok(notifiedIssues.includes("DVA-41"), "DVA-41 should be notified");
  });
});
