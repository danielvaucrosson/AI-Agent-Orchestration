import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  categorizeRuns,
  extractRunInfo,
  formatDuration,
  formatCompletedDuration,
  countDailyRuns,
  matchRunsToPRs,
  renderDashboard,
} from "../scripts/agent-dashboard.mjs";

// ---------------------------------------------------------------------------
// categorizeRuns
// ---------------------------------------------------------------------------

describe("categorizeRuns", () => {
  it("separates active and completed runs", () => {
    const runs = [
      { id: 1, status: "in_progress" },
      { id: 2, status: "completed", conclusion: "success" },
      { id: 3, status: "queued" },
      { id: 4, status: "completed", conclusion: "failure" },
    ];
    const result = categorizeRuns(runs);
    assert.equal(result.active.length, 2);
    assert.equal(result.completed.length, 2);
    assert.deepEqual(
      result.active.map((r) => r.id),
      [1, 3]
    );
  });

  it("returns empty arrays when no runs exist", () => {
    const result = categorizeRuns([]);
    assert.equal(result.active.length, 0);
    assert.equal(result.completed.length, 0);
  });

  it("ignores runs with unknown status", () => {
    const runs = [{ id: 1, status: "waiting" }];
    const result = categorizeRuns(runs);
    assert.equal(result.active.length, 0);
    assert.equal(result.completed.length, 0);
  });
});

// ---------------------------------------------------------------------------
// extractRunInfo
// ---------------------------------------------------------------------------

describe("extractRunInfo", () => {
  it("extracts from workflow dispatch inputs", () => {
    const run = {
      inputs: { issue_id: "DVA-40", issue_title: "Filter archived issues" },
    };
    const info = extractRunInfo(run);
    assert.equal(info.issueId, "DVA-40");
    assert.equal(info.issueTitle, "Filter archived issues");
  });

  it("falls back to display_title matching", () => {
    const run = {
      display_title: "DVA-38: Upgrade Actions v5",
      name: "Agent Worker",
    };
    const info = extractRunInfo(run);
    assert.equal(info.issueId, "DVA-38");
    assert.equal(info.issueTitle, "DVA-38: Upgrade Actions v5");
  });

  it("returns 'unknown' when no issue ID found", () => {
    const run = { name: "Agent Worker", display_title: "Some random run" };
    const info = extractRunInfo(run);
    assert.equal(info.issueId, "unknown");
  });

  it("handles missing fields gracefully", () => {
    const run = {};
    const info = extractRunInfo(run);
    assert.equal(info.issueId, "unknown");
    assert.equal(info.issueTitle, "");
  });
});

// ---------------------------------------------------------------------------
// formatDuration
// ---------------------------------------------------------------------------

describe("formatDuration", () => {
  it("formats elapsed time correctly", () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const result = formatDuration(fiveMinAgo);
    assert.match(result, /^5m \d+s$/);
  });

  it("returns 0m 0s for null input", () => {
    assert.equal(formatDuration(null), "0m 0s");
  });

  it("returns 0m 0s for invalid date", () => {
    assert.equal(formatDuration("not-a-date"), "0m 0s");
  });
});

// ---------------------------------------------------------------------------
// formatCompletedDuration
// ---------------------------------------------------------------------------

describe("formatCompletedDuration", () => {
  it("computes duration between two timestamps", () => {
    const start = "2026-03-15T10:00:00Z";
    const end = "2026-03-15T10:06:30Z";
    assert.equal(formatCompletedDuration(start, end), "6m 30s");
  });

  it("returns ? for missing timestamps", () => {
    assert.equal(formatCompletedDuration(null, "2026-03-15T10:00:00Z"), "?");
    assert.equal(formatCompletedDuration("2026-03-15T10:00:00Z", null), "?");
  });
});

// ---------------------------------------------------------------------------
// countDailyRuns
// ---------------------------------------------------------------------------

describe("countDailyRuns", () => {
  it("counts only runs from last 24 hours", () => {
    const recent = new Date().toISOString();
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const runs = [{ created_at: recent }, { created_at: old }];
    assert.equal(countDailyRuns(runs), 1);
  });

  it("returns 0 for empty runs", () => {
    assert.equal(countDailyRuns([]), 0);
  });
});

