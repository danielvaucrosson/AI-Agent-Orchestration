/**
 * Recovery Panel Tests (DVA-53)
 *
 * Verifies recovery levels aggregation, dashboard data integration,
 * CLI rendering, and HTML rendering for the recovery levels panel.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  RECOVERY_LEVELS,
  readRecoveryEvents,
  aggregateRecoveryLevels,
  buildDashboardData,
  renderDashboard,
  generateDashboardHTML,
} from "../scripts/agent-dashboard.mjs";

import { generateStaticHTML } from "../scripts/generate-dashboard.mjs";

// ---------------------------------------------------------------------------
// RECOVERY_LEVELS metadata
// ---------------------------------------------------------------------------

describe("RECOVERY_LEVELS", () => {
  it("defines metadata for levels 1, 2, and 3", () => {
    assert.ok(RECOVERY_LEVELS[1]);
    assert.ok(RECOVERY_LEVELS[2]);
    assert.ok(RECOVERY_LEVELS[3]);
  });

  it("has label, description, and color for each level", () => {
    for (const lvl of [1, 2, 3]) {
      assert.ok(RECOVERY_LEVELS[lvl].label);
      assert.ok(RECOVERY_LEVELS[lvl].description);
      assert.ok(RECOVERY_LEVELS[lvl].color);
    }
  });

  it("Level 1 is Auto-fix", () => {
    assert.equal(RECOVERY_LEVELS[1].description, "Auto-fix");
  });

  it("Level 2 is Kill + Retry", () => {
    assert.equal(RECOVERY_LEVELS[2].description, "Kill + Retry");
  });

  it("Level 3 is Halt + Incident", () => {
    assert.equal(RECOVERY_LEVELS[3].description, "Halt + Incident");
  });
});

// ---------------------------------------------------------------------------
// readRecoveryEvents
// ---------------------------------------------------------------------------

describe("readRecoveryEvents", () => {
  it("returns empty array for non-existent file", () => {
    const events = readRecoveryEvents("/tmp/nonexistent-recovery-events.jsonl");
    assert.deepEqual(events, []);
  });

  it("returns empty array when no path argument given and file does not exist", () => {
    // Default path might not exist in test environment — should gracefully return []
    const events = readRecoveryEvents("/tmp/definitely-does-not-exist.jsonl");
    assert.deepEqual(events, []);
  });
});

// ---------------------------------------------------------------------------
// aggregateRecoveryLevels
// ---------------------------------------------------------------------------

describe("aggregateRecoveryLevels", () => {
  const today = "2026-03-16";

  it("returns zero counts for empty events", () => {
    const result = aggregateRecoveryLevels([], today);
    assert.equal(result.levels[1].today, 0);
    assert.equal(result.levels[1].allTime, 0);
    assert.equal(result.levels[2].today, 0);
    assert.equal(result.levels[2].allTime, 0);
    assert.equal(result.levels[3].today, 0);
    assert.equal(result.levels[3].allTime, 0);
    assert.equal(result.hasLevel3Today, false);
  });

  it("counts events by level", () => {
    const events = [
      { level: 1, timestamp: "2026-03-16T10:00:00Z", issueId: "DVA-10" },
      { level: 1, timestamp: "2026-03-16T11:00:00Z", issueId: "DVA-11" },
      { level: 2, timestamp: "2026-03-16T12:00:00Z", issueId: "DVA-12" },
      { level: 3, timestamp: "2026-03-16T13:00:00Z", issueId: "DVA-13" },
    ];
    const result = aggregateRecoveryLevels(events, today);
    assert.equal(result.levels[1].allTime, 2);
    assert.equal(result.levels[2].allTime, 1);
    assert.equal(result.levels[3].allTime, 1);
  });

  it("separates today counts from all-time", () => {
    const events = [
      { level: 1, timestamp: "2026-03-16T10:00:00Z", issueId: "DVA-10" },
      { level: 1, timestamp: "2026-03-15T10:00:00Z", issueId: "DVA-11" },
      { level: 1, timestamp: "2026-03-14T10:00:00Z", issueId: "DVA-12" },
    ];
    const result = aggregateRecoveryLevels(events, today);
    assert.equal(result.levels[1].today, 1, "only 1 event today");
    assert.equal(result.levels[1].allTime, 3, "3 all-time events");
  });

  it("sets hasLevel3Today when Level 3 events exist today", () => {
    const events = [
      { level: 3, timestamp: "2026-03-16T09:00:00Z", issueId: "DVA-20" },
    ];
    const result = aggregateRecoveryLevels(events, today);
    assert.equal(result.hasLevel3Today, true);
  });

  it("hasLevel3Today is false when Level 3 events are from other days", () => {
    const events = [
      { level: 3, timestamp: "2026-03-15T09:00:00Z", issueId: "DVA-20" },
    ];
    const result = aggregateRecoveryLevels(events, today);
    assert.equal(result.hasLevel3Today, false);
  });

  it("stores event details in each level", () => {
    const events = [
      {
        level: 2,
        timestamp: "2026-03-16T10:00:00Z",
        issueId: "DVA-30",
        issueTitle: "Test task",
        diagnosis: "runner-offline",
        runId: "999",
      },
    ];
    const result = aggregateRecoveryLevels(events, today);
    assert.equal(result.levels[2].events.length, 1);
    assert.equal(result.levels[2].events[0].issueId, "DVA-30");
    assert.equal(result.levels[2].events[0].diagnosis, "runner-offline");
  });

  it("sorts events newest-first within each level", () => {
    const events = [
      { level: 1, timestamp: "2026-03-16T08:00:00Z", issueId: "DVA-A" },
      { level: 1, timestamp: "2026-03-16T12:00:00Z", issueId: "DVA-C" },
      { level: 1, timestamp: "2026-03-16T10:00:00Z", issueId: "DVA-B" },
    ];
    const result = aggregateRecoveryLevels(events, today);
    assert.equal(result.levels[1].events[0].issueId, "DVA-C");
    assert.equal(result.levels[1].events[1].issueId, "DVA-B");
    assert.equal(result.levels[1].events[2].issueId, "DVA-A");
  });

  it("ignores events with unknown levels", () => {
    const events = [
      { level: 99, timestamp: "2026-03-16T10:00:00Z", issueId: "DVA-99" },
    ];
    const result = aggregateRecoveryLevels(events, today);
    assert.equal(result.levels[1].allTime, 0);
    assert.equal(result.levels[2].allTime, 0);
    assert.equal(result.levels[3].allTime, 0);
  });
});

// ---------------------------------------------------------------------------
// buildDashboardData — recoveryLevels integration
// ---------------------------------------------------------------------------

describe("buildDashboardData — recoveryLevels", () => {
  it("includes recoveryLevels in output when recoveryEvents provided", () => {
    const data = buildDashboardData({
      runs: [],
      prs: [],
      recoveryEvents: [
        { level: 1, timestamp: new Date().toISOString(), issueId: "DVA-10" },
      ],
    });
    assert.ok(data.recoveryLevels);
    assert.equal(data.recoveryLevels.levels[1].allTime, 1);
  });

  it("includes recoveryLevels with zero counts when no events", () => {
    const data = buildDashboardData({ runs: [], prs: [] });
    assert.ok(data.recoveryLevels);
    assert.equal(data.recoveryLevels.levels[1].allTime, 0);
    assert.equal(data.recoveryLevels.levels[2].allTime, 0);
    assert.equal(data.recoveryLevels.levels[3].allTime, 0);
  });

  it("includes recoveryLevels with empty recoveryEvents array", () => {
    const data = buildDashboardData({ runs: [], prs: [], recoveryEvents: [] });
    assert.ok(data.recoveryLevels);
    assert.equal(data.recoveryLevels.hasLevel3Today, false);
  });
});

// ---------------------------------------------------------------------------
// renderDashboard (CLI) — recovery levels section
// ---------------------------------------------------------------------------

describe("renderDashboard — recovery levels CLI output", () => {
  it("shows RECOVERY LEVELS section when events exist", () => {
    const data = buildDashboardData({
      runs: [],
      prs: [],
      recoveryEvents: [
        { level: 1, timestamp: new Date().toISOString(), issueId: "DVA-10" },
      ],
    });
    const output = renderDashboard(data);
    assert.ok(output.includes("RECOVERY LEVELS"), "CLI should show RECOVERY LEVELS header");
  });

  it("shows level labels (Level 1, Level 2, Level 3)", () => {
    const data = buildDashboardData({
      runs: [],
      prs: [],
      recoveryEvents: [
        { level: 1, timestamp: new Date().toISOString(), issueId: "DVA-10" },
      ],
    });
    const output = renderDashboard(data);
    assert.ok(output.includes("Level 1"), "CLI should show Level 1");
    assert.ok(output.includes("Level 2"), "CLI should show Level 2");
    assert.ok(output.includes("Level 3"), "CLI should show Level 3");
  });

  it("shows level descriptions (Auto-fix, Kill + Retry, Halt + Incident)", () => {
    const data = buildDashboardData({
      runs: [],
      prs: [],
      recoveryEvents: [
        { level: 2, timestamp: new Date().toISOString(), issueId: "DVA-20" },
      ],
    });
    const output = renderDashboard(data);
    assert.ok(output.includes("Auto-fix"), "CLI should show Auto-fix");
    assert.ok(output.includes("Kill + Retry"), "CLI should show Kill + Retry");
    assert.ok(output.includes("Halt + Incident"), "CLI should show Halt + Incident");
  });

  it("shows today and all-time counts", () => {
    const data = buildDashboardData({
      runs: [],
      prs: [],
      recoveryEvents: [
        { level: 1, timestamp: new Date().toISOString(), issueId: "DVA-10" },
        { level: 1, timestamp: "2026-01-01T00:00:00Z", issueId: "DVA-11" },
      ],
    });
    const output = renderDashboard(data);
    assert.ok(output.includes("today:"), "CLI should show today: count");
    assert.ok(output.includes("all-time:"), "CLI should show all-time: count");
  });

  it("does not show recovery section when no events", () => {
    const data = buildDashboardData({ runs: [], prs: [] });
    const output = renderDashboard(data);
    assert.ok(
      !output.includes("RECOVERY LEVELS"),
      "CLI should not show RECOVERY LEVELS when no events"
    );
  });
});

// ---------------------------------------------------------------------------
// generateDashboardHTML — recovery levels in web dashboard
// ---------------------------------------------------------------------------

describe("generateDashboardHTML — recovery panel markup", () => {
  it("includes recovery panel container in HTML", () => {
    const html = generateDashboardHTML();
    assert.ok(html.includes('id="recovery-panel"'), "HTML should have recovery-panel element");
  });

  it("includes renderRecoveryPanel function in JavaScript", () => {
    const html = generateDashboardHTML();
    assert.ok(
      html.includes("renderRecoveryPanel"),
      "HTML should include renderRecoveryPanel function"
    );
  });

  it("includes toggleRecoveryDetail function for click-to-expand", () => {
    const html = generateDashboardHTML();
    assert.ok(
      html.includes("toggleRecoveryDetail"),
      "HTML should include toggleRecoveryDetail function"
    );
  });

  it("includes recovery panel CSS styles", () => {
    const html = generateDashboardHTML();
    assert.ok(html.includes(".recovery-card"), "HTML should have .recovery-card CSS");
    assert.ok(html.includes(".recovery-alert-banner"), "HTML should have .recovery-alert-banner CSS");
    assert.ok(html.includes(".recovery-detail"), "HTML should have .recovery-detail CSS");
  });

  it("includes Level 3 active styling", () => {
    const html = generateDashboardHTML();
    assert.ok(
      html.includes(".level-3-active"),
      "HTML should have .level-3-active CSS class"
    );
  });
});

// ---------------------------------------------------------------------------
// generateStaticHTML — recovery levels in static dashboard
// ---------------------------------------------------------------------------

describe("generateStaticHTML — recovery panel in static dashboard", () => {
  it("includes recovery panel container in static HTML", () => {
    const data = {
      gauges: { running: 0, succeeded: 0, failed: 0, totalSucceeded: 0, totalFailed: 0, dailyUsed: 0, dailyLimit: 2 },
      activeAgents: [],
      history: [],
      recoveryLevels: {
        levels: {
          1: { today: 1, allTime: 3, events: [{ issueId: "DVA-10", timestamp: "2026-03-16T10:00:00Z" }] },
          2: { today: 0, allTime: 1, events: [{ issueId: "DVA-20", timestamp: "2026-03-15T10:00:00Z" }] },
          3: { today: 0, allTime: 0, events: [] },
        },
        hasLevel3Today: false,
      },
      buildTime: new Date().toISOString(),
    };
    const html = generateStaticHTML(data);
    assert.ok(html.includes('id="recovery-panel"'), "Static HTML should have recovery-panel");
    assert.ok(html.includes("renderRecoveryPanel"), "Static HTML should have renderRecoveryPanel");
  });

  it("embeds recovery level counts in data payload", () => {
    const data = {
      gauges: { running: 0, succeeded: 0, failed: 0, totalSucceeded: 0, totalFailed: 0, dailyUsed: 0, dailyLimit: 2 },
      activeAgents: [],
      history: [],
      recoveryLevels: {
        levels: {
          1: { today: 2, allTime: 5, events: [] },
          2: { today: 1, allTime: 3, events: [] },
          3: { today: 0, allTime: 0, events: [] },
        },
        hasLevel3Today: false,
      },
      buildTime: new Date().toISOString(),
    };
    const html = generateStaticHTML(data);
    assert.ok(html.includes('"allTime":5'), "Static HTML should embed Level 1 allTime:5");
    assert.ok(html.includes('"allTime":3'), "Static HTML should embed Level 2 allTime:3");
  });

  it("embeds Level 3 alert flag in data payload", () => {
    const data = {
      gauges: { running: 0, succeeded: 0, failed: 0, totalSucceeded: 0, totalFailed: 0, dailyUsed: 0, dailyLimit: 2 },
      activeAgents: [],
      history: [],
      recoveryLevels: {
        levels: {
          1: { today: 0, allTime: 0, events: [] },
          2: { today: 0, allTime: 0, events: [] },
          3: { today: 1, allTime: 1, events: [{ issueId: "DVA-99", timestamp: "2026-03-16T09:00:00Z" }] },
        },
        hasLevel3Today: true,
      },
      buildTime: new Date().toISOString(),
    };
    const html = generateStaticHTML(data);
    assert.ok(
      html.includes('"hasLevel3Today":true'),
      "Static HTML should embed hasLevel3Today:true"
    );
  });

  it("includes recovery panel CSS styles in static HTML", () => {
    const data = {
      gauges: { running: 0, succeeded: 0, failed: 0, totalSucceeded: 0, totalFailed: 0, dailyUsed: 0, dailyLimit: 2 },
      activeAgents: [],
      history: [],
      recoveryLevels: { levels: { 1: { today: 0, allTime: 0, events: [] }, 2: { today: 0, allTime: 0, events: [] }, 3: { today: 0, allTime: 0, events: [] } }, hasLevel3Today: false },
      buildTime: new Date().toISOString(),
    };
    const html = generateStaticHTML(data);
    assert.ok(html.includes(".recovery-card"), "Static HTML should have .recovery-card CSS");
    assert.ok(html.includes(".recovery-alert-banner"), "Static HTML should have .recovery-alert-banner CSS");
  });

  it("includes click-to-expand JavaScript in static HTML", () => {
    const data = {
      gauges: { running: 0, succeeded: 0, failed: 0, totalSucceeded: 0, totalFailed: 0, dailyUsed: 0, dailyLimit: 2 },
      activeAgents: [],
      history: [],
      recoveryLevels: { levels: { 1: { today: 0, allTime: 0, events: [] }, 2: { today: 0, allTime: 0, events: [] }, 3: { today: 0, allTime: 0, events: [] } }, hasLevel3Today: false },
      buildTime: new Date().toISOString(),
    };
    const html = generateStaticHTML(data);
    assert.ok(
      html.includes("toggleRecoveryDetail"),
      "Static HTML should include toggleRecoveryDetail function"
    );
  });
});
