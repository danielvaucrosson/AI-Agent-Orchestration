import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  parseArgs,
  fetchWorkflowRuns,
  fetchRecentPRs,
  fetchRunnerData,
  fetchLinearStatus,
  enrichWithLinearStatus,
  buildStaticData,
  generateStaticHTML,
} from "../scripts/generate-dashboard.mjs";

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

describe("parseArgs", () => {
  it("parses --out flag", () => {
    const args = parseArgs(["--out", "_site/dashboard/index.html"]);
    assert.equal(args.out, "_site/dashboard/index.html");
  });

  it("defaults to _site/dashboard/index.html", () => {
    const args = parseArgs([]);
    assert.equal(args.out, "_site/dashboard/index.html");
  });
});

// ---------------------------------------------------------------------------
// fetchWorkflowRuns
// ---------------------------------------------------------------------------

describe("fetchWorkflowRuns", () => {
  it("returns workflow_runs array from API response", async () => {
    const mockFetch = async () => ({
      ok: true,
      json: async () => ({ workflow_runs: [{ id: 1, status: "completed" }] }),
    });
    const runs = await fetchWorkflowRuns("owner/repo", mockFetch);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].id, 1);
  });

  it("returns empty array on API failure", async () => {
    const mockFetch = async () => ({ ok: false, status: 500 });
    const runs = await fetchWorkflowRuns("owner/repo", mockFetch);
    assert.deepEqual(runs, []);
  });
});

// ---------------------------------------------------------------------------
// fetchRecentPRs
// ---------------------------------------------------------------------------

describe("fetchRecentPRs", () => {
  it("returns PR array from API response", async () => {
    const mockFetch = async () => ({
      ok: true,
      json: async () => [
        {
          number: 18,
          title: "DVA-38: Upgrade",
          head: { ref: "feature/DVA-38" },
        },
      ],
    });
    const prs = await fetchRecentPRs("owner/repo", mockFetch);
    assert.equal(prs.length, 1);
    assert.equal(prs[0].number, 18);
    assert.equal(prs[0].headRefName, "feature/DVA-38");
  });

  it("returns empty array on failure", async () => {
    const mockFetch = async () => ({ ok: false });
    const prs = await fetchRecentPRs("owner/repo", mockFetch);
    assert.deepEqual(prs, []);
  });
});

// ---------------------------------------------------------------------------
// fetchRunnerData
// ---------------------------------------------------------------------------

describe("fetchRunnerData", () => {
  it("returns runners from API response", async () => {
    const mockFetch = async () => ({
      ok: true,
      json: async () => ({ runners: [{ id: 1, status: "online", busy: false }] }),
    });
    const data = await fetchRunnerData("owner/repo", mockFetch);
    assert.equal(data.runners.length, 1);
    assert.equal(data.runners[0].status, "online");
  });

  it("returns empty runners on API failure", async () => {
    const mockFetch = async () => ({ ok: false });
    const data = await fetchRunnerData("owner/repo", mockFetch);
    assert.deepEqual(data.runners, []);
  });

  it("returns empty runners on network error", async () => {
    const mockFetch = async () => { throw new Error("network"); };
    const data = await fetchRunnerData("owner/repo", mockFetch);
    assert.deepEqual(data.runners, []);
  });
});

// ---------------------------------------------------------------------------
// fetchLinearStatus
// ---------------------------------------------------------------------------

describe("fetchLinearStatus", () => {
  it("returns status string for a valid issue", async () => {
    const mockFetch = async () => ({
      ok: true,
      json: async () => ({
        data: { issues: { nodes: [{ state: { name: "In Progress" } }] } },
      }),
    });
    const status = await fetchLinearStatus("DVA-40", mockFetch);
    assert.equal(status, "In Progress");
  });

  it("returns null on API failure", async () => {
    const mockFetch = async () => ({ ok: false });
    const status = await fetchLinearStatus("DVA-40", mockFetch);
    assert.equal(status, null);
  });

  it("returns null when issue not found", async () => {
    const mockFetch = async () => ({
      ok: true,
      json: async () => ({ data: { issues: { nodes: [] } } }),
    });
    const status = await fetchLinearStatus("DVA-999", mockFetch);
    assert.equal(status, null);
  });

  it("returns null for unparseable identifier", async () => {
    const mockFetch = async () => {
      throw new Error("should not be called");
    };
    const status = await fetchLinearStatus("invalid", mockFetch);
    assert.equal(status, null);
  });
});

