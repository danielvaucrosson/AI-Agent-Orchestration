// tests/pulse-check.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyRun,
  emptyState,
  canRetry,
  incrementBudget,
  pruneState,
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
