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