// ---------------------------------------------------------------------------
// enrichWithLinearStatus
// ---------------------------------------------------------------------------

describe("enrichWithLinearStatus", () => {
  it("adds linearStatus to each agent", async () => {
    const agents = [
      { issueId: "DVA-40", issueTitle: "Test", status: "In Progress" },
      { issueId: "DVA-41", issueTitle: "Other", status: "Queued" },
    ];
    const mockFetchStatus = async (id) =>
      id === "DVA-40" ? "In Progress" : "Todo";
    const result = await enrichWithLinearStatus(agents, mockFetchStatus);
    assert.equal(result[0].linearStatus, "In Progress");
    assert.equal(result[1].linearStatus, "Todo");
  });

  it("sets linearStatus to null when fetch fails", async () => {
    const agents = [
      { issueId: "DVA-40", issueTitle: "Test", status: "In Progress" },
    ];
    const mockFetchStatus = async () => null;
    const result = await enrichWithLinearStatus(agents, mockFetchStatus);
    assert.equal(result[0].linearStatus, null);
  });
});

// ---------------------------------------------------------------------------
// buildStaticData
// ---------------------------------------------------------------------------

describe("buildStaticData", () => {
  const now = new Date().toISOString();
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();

  it("overrides PR URLs with provided repoUrl", async () => {
    const runs = [
      {
        id: 10,
        status: "completed",
        conclusion: "success",
        created_at: now,
        run_started_at: fiveMinAgo,
        updated_at: now,
        inputs: { issue_id: "DVA-38", issue_title: "Upgrade" },
      },
    ];
    const prs = [
      { number: 18, title: "DVA-38: Upgrade", headRefName: "feature/DVA-38" },
    ];
    const data = await buildStaticData(runs, prs, {
      repoUrl: "https://github.com/myorg/myrepo",
      fetchStatusFn: async () => null,
    });
    assert.equal(
      data.history[0].prUrl,
      "https://github.com/myorg/myrepo/pull/18"
    );
  });

  it("enriches active agents with Linear status", async () => {
    const runs = [
      {
        id: 1,
        status: "in_progress",
        created_at: now,
        run_started_at: fiveMinAgo,
        inputs: { issue_id: "DVA-40", issue_title: "Filter" },
      },
    ];
    const data = await buildStaticData(runs, [], {
      repoUrl: "https://github.com/test/repo",
      fetchStatusFn: async () => "In Review",
    });
    assert.equal(data.activeAgents[0].linearStatus, "In Review");
  });

  it("includes buildTime timestamp", async () => {
    const data = await buildStaticData([], [], {
      repoUrl: "https://github.com/test/repo",
      fetchStatusFn: async () => null,
    });
    assert.ok(data.buildTime);
    assert.ok(new Date(data.buildTime).getTime() > 0);
  });
});

// ---------------------------------------------------------------------------
// generateStaticHTML
// ---------------------------------------------------------------------------

