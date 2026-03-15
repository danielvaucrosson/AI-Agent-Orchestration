import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  categorizeRuns,
  extractRunInfo,
  formatDuration,
  formatCompletedDuration,
  countDailyRuns,
  matchRunsToPRs,
  formatRelativeTime,
  buildDashboardData,
  renderDashboard,
  generateDashboardHTML,
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
// formatRelativeTime
// ---------------------------------------------------------------------------

describe("formatRelativeTime", () => {
  it("returns 'just now' for very recent timestamps", () => {
    const now = new Date().toISOString();
    assert.equal(formatRelativeTime(now), "just now");
  });

  it("returns minutes for timestamps within an hour", () => {
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    assert.equal(formatRelativeTime(tenMinAgo), "10 min ago");
  });

  it("returns hours for timestamps within a day", () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    assert.equal(formatRelativeTime(threeHoursAgo), "3h ago");
  });

  it("returns days for older timestamps", () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    assert.equal(formatRelativeTime(twoDaysAgo), "2d ago");
  });

  it("returns empty string for null input", () => {
    assert.equal(formatRelativeTime(null), "");
  });
});

// ---------------------------------------------------------------------------
// buildDashboardData
// ---------------------------------------------------------------------------

describe("buildDashboardData", () => {
  const now = new Date().toISOString();
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();

  it("builds gauges from raw runs", () => {
    const data = buildDashboardData({
      runs: [
        { id: 1, status: "in_progress", created_at: now, run_started_at: fiveMinAgo, inputs: { issue_id: "DVA-40", issue_title: "Test" } },
        { id: 2, status: "completed", conclusion: "success", created_at: now, run_started_at: fiveMinAgo, updated_at: now, inputs: { issue_id: "DVA-38", issue_title: "Upgrade" } },
        { id: 3, status: "completed", conclusion: "failure", created_at: now, run_started_at: fiveMinAgo, updated_at: now, inputs: { issue_id: "DVA-39", issue_title: "Branch" } },
      ],
      prs: [],
    });
    assert.equal(data.gauges.running, 1);
    assert.equal(data.gauges.succeeded, 1);
    assert.equal(data.gauges.failed, 1);
    assert.equal(data.gauges.dailyUsed, 3);
    assert.equal(data.gauges.dailyLimit, 4);
  });

  it("builds active agents list", () => {
    const data = buildDashboardData({
      runs: [
        {
          id: 1, status: "in_progress", created_at: now,
          run_started_at: fiveMinAgo, head_branch: "feature/DVA-40",
          runner_name: "self-hosted",
          inputs: { issue_id: "DVA-40", issue_title: "Filter archived" },
        },
      ],
      prs: [],
    });
    assert.equal(data.activeAgents.length, 1);
    assert.equal(data.activeAgents[0].issueId, "DVA-40");
    assert.equal(data.activeAgents[0].status, "In Progress");
    assert.equal(data.activeAgents[0].branch, "feature/DVA-40");
  });

  it("builds history with PR links", () => {
    const data = buildDashboardData({
      runs: [
        {
          id: 10, status: "completed", conclusion: "success",
          created_at: now, run_started_at: fiveMinAgo, updated_at: now,
          inputs: { issue_id: "DVA-38", issue_title: "Upgrade Actions" },
        },
      ],
      prs: [{ number: 18, title: "DVA-38: Upgrade", headRefName: "feature/DVA-38" }],
    });
    assert.equal(data.history.length, 1);
    assert.equal(data.history[0].success, true);
    assert.equal(data.history[0].prNumber, 18);
    assert.ok(data.history[0].prUrl.includes("/pull/18"));
  });

  it("handles empty input", () => {
    const data = buildDashboardData({ runs: [], prs: [] });
    assert.equal(data.gauges.running, 0);
    assert.equal(data.activeAgents.length, 0);
    assert.equal(data.history.length, 0);
  });
});

// ---------------------------------------------------------------------------
// renderDashboard
// ---------------------------------------------------------------------------

