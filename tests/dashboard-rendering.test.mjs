/**
 * Dashboard Rendering Tests (DVA-59)
 *
 * Verifies that dashboard rendering functions (HTML and CLI) produce correct
 * output when given mock data from buildDashboardData().
 *
 * Tests cover:
 *  - generateStaticHTML: HTML output with embedded gauge counts, agent cards,
 *    PR links, and auto-refresh markup
 *  - renderDashboard: CLI output with section headers, issue IDs, status
 *    strings, and duration values from mock data
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildDashboardData,
  renderDashboard,
  generateDashboardHTML,
} from "../scripts/agent-dashboard.mjs";

import { generateStaticHTML } from "../scripts/generate-dashboard.mjs";

// ---------------------------------------------------------------------------
// Shared mock data helpers
// ---------------------------------------------------------------------------

/**
 * Build a realistic set of raw workflow runs + PRs that exercises all
 * dashboard sections (running agent, queued agent, successful completion,
 * failed completion, PR match).
 */
function makeMockRaw() {
  const now = new Date().toISOString();
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const startedAt = "2026-03-15T08:00:00Z";
  const endedAt = "2026-03-15T08:07:30Z"; // 7m 30s

  return {
    runs: [
      // Active — in progress
      {
        id: 1001,
        status: "in_progress",
        created_at: fiveMinAgo,
        run_started_at: fiveMinAgo,
        runner_name: "self-hosted-runner-1",
        head_branch: "feature/DVA-55-some-feature",
        inputs: { issue_id: "DVA-55", issue_title: "Add some feature" },
      },
      // Active — queued
      {
        id: 1002,
        status: "queued",
        created_at: now,
        run_started_at: null,
        runner_name: null,
        head_branch: "feature/DVA-56-another-feature",
        inputs: { issue_id: "DVA-56", issue_title: "Another feature" },
      },
      // Completed — success (today, matches a PR)
      {
        id: 2001,
        status: "completed",
        conclusion: "success",
        created_at: fiveMinAgo,
        run_started_at: startedAt,
        updated_at: endedAt,
        inputs: { issue_id: "DVA-50", issue_title: "Implement dashboard" },
      },
      // Completed — failure (today, no PR)
      {
        id: 2002,
        status: "completed",
        conclusion: "failure",
        created_at: tenMinAgo,
        run_started_at: startedAt,
        updated_at: endedAt,
        inputs: { issue_id: "DVA-51", issue_title: "Pulse check" },
      },
    ],
    prs: [
      // Matches completed run 2001 (DVA-50)
      {
        number: 42,
        title: "DVA-50: Implement dashboard",
        headRefName: "feature/DVA-50-implement-dashboard",
      },
      // Unrelated PR — should not be matched
      {
        number: 99,
        title: "Chore: update deps",
        headRefName: "chore/update-deps",
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// HTML Rendering Tests — generateStaticHTML (static/GitHub Pages dashboard)
// ---------------------------------------------------------------------------

describe("generateStaticHTML — gauge cards show correct counts", () => {
  it("embeds running count (1) in the HTML data payload", () => {
    const raw = makeMockRaw();
    const data = buildDashboardData(raw);
    // Strip internal fields as buildStaticData does
    const { _active, _completed, _prMap, _dailyCount, ...publicData } = data;
    publicData.buildTime = new Date().toISOString();

    const html = generateStaticHTML(publicData);

    // The static HTML embeds DASHBOARD_DATA as JSON; the JS then calls
    // renderGauges(DASHBOARD_DATA.gauges). The gauge values are in JSON.
    assert.ok(
      html.includes(`"running":${publicData.gauges.running}`),
      `HTML should contain "running":${publicData.gauges.running}`
    );
  });

  it("embeds totalSucceeded count in the HTML data payload", () => {
    const raw = makeMockRaw();
    const data = buildDashboardData(raw);
    const { _active, _completed, _prMap, _dailyCount, ...publicData } = data;
    publicData.buildTime = new Date().toISOString();

    const html = generateStaticHTML(publicData);

    assert.ok(
      html.includes(`"totalSucceeded":${publicData.gauges.totalSucceeded}`),
      `HTML should contain "totalSucceeded":${publicData.gauges.totalSucceeded}`
    );
  });

  it("embeds totalFailed count in the HTML data payload", () => {
    const raw = makeMockRaw();
    const data = buildDashboardData(raw);
    const { _active, _completed, _prMap, _dailyCount, ...publicData } = data;
    publicData.buildTime = new Date().toISOString();

    const html = generateStaticHTML(publicData);

    assert.ok(
      html.includes(`"totalFailed":${publicData.gauges.totalFailed}`),
      `HTML should contain "totalFailed":${publicData.gauges.totalFailed}`
    );
  });

  it("embeds daily quota values (dailyUsed / dailyLimit) in the HTML data payload", () => {
    const raw = makeMockRaw();
    const data = buildDashboardData(raw);
    const { _active, _completed, _prMap, _dailyCount, ...publicData } = data;
    publicData.buildTime = new Date().toISOString();

    const html = generateStaticHTML(publicData);

    assert.ok(
      html.includes(`"dailyUsed":${publicData.gauges.dailyUsed}`),
      `HTML should contain "dailyUsed":${publicData.gauges.dailyUsed}`
    );
    assert.ok(
      html.includes(`"dailyLimit":${publicData.gauges.dailyLimit}`),
      `HTML should contain "dailyLimit":${publicData.gauges.dailyLimit}`
    );
  });
});

describe("generateStaticHTML — active agent cards data in payload", () => {
  it("embeds the in-progress agent issue ID in the HTML data payload", () => {
    const raw = makeMockRaw();
    const data = buildDashboardData(raw);
    const { _active, _completed, _prMap, _dailyCount, ...publicData } = data;
    publicData.buildTime = new Date().toISOString();

    const html = generateStaticHTML(publicData);

    // DVA-55 is the in-progress agent
    assert.ok(html.includes("DVA-55"), "HTML payload should include DVA-55 issue ID");
  });

  it("embeds the queued agent issue ID in the HTML data payload", () => {
    const raw = makeMockRaw();
    const data = buildDashboardData(raw);
    const { _active, _completed, _prMap, _dailyCount, ...publicData } = data;
    publicData.buildTime = new Date().toISOString();

    const html = generateStaticHTML(publicData);

    // DVA-56 is the queued agent
    assert.ok(html.includes("DVA-56"), "HTML payload should include DVA-56 issue ID");
  });

  it("embeds agent status strings in the HTML data payload", () => {
    const raw = makeMockRaw();
    const data = buildDashboardData(raw);
    const { _active, _completed, _prMap, _dailyCount, ...publicData } = data;
    publicData.buildTime = new Date().toISOString();

    const html = generateStaticHTML(publicData);

    assert.ok(
      html.includes("In Progress"),
      "HTML payload should include 'In Progress' status string"
    );
    assert.ok(
      html.includes("Queued"),
      "HTML payload should include 'Queued' status string"
    );
  });

  it("embeds agent duration string in the HTML data payload", () => {
    const raw = makeMockRaw();
    const data = buildDashboardData(raw);
    const { _active, _completed, _prMap, _dailyCount, ...publicData } = data;
    publicData.buildTime = new Date().toISOString();

    const html = generateStaticHTML(publicData);

    // The in-progress agent started ~5 min ago — duration should be "5m Xs"
    const agent = publicData.activeAgents.find((a) => a.issueId === "DVA-55");
    assert.ok(agent, "DVA-55 should be in activeAgents");
    assert.ok(
      html.includes(agent.duration),
      `HTML payload should include duration "${agent.duration}"`
    );
  });

  it("embeds issue title in the HTML data payload", () => {
    const raw = makeMockRaw();
    const data = buildDashboardData(raw);
    const { _active, _completed, _prMap, _dailyCount, ...publicData } = data;
    publicData.buildTime = new Date().toISOString();

    const html = generateStaticHTML(publicData);

    assert.ok(
      html.includes("Add some feature"),
      "HTML payload should include the agent issue title"
    );
  });
});

describe("generateStaticHTML — history table with PR links", () => {
  it("embeds PR URL for successful runs matched to a PR", () => {
    const raw = makeMockRaw();
    const data = buildDashboardData(raw);
    const { _active, _completed, _prMap, _dailyCount, ...publicData } = data;
    publicData.buildTime = new Date().toISOString();

    const html = generateStaticHTML(publicData);

    // DVA-50 matched PR #42
    const histEntry = publicData.history.find((h) => h.issueId === "DVA-50");
    assert.ok(histEntry, "DVA-50 should be in history");
    assert.ok(histEntry.prUrl, "DVA-50 history entry should have a prUrl");
    assert.ok(
      html.includes(histEntry.prUrl),
      `HTML should contain PR URL "${histEntry.prUrl}"`
    );
    // The static JS renders an <a> tag using the URL — verify the pattern
    assert.ok(
      html.includes("/pull/42"),
      "HTML should contain '/pull/42' in the data payload"
    );
  });

  it("embeds prNumber for the matched PR", () => {
    const raw = makeMockRaw();
    const data = buildDashboardData(raw);
    const { _active, _completed, _prMap, _dailyCount, ...publicData } = data;
    publicData.buildTime = new Date().toISOString();

    const html = generateStaticHTML(publicData);

    const histEntry = publicData.history.find((h) => h.issueId === "DVA-50");
    assert.equal(histEntry?.prNumber, 42, "PR number should be 42");
    assert.ok(
      html.includes('"prNumber":42'),
      "HTML should embed prNumber:42 in the data payload"
    );
  });

  it("sets prNumber null for failed runs without a matching PR", () => {
    const raw = makeMockRaw();
    const data = buildDashboardData(raw);
    const { _active, _completed, _prMap, _dailyCount, ...publicData } = data;
    publicData.buildTime = new Date().toISOString();

    // DVA-51 failed and has no matching PR
    const failedEntry = publicData.history.find((h) => h.issueId === "DVA-51");
    assert.ok(failedEntry, "DVA-51 should be in history");
    assert.equal(
      failedEntry.prNumber,
      null,
      "Failed run without PR should have prNumber null"
    );

    const html = generateStaticHTML(publicData);
    // prUrl should be null, so no /pull/ link for DVA-51
    assert.ok(
      !failedEntry.prUrl,
      "Failed run without PR should have no prUrl"
    );
  });

  it("embeds completed run duration in history payload", () => {
    const raw = makeMockRaw();
    const data = buildDashboardData(raw);
    const { _active, _completed, _prMap, _dailyCount, ...publicData } = data;
    publicData.buildTime = new Date().toISOString();

    const html = generateStaticHTML(publicData);

    // DVA-50: started 08:00:00, ended 08:07:30 → "7m 30s"
    const histEntry = publicData.history.find((h) => h.issueId === "DVA-50");
    assert.equal(histEntry?.duration, "7m 30s", "Duration should be 7m 30s");
    assert.ok(
      html.includes("7m 30s"),
      "HTML should contain the computed duration '7m 30s'"
    );
  });

  it("embeds history issue IDs in HTML payload", () => {
    const raw = makeMockRaw();
    const data = buildDashboardData(raw);
    const { _active, _completed, _prMap, _dailyCount, ...publicData } = data;
    publicData.buildTime = new Date().toISOString();

    const html = generateStaticHTML(publicData);

    assert.ok(html.includes("DVA-50"), "HTML should contain history issue DVA-50");
    assert.ok(html.includes("DVA-51"), "HTML should contain history issue DVA-51");
  });
});

describe("generateStaticHTML — auto-refresh markup", () => {
  it("includes meta http-equiv refresh tag for auto-refresh", () => {
    const raw = makeMockRaw();
    const data = buildDashboardData(raw);
    const { _active, _completed, _prMap, _dailyCount, ...publicData } = data;
    publicData.buildTime = new Date().toISOString();

    const html = generateStaticHTML(publicData);

    // Static dashboard uses meta refresh (60s) rather than setInterval
    assert.ok(
      html.includes('http-equiv="refresh"') || html.includes("http-equiv='refresh'"),
      "Static HTML should contain a meta http-equiv refresh tag"
    );
  });

  it("includes auto-refresh text indicating refresh interval", () => {
    const raw = makeMockRaw();
    const data = buildDashboardData(raw);
    const { _active, _completed, _prMap, _dailyCount, ...publicData } = data;
    publicData.buildTime = new Date().toISOString();

    const html = generateStaticHTML(publicData);

    assert.ok(
      html.includes("Auto-refresh"),
      "HTML should contain 'Auto-refresh' indicator text"
    );
  });

  it("generateDashboardHTML (web mode) contains setInterval with 10s interval", () => {
    // The web dashboard uses setInterval(refresh, 10000) for live updates
    const html = generateDashboardHTML();

    assert.ok(
      html.includes("setInterval(refresh, 10000)"),
      "Web HTML should contain setInterval(refresh, 10000)"
    );
  });

  it("generateDashboardHTML (web mode) fetches /api/status for data", () => {
    const html = generateDashboardHTML();

    assert.ok(
      html.includes("fetch('/api/status')") || html.includes('fetch("/api/status")'),
      "Web HTML should fetch '/api/status'"
    );
  });
});

// ---------------------------------------------------------------------------
// CLI Rendering Tests — renderDashboard
// ---------------------------------------------------------------------------

describe("renderDashboard — output has expected sections", () => {
  it("contains AGENT DASHBOARD header", () => {
    const data = buildDashboardData(makeMockRaw());
    const output = renderDashboard(data);

    assert.ok(output.includes("AGENT DASHBOARD"), "CLI output should have AGENT DASHBOARD header");
  });

  it("contains RUNNING gauge section", () => {
    const data = buildDashboardData(makeMockRaw());
    const output = renderDashboard(data);

    assert.ok(output.includes("RUNNING:"), "CLI output should have RUNNING: gauge");
  });

  it("contains TOTAL succeeded/failed section", () => {
    const data = buildDashboardData(makeMockRaw());
    const output = renderDashboard(data);

    assert.ok(output.includes("TOTAL:"), "CLI output should have TOTAL: section");
    assert.ok(output.includes("succeeded"), "CLI output should mention succeeded count");
    assert.ok(output.includes("failed"), "CLI output should mention failed count");
  });

  it("contains RECENT COMPLETIONS section header", () => {
    const data = buildDashboardData(makeMockRaw());
    const output = renderDashboard(data);

    assert.ok(
      output.includes("RECENT COMPLETIONS"),
      "CLI output should have RECENT COMPLETIONS section"
    );
  });

  it("contains auto-refresh footer with keyboard shortcuts", () => {
    const data = buildDashboardData(makeMockRaw());
    const output = renderDashboard(data);

    assert.ok(output.includes("Auto-refresh"), "CLI footer should mention Auto-refresh");
    assert.ok(output.includes("q = quit"), "CLI footer should mention q = quit");
    assert.ok(output.includes("r = refresh now"), "CLI footer should mention r = refresh now");
  });
});

describe("renderDashboard — formats active agent data correctly", () => {
  it("shows in-progress agent issue ID (DVA-55)", () => {
    const data = buildDashboardData(makeMockRaw());
    const output = renderDashboard(data);

    assert.ok(output.includes("DVA-55"), "CLI output should contain DVA-55");
  });

  it("shows queued agent issue ID (DVA-56)", () => {
    const data = buildDashboardData(makeMockRaw());
    const output = renderDashboard(data);

    assert.ok(output.includes("DVA-56"), "CLI output should contain DVA-56");
  });

  it("shows queued status tag for queued agent", () => {
    const data = buildDashboardData(makeMockRaw());
    const output = renderDashboard(data);

    assert.ok(output.includes("(queued)"), "CLI output should show (queued) for queued agent");
  });

  it("shows agent issue title text", () => {
    const data = buildDashboardData(makeMockRaw());
    const output = renderDashboard(data);

    assert.ok(
      output.includes("Add some feature"),
      "CLI output should include the agent title 'Add some feature'"
    );
  });

  it("shows elapsed duration for in-progress agent", () => {
    const data = buildDashboardData(makeMockRaw());
    const output = renderDashboard(data);

    // The agent started ~5 minutes ago; duration should be "5m Xs" format
    assert.ok(
      /\d+m \d+s/.test(output),
      "CLI output should contain a duration in 'Nm Ns' format"
    );
  });

  it("shows correct running count in RUNNING gauge", () => {
    const data = buildDashboardData(makeMockRaw());
    const output = renderDashboard(data);

    // mock has 1 in_progress run — running count is 1
    // RUNNING: [1] / 2 daily
    assert.ok(
      output.includes(" 1 "),
      "CLI RUNNING gauge should show count 1"
    );
  });
});

describe("renderDashboard — formats completed run data correctly", () => {
  it("shows OK status for successful run", () => {
    const data = buildDashboardData(makeMockRaw());
    const output = renderDashboard(data);

    assert.ok(output.includes("OK"), "CLI output should show OK for successful run");
  });

  it("shows FAIL status for failed run", () => {
    const data = buildDashboardData(makeMockRaw());
    const output = renderDashboard(data);

    assert.ok(output.includes("FAIL"), "CLI output should show FAIL for failed run");
  });

  it("shows completed run issue ID (DVA-50) in history", () => {
    const data = buildDashboardData(makeMockRaw());
    const output = renderDashboard(data);

    assert.ok(output.includes("DVA-50"), "CLI output should contain DVA-50 in history");
  });

  it("shows failed run issue ID (DVA-51) in history", () => {
    const data = buildDashboardData(makeMockRaw());
    const output = renderDashboard(data);

    assert.ok(output.includes("DVA-51"), "CLI output should contain DVA-51 in history");
  });

  it("shows PR number for matched run", () => {
    const data = buildDashboardData(makeMockRaw());
    const output = renderDashboard(data);

    assert.ok(output.includes("PR #42"), "CLI output should show PR #42 for DVA-50");
  });

  it("shows 'no PR' for unmatched run", () => {
    const data = buildDashboardData(makeMockRaw());
    const output = renderDashboard(data);

    assert.ok(output.includes("no PR"), "CLI output should show 'no PR' for runs without a PR");
  });

  it("shows computed duration for completed run (7m 30s)", () => {
    const data = buildDashboardData(makeMockRaw());
    const output = renderDashboard(data);

    // DVA-50: startedAt=08:00:00, endedAt=08:07:30 → 7m 30s
    assert.ok(output.includes("7m 30s"), "CLI output should show '7m 30s' for completed run");
  });
});

describe("renderDashboard — empty state output", () => {
  it("shows empty state message when no active agents", () => {
    const data = buildDashboardData({ runs: [], prs: [] });
    const output = renderDashboard(data);

    assert.ok(
      output.includes("No agents currently running"),
      "CLI should display empty-state message for active agents"
    );
  });

  it("shows empty completions message when no completed runs", () => {
    const data = buildDashboardData({ runs: [], prs: [] });
    const output = renderDashboard(data);

    assert.ok(
      output.includes("No recent completions"),
      "CLI should display empty-state message for completions"
    );
  });
});

describe("renderDashboard — web URL option", () => {
  it("includes web URL in output when provided via opts.webUrl", () => {
    const data = buildDashboardData({ runs: [], prs: [] });
    const output = renderDashboard(data, { webUrl: "http://localhost:9999" });

    assert.ok(
      output.includes("http://localhost:9999"),
      "CLI output should display the webUrl when provided"
    );
  });

  it("does not include 'Web:' line when webUrl is not provided", () => {
    const data = buildDashboardData({ runs: [], prs: [] });
    const output = renderDashboard(data);

    // No webUrl → no "Web:" label in footer
    assert.ok(!output.includes("Web: http"), "CLI output should not have Web: link without webUrl");
  });
});

// ---------------------------------------------------------------------------
// Duration Bars Tests
// ---------------------------------------------------------------------------

describe("duration bars — durationMs in buildDashboardData history", () => {
  it("computes durationMs from run timestamps", () => {
    const raw = makeMockRaw();
    const data = buildDashboardData(raw);

    for (const entry of data.history) {
      assert.ok("durationMs" in entry, "history entry should have durationMs field");
      assert.ok(typeof entry.durationMs === "number", "durationMs should be a number");
      assert.ok(entry.durationMs >= 0, "durationMs should be non-negative");
    }
  });
});

describe("duration bars — static HTML includes bar markup", () => {
  it("generateStaticHTML includes duration-bar CSS class", () => {
    const raw = makeMockRaw();
    const data = buildDashboardData(raw);
    const { _active, _completed, _prMap, _dailyCount, ...publicData } = data;
    publicData.buildTime = new Date().toISOString();

    const html = generateStaticHTML(publicData);
    assert.ok(html.includes("duration-bar"), "Static HTML should include duration-bar CSS class");
    assert.ok(html.includes("duration-text"), "Static HTML should include duration-text CSS class");
  });

  it("generateStaticHTML renderHistory references durationMs", () => {
    const raw = makeMockRaw();
    const data = buildDashboardData(raw);
    const { _active, _completed, _prMap, _dailyCount, ...publicData } = data;
    publicData.buildTime = new Date().toISOString();

    const html = generateStaticHTML(publicData);
    assert.ok(html.includes("durationMs"), "Static renderHistory should use durationMs for bar width");
  });
});
