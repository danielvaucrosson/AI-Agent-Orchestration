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
  computeRunnerStatus,
  computeQuotaTrend,
  computeAvgDuration,
  computeSuccessRate,
  computeDaysSinceIncident,
  buildRunnerHealth,
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
    assert.equal(data.gauges.totalSucceeded, 1);
    assert.equal(data.gauges.totalFailed, 1);
    assert.equal(data.gauges.dailyUsed, 3);
    assert.equal(data.gauges.dailyLimit, 2);
  });

  it("counts historical runs older than 24h in totals but not in today", () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const data = buildDashboardData({
      runs: [
        { id: 1, status: "completed", conclusion: "success", created_at: twoDaysAgo, run_started_at: twoDaysAgo, updated_at: twoDaysAgo, inputs: { issue_id: "DVA-10", issue_title: "Old success" } },
        { id: 2, status: "completed", conclusion: "failure", created_at: twoDaysAgo, run_started_at: twoDaysAgo, updated_at: twoDaysAgo, inputs: { issue_id: "DVA-11", issue_title: "Old failure" } },
        { id: 3, status: "completed", conclusion: "success", created_at: now, run_started_at: fiveMinAgo, updated_at: now, inputs: { issue_id: "DVA-12", issue_title: "Recent success" } },
      ],
      prs: [],
    });
    assert.equal(data.gauges.succeeded, 1, "only today's successes");
    assert.equal(data.gauges.failed, 0, "only today's failures");
    assert.equal(data.gauges.totalSucceeded, 2, "all-time successes");
    assert.equal(data.gauges.totalFailed, 1, "all-time failures");
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

  it("includes durationMs in history entries", () => {
    const start = "2026-03-15T10:00:00Z";
    const end = "2026-03-15T10:05:30Z"; // 5m 30s = 330000ms
    const data = buildDashboardData({
      runs: [
        {
          id: 20, status: "completed", conclusion: "success",
          created_at: start, run_started_at: start, updated_at: end,
          inputs: { issue_id: "DVA-99", issue_title: "Test" },
        },
      ],
      prs: [],
    });
    assert.equal(data.history[0].durationMs, 330_000);
    assert.equal(data.history[0].duration, "5m 30s");
  });

  it("sets durationMs to 0 for missing timestamps", () => {
    const data = buildDashboardData({
      runs: [
        {
          id: 21, status: "completed", conclusion: "failure",
          created_at: null, run_started_at: null, updated_at: null,
        },
      ],
      prs: [],
    });
    assert.equal(data.history[0].durationMs, 0);
  });

  it("uses AGENT_MAX_DAILY_RUNS env var for dailyLimit", () => {
    const orig = process.env.AGENT_MAX_DAILY_RUNS;
    try {
      process.env.AGENT_MAX_DAILY_RUNS = "6";
      const data = buildDashboardData({ runs: [], prs: [] });
      assert.equal(data.gauges.dailyLimit, 6);
    } finally {
      if (orig === undefined) delete process.env.AGENT_MAX_DAILY_RUNS;
      else process.env.AGENT_MAX_DAILY_RUNS = orig;
    }
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

  it("includes duration bar CSS and rendering", () => {
    const html = generateDashboardHTML();
    assert.ok(html.includes("duration-bar"), "HTML should include duration-bar class");
    assert.ok(html.includes("duration-text"), "HTML should include duration-text class");
    assert.ok(html.includes("durationMs"), "renderHistory should reference durationMs");
  });

  it("includes runner health panel CSS and rendering", () => {
    const html = generateDashboardHTML();
    assert.ok(html.includes("runner-health"), "HTML should include runner-health container");
    assert.ok(html.includes("health-card"), "HTML should include health-card class");
    assert.ok(html.includes("renderRunnerHealth"), "HTML should include renderRunnerHealth function");
  });
});

// ---------------------------------------------------------------------------
// computeRunnerStatus
// ---------------------------------------------------------------------------

describe("computeRunnerStatus", () => {
  it("returns online when runners are available and not busy", () => {
    const result = computeRunnerStatus({
      runners: [{ status: "online", busy: false, os: "Linux" }],
    });
    assert.equal(result.status, "online");
    assert.ok(result.lastSeen);
  });

  it("returns busy when all online runners are busy", () => {
    const result = computeRunnerStatus({
      runners: [
        { status: "online", busy: true, os: "Linux" },
        { status: "online", busy: true, os: "Linux" },
      ],
    });
    assert.equal(result.status, "busy");
  });

  it("returns offline when no runners are online", () => {
    const result = computeRunnerStatus({
      runners: [{ status: "offline", busy: false, os: "Linux" }],
    });
    assert.equal(result.status, "offline");
  });

  it("returns unknown when no runners exist", () => {
    const result = computeRunnerStatus({ runners: [] });
    assert.equal(result.status, "unknown");
    assert.equal(result.lastSeen, null);
  });

  it("handles null/undefined input", () => {
    assert.equal(computeRunnerStatus(null).status, "unknown");
    assert.equal(computeRunnerStatus(undefined).status, "unknown");
  });

  it("returns online when some runners are busy but not all", () => {
    const result = computeRunnerStatus({
      runners: [
        { status: "online", busy: true, os: "Linux" },
        { status: "online", busy: false, os: "Linux" },
      ],
    });
    assert.equal(result.status, "online");
  });
});

// ---------------------------------------------------------------------------
// computeQuotaTrend
// ---------------------------------------------------------------------------

describe("computeQuotaTrend", () => {
  const NOW = Date.now();

  it("counts today and yesterday runs separately", () => {
    const runs = [
      { created_at: new Date(NOW - 1 * 60 * 60 * 1000).toISOString() },  // 1h ago (today)
      { created_at: new Date(NOW - 2 * 60 * 60 * 1000).toISOString() },  // 2h ago (today)
      { created_at: new Date(NOW - 30 * 60 * 60 * 1000).toISOString() }, // 30h ago (yesterday)
    ];
    const result = computeQuotaTrend(runs, NOW);
    assert.equal(result.today, 2);
    assert.equal(result.yesterday, 1);
    assert.equal(result.trend, "up");
  });

  it("returns flat when today equals yesterday", () => {
    const runs = [
      { created_at: new Date(NOW - 1 * 60 * 60 * 1000).toISOString() },
      { created_at: new Date(NOW - 30 * 60 * 60 * 1000).toISOString() },
    ];
    const result = computeQuotaTrend(runs, NOW);
    assert.equal(result.trend, "flat");
  });

  it("returns down when yesterday had more runs", () => {
    const runs = [
      { created_at: new Date(NOW - 30 * 60 * 60 * 1000).toISOString() },
      { created_at: new Date(NOW - 35 * 60 * 60 * 1000).toISOString() },
    ];
    const result = computeQuotaTrend(runs, NOW);
    assert.equal(result.today, 0);
    assert.equal(result.yesterday, 2);
    assert.equal(result.trend, "down");
  });

  it("handles empty runs", () => {
    const result = computeQuotaTrend([], NOW);
    assert.equal(result.today, 0);
    assert.equal(result.yesterday, 0);
    assert.equal(result.trend, "flat");
  });
});

// ---------------------------------------------------------------------------
// computeAvgDuration
// ---------------------------------------------------------------------------

describe("computeAvgDuration", () => {
  const NOW = Date.now();

  it("computes average from completed runs in window", () => {
    const runs = [
      {
        created_at: new Date(NOW - 1 * 60 * 60 * 1000).toISOString(),
        run_started_at: new Date(NOW - 1 * 60 * 60 * 1000).toISOString(),
        updated_at: new Date(NOW - 1 * 60 * 60 * 1000 + 600_000).toISOString(), // 10m
      },
      {
        created_at: new Date(NOW - 2 * 60 * 60 * 1000).toISOString(),
        run_started_at: new Date(NOW - 2 * 60 * 60 * 1000).toISOString(),
        updated_at: new Date(NOW - 2 * 60 * 60 * 1000 + 300_000).toISOString(), // 5m
      },
    ];
    const result = computeAvgDuration(runs, 7, NOW);
    assert.equal(result.avgMs, 450_000); // avg of 600000 and 300000
    assert.equal(result.avgFormatted, "7m 30s");
    assert.equal(result.sampleSize, 2);
  });

  it("excludes runs outside the window", () => {
    const runs = [
      {
        created_at: new Date(NOW - 10 * 24 * 60 * 60 * 1000).toISOString(), // 10 days ago
        run_started_at: new Date(NOW - 10 * 24 * 60 * 60 * 1000).toISOString(),
        updated_at: new Date(NOW - 10 * 24 * 60 * 60 * 1000 + 600_000).toISOString(),
      },
    ];
    const result = computeAvgDuration(runs, 7, NOW);
    assert.equal(result.avgMs, 0);
    assert.equal(result.avgFormatted, "\u2014");
    assert.equal(result.sampleSize, 0);
  });

  it("handles empty input", () => {
    const result = computeAvgDuration([], 7, NOW);
    assert.equal(result.sampleSize, 0);
    assert.equal(result.avgFormatted, "\u2014");
  });

  it("skips runs with missing timestamps", () => {
    const runs = [
      { created_at: new Date(NOW - 1000).toISOString(), run_started_at: null, updated_at: null },
    ];
    const result = computeAvgDuration(runs, 7, NOW);
    assert.equal(result.sampleSize, 0);
  });
});

// ---------------------------------------------------------------------------
// computeSuccessRate
// ---------------------------------------------------------------------------

describe("computeSuccessRate", () => {
  const NOW = Date.now();

  it("computes success rate from current 7-day window", () => {
    const runs = [
      { created_at: new Date(NOW - 1000).toISOString(), conclusion: "success" },
      { created_at: new Date(NOW - 2000).toISOString(), conclusion: "success" },
      { created_at: new Date(NOW - 3000).toISOString(), conclusion: "failure" },
    ];
    const result = computeSuccessRate(runs, 7, NOW);
    assert.equal(result.rate, 67); // 2/3 = 66.67 -> 67%
    assert.equal(result.currentWindow.succeeded, 2);
    assert.equal(result.currentWindow.total, 3);
  });

  it("computes trend up when current rate is higher", () => {
    const runs = [
      // Current window: 100% success
      { created_at: new Date(NOW - 1000).toISOString(), conclusion: "success" },
      // Previous window: 50% success
      { created_at: new Date(NOW - 8 * 24 * 60 * 60 * 1000).toISOString(), conclusion: "success" },
      { created_at: new Date(NOW - 9 * 24 * 60 * 60 * 1000).toISOString(), conclusion: "failure" },
    ];
    const result = computeSuccessRate(runs, 7, NOW);
    assert.equal(result.trend, "up");
    assert.equal(result.rate, 100);
  });

  it("computes trend down when current rate is lower", () => {
    const runs = [
      // Current window: 0% success
      { created_at: new Date(NOW - 1000).toISOString(), conclusion: "failure" },
      // Previous window: 100% success
      { created_at: new Date(NOW - 8 * 24 * 60 * 60 * 1000).toISOString(), conclusion: "success" },
    ];
    const result = computeSuccessRate(runs, 7, NOW);
    assert.equal(result.trend, "down");
    assert.equal(result.rate, 0);
  });

  it("returns flat when both windows are empty", () => {
    const result = computeSuccessRate([], 7, NOW);
    assert.equal(result.rate, 0);
    assert.equal(result.trend, "flat");
  });

  it("returns 0% rate when no runs in current window", () => {
    const runs = [
      { created_at: new Date(NOW - 8 * 24 * 60 * 60 * 1000).toISOString(), conclusion: "success" },
    ];
    const result = computeSuccessRate(runs, 7, NOW);
    assert.equal(result.rate, 0);
    assert.equal(result.currentWindow.total, 0);
  });
});

// ---------------------------------------------------------------------------
// computeDaysSinceIncident
// ---------------------------------------------------------------------------

describe("computeDaysSinceIncident", () => {
  const NOW = Date.now();

  it("returns null when no Level 3 events exist", () => {
    const result = computeDaysSinceIncident([], NOW);
    assert.equal(result.days, null);
    assert.equal(result.lastIncidentDate, null);
  });

  it("returns 0 days for a Level 3 event today", () => {
    const events = [
      { level: 3, timestamp: new Date(NOW - 1000).toISOString() },
    ];
    const result = computeDaysSinceIncident(events, NOW);
    assert.equal(result.days, 0);
    assert.ok(result.lastIncidentDate);
  });

  it("counts days since most recent Level 3 event", () => {
    const threeDaysAgo = new Date(NOW - 3 * 24 * 60 * 60 * 1000).toISOString();
    const fiveDaysAgo = new Date(NOW - 5 * 24 * 60 * 60 * 1000).toISOString();
    const events = [
      { level: 3, timestamp: fiveDaysAgo },
      { level: 3, timestamp: threeDaysAgo },
    ];
    const result = computeDaysSinceIncident(events, NOW);
    assert.equal(result.days, 3);
    assert.equal(result.lastIncidentDate, threeDaysAgo);
  });

  it("ignores Level 1 and Level 2 events", () => {
    const events = [
      { level: 1, timestamp: new Date(NOW - 1000).toISOString() },
      { level: 2, timestamp: new Date(NOW - 2000).toISOString() },
    ];
    const result = computeDaysSinceIncident(events, NOW);
    assert.equal(result.days, null);
  });

  it("handles null input", () => {
    const result = computeDaysSinceIncident(null, NOW);
    assert.equal(result.days, null);
  });
});

// ---------------------------------------------------------------------------
// buildRunnerHealth
// ---------------------------------------------------------------------------

describe("buildRunnerHealth", () => {
  const NOW = Date.now();

  it("assembles all health metrics", () => {
    const runs = [
      { created_at: new Date(NOW - 1000).toISOString() },
    ];
    const completedRuns = [
      {
        created_at: new Date(NOW - 1000).toISOString(),
        run_started_at: new Date(NOW - 1000).toISOString(),
        updated_at: new Date(NOW + 599_000).toISOString(),
        conclusion: "success",
      },
    ];
    const result = buildRunnerHealth({
      runs,
      completedRuns,
      recoveryEvents: [],
      runnerData: { runners: [{ status: "online", busy: false, os: "Linux" }] },
      nowMs: NOW,
    });

    assert.equal(result.runner.status, "online");
    assert.equal(result.quotaTrend.today, 1);
    assert.equal(result.avgDuration.sampleSize, 1);
    assert.equal(result.successRate.rate, 100);
    assert.equal(result.daysSinceIncident.days, null);
  });

  it("handles empty inputs", () => {
    const result = buildRunnerHealth({
      runs: [],
      completedRuns: [],
      recoveryEvents: [],
      nowMs: NOW,
    });
    assert.equal(result.runner.status, "unknown");
    assert.equal(result.quotaTrend.today, 0);
    assert.equal(result.avgDuration.sampleSize, 0);
    assert.equal(result.successRate.rate, 0);
    assert.equal(result.daysSinceIncident.days, null);
  });
});

// ---------------------------------------------------------------------------
// buildDashboardData — runnerHealth integration
// ---------------------------------------------------------------------------

describe("buildDashboardData runnerHealth", () => {
  it("includes runnerHealth in output", () => {
    const data = buildDashboardData({
      runs: [],
      prs: [],
      recoveryEvents: [],
      runnerData: { runners: [{ status: "online", busy: false, os: "Linux" }] },
    });
    assert.ok(data.runnerHealth);
    assert.equal(data.runnerHealth.runner.status, "online");
  });

  it("defaults to unknown runner when no runnerData provided", () => {
    const data = buildDashboardData({ runs: [], prs: [] });
    assert.ok(data.runnerHealth);
    assert.equal(data.runnerHealth.runner.status, "unknown");
  });
});

// ---------------------------------------------------------------------------
// renderDashboard — runner health rendering
// ---------------------------------------------------------------------------

describe("renderDashboard runner health", () => {
  it("renders runner health section", () => {
    const data = buildDashboardData({
      runs: [],
      prs: [],
      recoveryEvents: [],
      runnerData: { runners: [{ status: "online", busy: false, os: "Linux" }] },
    });
    const output = renderDashboard(data);
    assert.ok(output.includes("RUNNER HEALTH"));
    assert.ok(output.includes("ONLINE"));
    assert.ok(output.includes("Avg duration"));
    assert.ok(output.includes("Success rate"));
    assert.ok(output.includes("Since incident"));
  });

  it("shows correct runner status colors", () => {
    // Offline runner
    const data = buildDashboardData({
      runs: [],
      prs: [],
      runnerData: { runners: [{ status: "offline", busy: false, os: "Linux" }] },
    });
    const output = renderDashboard(data);
    assert.ok(output.includes("OFFLINE"));
  });

  it("hides runner status and shows unavailable note when unknown", () => {
    const data = buildDashboardData({
      runs: [],
      prs: [],
      runnerData: { runners: [] },
    });
    const output = renderDashboard(data);
    assert.ok(output.includes("RUNNER HEALTH"), "should still show health section");
    assert.ok(!output.includes("UNKNOWN"), "should not show UNKNOWN status");
    assert.ok(output.includes("unavailable"), "should show unavailable note");
    assert.ok(output.includes("needs admin token scope"), "should mention token scope");
  });

  it("hides runner card in HTML when unknown", () => {
    const data = buildDashboardData({
      runs: [],
      prs: [],
      runnerData: { runners: [] },
    });
    const html = generateDashboardHTML(data);
    assert.ok(!html.includes(">UNKNOWN<"), "should not show UNKNOWN in HTML");
    assert.ok(html.includes(">N/A<"), "should show N/A for runner card");
    assert.ok(html.includes("needs admin token"), "should mention admin token");
  });
});
