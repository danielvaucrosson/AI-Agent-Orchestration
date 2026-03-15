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