describe("generateStaticHTML", () => {
  const sampleData = {
    gauges: {
      running: 1,
      succeeded: 2,
      failed: 0,
      totalSucceeded: 5,
      totalFailed: 1,
      dailyUsed: 3,
      dailyLimit: 4,
    },
    activeAgents: [
      {
        issueId: "DVA-40",
        issueTitle: "Filter",
        status: "In Progress",
        duration: "5m 23s",
        runner: "self-hosted",
        branch: "feature/DVA-40",
        linearStatus: "In Progress",
      },
    ],
    history: [
      {
        issueId: "DVA-38",
        issueTitle: "Upgrade",
        success: true,
        prNumber: 18,
        prUrl: "https://github.com/test/repo/pull/18",
        duration: "6m 0s",
        when: "35 min ago",
      },
    ],
    buildTime: "2026-03-15T12:00:00Z",
  };

  it("returns a complete HTML document", () => {
    const html = generateStaticHTML(sampleData);
    assert.ok(html.startsWith("<!DOCTYPE html>"));
    assert.ok(html.includes("</html>"));
  });

  it("embeds DASHBOARD_DATA as JSON", () => {
    const html = generateStaticHTML(sampleData);
    assert.ok(html.includes("DASHBOARD_DATA = "));
    assert.ok(html.includes("DVA-40"));
  });

  it("includes Agent Control Center title", () => {
    const html = generateStaticHTML(sampleData);
    assert.ok(html.includes("Agent Control Center"));
  });

  it("includes meta refresh tag", () => {
    const html = generateStaticHTML(sampleData);
    assert.ok(html.includes('http-equiv="refresh"'));
    assert.ok(html.includes('content="60"'));
  });

  it("includes mobile viewport meta", () => {
    const html = generateStaticHTML(sampleData);
    assert.ok(html.includes('name="viewport"'));
  });

  it("includes GitHub-dark theme colors", () => {
    const html = generateStaticHTML(sampleData);
    assert.ok(html.includes("#0d1117"));
    assert.ok(html.includes("#161b22"));
  });

  it("includes mobile responsive CSS", () => {
    const html = generateStaticHTML(sampleData);
    assert.ok(html.includes("max-width: 768px"));
  });

  it("includes Linear status pill CSS", () => {
    const html = generateStaticHTML(sampleData);
    assert.ok(html.includes("pill-linear"));
  });

  it("renders linearStatus pill in agent cards when present", () => {
    const html = generateStaticHTML(sampleData);
    assert.ok(html.includes("renderLinearPill"));
  });

  it("does NOT include /api/status fetch", () => {
    const html = generateStaticHTML(sampleData);
    assert.ok(!html.includes("fetch('/api/status')"));
    assert.ok(!html.includes('fetch("/api/status")'));
  });

  it("shows build time in footer", () => {
    const html = generateStaticHTML(sampleData);
    assert.ok(html.includes("2026-03-15"));
  });

  it("escapes < in embedded JSON to prevent script injection", () => {
    const xssData = {
      ...sampleData,
      activeAgents: [
        {
          ...sampleData.activeAgents[0],
          issueTitle: '</script><img onerror=alert(1)>',
        },
      ],
    };
    const html = generateStaticHTML(xssData);
    assert.ok(
      !html.includes("</script><img"),
      "should not contain raw </script> in JSON"
    );
    assert.ok(html.includes("\\u003c"), "should escape < as \\u003c");
  });

  it("includes runner health panel CSS and rendering", () => {
    const html = generateStaticHTML(sampleData);
    assert.ok(html.includes("runner-health"), "should include runner-health container");
    assert.ok(html.includes("health-card"), "should include health-card CSS class");
    assert.ok(html.includes("renderRunnerHealth"), "should include renderRunnerHealth function");
  });

  it("renders runner health data when present", () => {
    const dataWithHealth = {
      ...sampleData,
      runnerHealth: {
        runner: { status: "online", lastSeen: "2026-03-15T12:00:00Z" },
        quotaTrend: { today: 3, yesterday: 2, trend: "up" },
        avgDuration: { avgMs: 450000, avgFormatted: "7m 30s", sampleSize: 5 },
        successRate: { rate: 80, trend: "up", currentWindow: { succeeded: 4, total: 5 }, previousWindow: { succeeded: 3, total: 5 } },
        daysSinceIncident: { days: 12, lastIncidentDate: "2026-03-03T10:00:00Z" },
      },
    };
    const html = generateStaticHTML(dataWithHealth);
    assert.ok(html.includes("runnerHealth"), "embedded JSON should contain runnerHealth");
  });
});

// ---------------------------------------------------------------------------
// buildStaticData — runner health integration
// ---------------------------------------------------------------------------

describe("buildStaticData runnerHealth", () => {
  it("passes runnerData through to dashboard data", async () => {
    const data = await buildStaticData([], [], {
      repoUrl: "https://github.com/test/repo",
      fetchStatusFn: async () => null,
      runnerData: { runners: [{ status: "online", busy: false, os: "Linux" }] },
    });
    assert.ok(data.runnerHealth);
    assert.equal(data.runnerHealth.runner.status, "online");
  });

  it("defaults to unknown when no runnerData provided", async () => {
    const data = await buildStaticData([], [], {
      repoUrl: "https://github.com/test/repo",
      fetchStatusFn: async () => null,
    });
    assert.ok(data.runnerHealth);
    assert.equal(data.runnerHealth.runner.status, "unknown");
  });
});

