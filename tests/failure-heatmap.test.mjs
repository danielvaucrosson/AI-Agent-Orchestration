/**
 * Failure Heatmap Tests (DVA-56)
 *
 * Verifies buildFailureHeatmapData aggregation, dashboard data integration,
 * CLI rendering, and HTML rendering for the failure heatmap panel.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildFailureHeatmapData,
  buildDashboardData,
  renderDashboard,
  generateDashboardHTML,
} from "../scripts/agent-dashboard.mjs";

import { generateStaticHTML } from "../scripts/generate-dashboard.mjs";

// ---------------------------------------------------------------------------
// buildFailureHeatmapData
// ---------------------------------------------------------------------------

describe("buildFailureHeatmapData", () => {
  it("returns empty grids for no data", () => {
    const result = buildFailureHeatmapData([], []);
    assert.equal(result.maxFailures, 0);
    assert.equal(result.maxRetries, 0);
    assert.equal(result.failures.length, 7);
    assert.equal(result.retries.length, 7);
    for (let d = 0; d < 7; d++) {
      assert.equal(result.failures[d].length, 24);
      assert.equal(result.retries[d].length, 24);
      for (let h = 0; h < 24; h++) {
        assert.equal(result.failures[d][h].count, 0);
        assert.equal(result.retries[d][h].count, 0);
      }
    }
  });

  it("returns day name labels", () => {
    const result = buildFailureHeatmapData([], []);
    assert.deepEqual(result.dayNames, ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]);
  });

  it("aggregates workflow failures by UTC day and hour", () => {
    // 2026-03-16 is a Monday, 14:30 UTC → day=1, hour=14
    const runs = [
      {
        id: 1,
        status: "completed",
        conclusion: "failure",
        created_at: "2026-03-16T14:30:00Z",
        updated_at: "2026-03-16T14:45:00Z",
        display_title: "DVA-10 Test task",
      },
      {
        id: 2,
        status: "completed",
        conclusion: "failure",
        created_at: "2026-03-16T14:10:00Z",
        updated_at: "2026-03-16T14:20:00Z",
        display_title: "DVA-11 Another task",
      },
    ];
    const result = buildFailureHeatmapData(runs, []);
    assert.equal(result.failures[1][14].count, 2);
    assert.equal(result.failures[1][14].tasks.length, 2);
    assert.equal(result.failures[1][14].tasks[0].issueId, "DVA-10");
    assert.equal(result.maxFailures, 2);
  });

  it("ignores successful and in-progress runs", () => {
    const runs = [
      { id: 1, status: "completed", conclusion: "success", updated_at: "2026-03-16T10:00:00Z" },
      { id: 2, status: "in_progress", created_at: "2026-03-16T10:00:00Z" },
      { id: 3, status: "queued", created_at: "2026-03-16T10:00:00Z" },
    ];
    const result = buildFailureHeatmapData(runs, []);
    assert.equal(result.maxFailures, 0);
  });

  it("aggregates recovery events as retries", () => {
    // 2026-03-18 is a Wednesday, 03:00 UTC → day=3, hour=3
    const events = [
      { level: 1, timestamp: "2026-03-18T03:15:00Z", issueId: "DVA-20", issueTitle: "Retry test" },
      { level: 2, timestamp: "2026-03-18T03:45:00Z", issueId: "DVA-21", issueTitle: "Kill retry" },
    ];
    const result = buildFailureHeatmapData([], events);
    assert.equal(result.retries[3][3].count, 2);
    assert.equal(result.retries[3][3].tasks[0].issueId, "DVA-20");
    assert.equal(result.maxRetries, 2);
  });

  it("excludes Level 3 events from retries (those are escalations, not retries)", () => {
    const events = [
      { level: 3, timestamp: "2026-03-18T10:00:00Z", issueId: "DVA-30" },
    ];
    const result = buildFailureHeatmapData([], events);
    assert.equal(result.maxRetries, 0);
    // Level 3 should not appear in retries grid
    assert.equal(result.retries[3][10].count, 0);
  });

  it("handles null/undefined inputs gracefully", () => {
    const result = buildFailureHeatmapData(null, null);
    assert.equal(result.maxFailures, 0);
    assert.equal(result.maxRetries, 0);
  });

  it("handles events with missing timestamps", () => {
    const events = [
      { level: 1, issueId: "DVA-40" }, // no timestamp
      { level: 2, timestamp: "", issueId: "DVA-41" }, // empty timestamp
    ];
    const result = buildFailureHeatmapData([], events);
    assert.equal(result.maxRetries, 0);
  });

  it("populates both grids when failures and retries overlap", () => {
    // Same day/hour cell should have both failure and retry data
    const runs = [
      {
        id: 1, status: "completed", conclusion: "failure",
        updated_at: "2026-03-16T10:30:00Z",
        display_title: "DVA-50 failed",
      },
    ];
    const events = [
      { level: 1, timestamp: "2026-03-16T10:45:00Z", issueId: "DVA-50", issueTitle: "retried" },
    ];
    const result = buildFailureHeatmapData(runs, events);
    assert.equal(result.failures[1][10].count, 1);
    assert.equal(result.retries[1][10].count, 1);
  });
});

// ---------------------------------------------------------------------------
// Integration: buildDashboardData includes heatmap
// ---------------------------------------------------------------------------

describe("buildDashboardData includes heatmap", () => {
  it("includes heatmap field in dashboard data", () => {
    const data = buildDashboardData({ runs: [], prs: [], recoveryEvents: [] });
    assert.ok(data.heatmap);
    assert.equal(data.heatmap.failures.length, 7);
    assert.equal(data.heatmap.retries.length, 7);
  });

  it("populates heatmap from failed runs", () => {
    const runs = [
      {
        id: 1, status: "completed", conclusion: "failure",
        created_at: "2026-03-16T08:00:00Z",
        updated_at: "2026-03-16T08:30:00Z",
        display_title: "DVA-60 heatmap test",
      },
    ];
    const data = buildDashboardData({ runs, prs: [], recoveryEvents: [] });
    assert.equal(data.heatmap.maxFailures, 1);
  });
});

// ---------------------------------------------------------------------------
// CLI rendering: renderDashboard includes heatmap
// ---------------------------------------------------------------------------

describe("renderDashboard heatmap section", () => {
  it("renders heatmap section when there are failures", () => {
    const data = buildDashboardData({
      runs: [
        {
          id: 1, status: "completed", conclusion: "failure",
          created_at: "2026-03-16T08:00:00Z",
          updated_at: "2026-03-16T08:30:00Z",
          display_title: "DVA-70 test",
        },
      ],
      prs: [],
      recoveryEvents: [],
    });
    const output = renderDashboard(data);
    assert.ok(output.includes("FAILURE HEATMAP"), "should include FAILURE HEATMAP header");
    assert.ok(output.includes("Mon"), "should include day labels");
  });

  it("omits heatmap when no failures or retries exist", () => {
    const data = buildDashboardData({ runs: [], prs: [], recoveryEvents: [] });
    const output = renderDashboard(data);
    assert.ok(!output.includes("FAILURE HEATMAP"), "should not include FAILURE HEATMAP when empty");
  });
});

// ---------------------------------------------------------------------------
// Web HTML rendering: generateDashboardHTML includes heatmap
// ---------------------------------------------------------------------------

describe("generateDashboardHTML includes heatmap", () => {
  it("includes heatmap panel container", () => {
    const html = generateDashboardHTML();
    assert.ok(html.includes('id="heatmap-panel"'), "should have heatmap-panel div");
  });

  it("includes heatmap CSS", () => {
    const html = generateDashboardHTML();
    assert.ok(html.includes(".heatmap-cell"), "should have heatmap cell CSS");
    assert.ok(html.includes(".heatmap-tooltip"), "should have tooltip CSS");
  });

  it("includes renderHeatmap function", () => {
    const html = generateDashboardHTML();
    assert.ok(html.includes("renderHeatmap"), "should have renderHeatmap function");
  });

  it("includes heatmap mode toggle function", () => {
    const html = generateDashboardHTML();
    assert.ok(html.includes("setHeatmapMode"), "should have setHeatmapMode function");
  });
});

// ---------------------------------------------------------------------------
// Static HTML rendering: generateStaticHTML includes heatmap
// ---------------------------------------------------------------------------

describe("generateStaticHTML includes heatmap", () => {
  it("includes heatmap panel and rendering in static HTML", () => {
    const data = {
      gauges: { running: 0, succeeded: 0, failed: 0, totalSucceeded: 0, totalFailed: 0, dailyUsed: 0, dailyLimit: 2 },
      activeAgents: [],
      history: [],
      recoveryLevels: { levels: { 1: { today: 0, allTime: 0, events: [] }, 2: { today: 0, allTime: 0, events: [] }, 3: { today: 0, allTime: 0, events: [] } }, hasLevel3Today: false },
      runnerHealth: null,
      gantt: { bars: [], minTime: 0, maxTime: 0 },
      heatmap: { failures: Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ({ count: 0, tasks: [] }))), retries: Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ({ count: 0, tasks: [] }))), maxFailures: 0, maxRetries: 0, dayNames: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] },
      buildTime: new Date().toISOString(),
    };
    const html = generateStaticHTML(data);
    assert.ok(html.includes('id="heatmap-panel"'), "should have heatmap-panel div");
    assert.ok(html.includes("renderHeatmap"), "should have renderHeatmap function");
    assert.ok(html.includes("setHeatmapMode"), "should have setHeatmapMode function");
    assert.ok(html.includes(".heatmap-cell"), "should have heatmap CSS");
  });
});