describe("renderDashboard", () => {
  it("renders with active runs", () => {
    const data = buildDashboardData({
      runs: [
        {
          id: 1, status: "in_progress",
          run_started_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
          created_at: new Date().toISOString(),
          inputs: { issue_id: "DVA-40", issue_title: "Filter archived" },
        },
      ],
      prs: [],
    });
    const output = renderDashboard(data);
    assert.ok(output.includes("AGENT DASHBOARD"));
    assert.ok(output.includes("DVA-40"));
    assert.ok(output.includes("Filter archived"));
    assert.ok(output.includes("RUNNING:"));
  });

  it("renders with completed runs and PR links", () => {
    const data = buildDashboardData({
      runs: [
        {
          id: 999, status: "completed", conclusion: "success",
          run_started_at: "2026-03-15T10:00:00Z",
          updated_at: "2026-03-15T10:06:00Z",
          created_at: new Date().toISOString(),
          inputs: { issue_id: "DVA-38", issue_title: "Upgrade v5" },
        },
      ],
      prs: [{ number: 18, title: "DVA-38: Upgrade", headRefName: "feature/DVA-38" }],
    });
    const output = renderDashboard(data);
    assert.ok(output.includes("OK"));
    assert.ok(output.includes("DVA-38"));
    assert.ok(output.includes("PR #18"));
  });

  it("renders empty state", () => {
    const data = buildDashboardData({ runs: [], prs: [] });
    const output = renderDashboard(data);
    assert.ok(output.includes("No agents currently running"));
    assert.ok(output.includes("No recent completions"));
  });

  it("shows FAIL status and no PR for failed runs", () => {
    const data = buildDashboardData({
      runs: [
        {
          id: 500, status: "completed", conclusion: "failure",
          run_started_at: "2026-03-15T10:00:00Z",
          updated_at: "2026-03-15T10:02:48Z",
          created_at: new Date().toISOString(),
          inputs: { issue_id: "DVA-40", issue_title: "Filter archived" },
        },
      ],
      prs: [],
    });
    const output = renderDashboard(data);
    assert.ok(output.includes("FAIL"));
    assert.ok(output.includes("no PR"));
  });

  it("includes footer with refresh instructions", () => {
    const data = buildDashboardData({ runs: [], prs: [] });
    const output = renderDashboard(data);
    assert.ok(output.includes("q = quit"));
    assert.ok(output.includes("r = refresh now"));
  });

  it("shows web URL when provided", () => {
    const data = buildDashboardData({ runs: [], prs: [] });
    const output = renderDashboard(data, { webUrl: "http://localhost:3847" });
    assert.ok(output.includes("http://localhost:3847"));
  });
});

// ---------------------------------------------------------------------------
// generateDashboardHTML
// ---------------------------------------------------------------------------

describe("generateDashboardHTML", () => {
  it("returns a complete HTML document", () => {
    const html = generateDashboardHTML();
    assert.ok(html.startsWith("<!DOCTYPE html>"));
    assert.ok(html.includes("Agent Control Center"));
    assert.ok(html.includes("/api/status"));
  });

  it("includes GitHub-dark theme colors", () => {
    const html = generateDashboardHTML();
    assert.ok(html.includes("#0d1117"));
    assert.ok(html.includes("#161b22"));
    assert.ok(html.includes("#30363d"));
    assert.ok(html.includes("#58a6ff"));
    assert.ok(html.includes("#3fb950"));
    assert.ok(html.includes("#f85149"));
    assert.ok(html.includes("#d29922"));
  });

  it("includes auto-refresh JavaScript", () => {
    const html = generateDashboardHTML();
    assert.ok(html.includes("setInterval(refresh, 10000)"));
  });

  it("includes gauge, agent, and history rendering", () => {
    const html = generateDashboardHTML();
    assert.ok(html.includes("renderGauges"));
    assert.ok(html.includes("renderAgents"));
    assert.ok(html.includes("renderHistory"));
  });
});