// ---------------------------------------------------------------------------
// matchRunsToPRs
// ---------------------------------------------------------------------------

describe("matchRunsToPRs", () => {
  it("matches completed runs to PRs by issue ID in title", () => {
    const runs = [
      {
        id: 100,
        inputs: { issue_id: "DVA-38", issue_title: "Upgrade" },
      },
    ];
    const prs = [{ number: 18, title: "DVA-38: Upgrade Actions", headRefName: "feature/DVA-38" }];
    const map = matchRunsToPRs(runs, prs);
    assert.equal(map.size, 1);
    assert.equal(map.get(100).number, 18);
  });

  it("matches by branch name when title has no issue ID", () => {
    const runs = [
      { id: 200, inputs: { issue_id: "DVA-39", issue_title: "Branch" } },
    ];
    const prs = [{ number: 19, title: "Some PR", headRefName: "feature/DVA-39-branch" }];
    const map = matchRunsToPRs(runs, prs);
    assert.equal(map.get(200).number, 19);
  });

  it("skips runs with unknown issue ID", () => {
    const runs = [{ id: 300, name: "Agent Worker" }];
    const prs = [{ number: 20, title: "DVA-40: Something", headRefName: "main" }];
    const map = matchRunsToPRs(runs, prs);
    assert.equal(map.size, 0);
  });

  it("returns empty map when no PRs exist", () => {
    const runs = [{ id: 400, inputs: { issue_id: "DVA-41" } }];
    const map = matchRunsToPRs(runs, []);
    assert.equal(map.size, 0);
  });
});

// ---------------------------------------------------------------------------
// renderDashboard
// ---------------------------------------------------------------------------

describe("renderDashboard", () => {
  it("renders with active runs", () => {
    const output = renderDashboard({
      active: [
        {
          status: "in_progress",
          run_started_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
          inputs: { issue_id: "DVA-40", issue_title: "Filter archived" },
        },
      ],
      completed: [],
      dailyCount: 3,
      dailyLimit: 4,
      prMap: new Map(),
    });
    assert.ok(output.includes("AGENT DASHBOARD"));
    assert.ok(output.includes("DVA-40"));
    assert.ok(output.includes("Filter archived"));
    assert.ok(output.includes("RUNNING:"));
  });

  it("renders with completed runs and PR links", () => {
    const runId = 999;
    const output = renderDashboard({
      active: [],
      completed: [
        {
          id: runId,
          status: "completed",
          conclusion: "success",
          run_started_at: "2026-03-15T10:00:00Z",
          updated_at: "2026-03-15T10:06:00Z",
          inputs: { issue_id: "DVA-38", issue_title: "Upgrade v5" },
        },
      ],
      dailyCount: 1,
      dailyLimit: 4,
      prMap: new Map([[runId, { number: 18, title: "DVA-38: Upgrade" }]]),
    });
    assert.ok(output.includes("OK"));
    assert.ok(output.includes("DVA-38"));
    assert.ok(output.includes("PR #18"));
  });

  it("renders empty state", () => {
    const output = renderDashboard({
      active: [],
      completed: [],
      dailyCount: 0,
      dailyLimit: 4,
      prMap: new Map(),
    });
    assert.ok(output.includes("No agents currently running"));
    assert.ok(output.includes("No recent completions"));
  });

  it("shows FAIL status and no PR for failed runs", () => {
    const output = renderDashboard({
      active: [],
      completed: [
        {
          id: 500,
          status: "completed",
          conclusion: "failure",
          run_started_at: "2026-03-15T10:00:00Z",
          updated_at: "2026-03-15T10:02:48Z",
          inputs: { issue_id: "DVA-40", issue_title: "Filter archived" },
        },
      ],
      dailyCount: 2,
      dailyLimit: 4,
      prMap: new Map(),
    });
    assert.ok(output.includes("FAIL"));
    assert.ok(output.includes("no PR"));
  });

  it("includes footer with refresh instructions", () => {
    const output = renderDashboard({
      active: [],
      completed: [],
      dailyCount: 0,
      dailyLimit: 4,
      prMap: new Map(),
    });
    assert.ok(output.includes("q = quit"));
    assert.ok(output.includes("r = refresh now"));
  });
});
