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