// ---------------------------------------------------------------------------
// buildStaticData — pulse check integration
// ---------------------------------------------------------------------------

describe("buildStaticData pulseCheck", () => {
  it("includes pulse data from recovery events", async () => {
    const recoveryEvents = [
      { timestamp: "2026-03-15T10:00:00Z", level: 1, action: "cancel-requeue", issueId: "DVA-10", diagnosis: "runner-offline" },
    ];
    const data = await buildStaticData([], [], {
      repoUrl: "https://github.com/test/repo",
      fetchStatusFn: async () => null,
      recoveryEvents,
    });
    assert.ok(Array.isArray(data.pulseActivityLog), "should include pulseActivityLog");
    assert.equal(data.pulseActivityLog.length, 1);
    assert.ok(data.pulseStatusMap, "should include pulseStatusMap");
    assert.equal(data.pulseStatusMap["DVA-10"].level, 1);
  });

  it("returns empty pulse data when no recovery events", async () => {
    const data = await buildStaticData([], [], {
      repoUrl: "https://github.com/test/repo",
      fetchStatusFn: async () => null,
    });
    assert.deepEqual(data.pulseActivityLog, []);
    assert.deepEqual(data.pulseStatusMap, {});
  });
});

// ---------------------------------------------------------------------------
// generateStaticHTML — pulse check elements
// ---------------------------------------------------------------------------

describe("generateStaticHTML pulseCheck", () => {
  const sampleDataWithPulse = {
    gauges: {
      running: 1, succeeded: 2, failed: 0,
      totalSucceeded: 5, totalFailed: 1,
      dailyUsed: 3, dailyLimit: 4,
    },
    activeAgents: [{
      issueId: "DVA-40", issueTitle: "Filter",
      status: "In Progress", duration: "5m 23s",
      runner: "self-hosted", branch: "feature/DVA-40",
      linearStatus: "In Progress",
    }],
    history: [],
    buildTime: "2026-03-15T12:00:00Z",
    pulseActivityLog: [{
      timestamp: "2026-03-15T11:00:00Z", level: 2,
      action: "cancel-requeue", issueId: "DVA-40",
      issueTitle: "Filter", diagnosis: "log-errors",
      when: "1h ago",
    }],
    pulseStatusMap: {
      "DVA-40": { lastChecked: "2026-03-15T11:00:00Z", level: 2, action: "cancel-requeue", diagnosis: "log-errors" },
    },
  };

  it("includes pulse pill CSS", () => {
    const html = generateStaticHTML(sampleDataWithPulse);
    assert.ok(html.includes("pulse-pill"), "should have pulse pill CSS");
    assert.ok(html.includes("pulse-pill-1"), "should have level 1 pulse pill CSS");
  });

  it("includes pulse activity log rendering", () => {
    const html = generateStaticHTML(sampleDataWithPulse);
    assert.ok(html.includes("pulse-log-panel"), "should have pulse log container");
    assert.ok(html.includes("renderPulseActivityLog"), "should have render function");
  });

  it("includes pulse status map for agent pills", () => {
    const html = generateStaticHTML(sampleDataWithPulse);
    assert.ok(html.includes("renderPulsePill"), "should have renderPulsePill function");
    assert.ok(html.includes("_pulseStatusMap"), "should reference pulse status map");
  });

  it("includes Gantt pulse marker CSS", () => {
    const html = generateStaticHTML(sampleDataWithPulse);
    assert.ok(html.includes("gantt-pulse-marker"), "should have Gantt pulse marker CSS");
  });

  it("embeds pulse data in dashboard JSON", () => {
    const html = generateStaticHTML(sampleDataWithPulse);
    assert.ok(html.includes("pulseActivityLog"), "should embed pulse log data");
    assert.ok(html.includes("pulseStatusMap"), "should embed pulse status map");
  });
});
