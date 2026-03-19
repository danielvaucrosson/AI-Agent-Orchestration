/**
 * Static Dashboard Generator — builds a self-contained HTML dashboard
 * and writes it to disk for GitHub Pages deployment.
 *
 * Usage: node scripts/generate-dashboard.mjs --out _site/dashboard/index.html
 *
 * Requires: GITHUB_TOKEN, LINEAR_API_KEY, GITHUB_REPOSITORY env vars
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { buildDashboardData, extractRunInfo, readRecoveryEvents } from "./agent-dashboard.mjs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WORKFLOW_FILE = "agent-worker.yml";

function getRepoUrl() {
  const repo = process.env.GITHUB_REPOSITORY; // "owner/repo"
  return repo
    ? `https://github.com/${repo}`
    : "https://github.com/danielvaucrosson/AI-Agent-Orchestration";
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const idx = argv.indexOf("--out");
  const out =
    idx !== -1 && argv[idx + 1] ? argv[idx + 1] : "_site/dashboard/index.html";
  return { out };
}

// ---------------------------------------------------------------------------
// Data fetchers (accept fetchFn for testability)
// ---------------------------------------------------------------------------

export async function fetchWorkflowRuns(repo, fetchFn = fetch) {
  try {
    const res = await fetchFn(
      `https://api.github.com/repos/${repo}/actions/workflows/${WORKFLOW_FILE}/runs?per_page=30`,
      {
        headers: {
          Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
          Accept: "application/vnd.github+json",
        },
      }
    );
    if (!res.ok) return [];
    const data = await res.json();
    return data.workflow_runs || [];
  } catch {
    return [];
  }
}

export async function fetchRunnerData(repo, fetchFn = fetch) {
  try {
    const res = await fetchFn(
      `https://api.github.com/repos/${repo}/actions/runners`,
      {
        headers: {
          Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
          Accept: "application/vnd.github+json",
        },
      }
    );
    if (!res.ok) return { runners: [] };
    const data = await res.json();
    return { runners: data.runners || [] };
  } catch {
    return { runners: [] };
  }
}

export async function fetchRecentPRs(repo, fetchFn = fetch) {
  try {
    const res = await fetchFn(
      `https://api.github.com/repos/${repo}/pulls?state=all&per_page=30&sort=updated&direction=desc`,
      {
        headers: {
          Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
          Accept: "application/vnd.github+json",
        },
      }
    );
    if (!res.ok) return [];
    const prs = await res.json();
    // Normalize to match the shape buildDashboardData expects
    return prs.map((pr) => ({
      number: pr.number,
      title: pr.title,
      headRefName: pr.head?.ref || "",
    }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Linear API enrichment
// ---------------------------------------------------------------------------

export async function fetchLinearStatus(issueIdentifier, fetchFn = fetch) {
  try {
    // Parse "DVA-40" into team key "DVA" and number 40
    const match = issueIdentifier?.match(/^([A-Z]{1,5})-(\d+)$/);
    if (!match) return null;
    const [, teamKey, numStr] = match;
    const issueNumber = parseInt(numStr, 10);

    const res = await fetchFn("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: process.env.LINEAR_API_KEY || "",
      },
      body: JSON.stringify({
        query: `query ($teamKey: String!, $number: Float!) {
          issues(filter: { team: { key: { eq: $teamKey } }, number: { eq: $number } }, first: 1) {
            nodes { state { name } }
          }
        }`,
        variables: { teamKey, number: issueNumber },
      }),
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json.data?.issues?.nodes?.[0]?.state?.name || null;
  } catch {
    return null;
  }
}

export async function enrichWithLinearStatus(
  activeAgents,
  fetchStatusFn = fetchLinearStatus
) {
  return Promise.all(
    activeAgents.map(async (agent) => ({
      ...agent,
      linearStatus: await fetchStatusFn(agent.issueId),
    }))
  );
}

// ---------------------------------------------------------------------------
// Data assembler
// ---------------------------------------------------------------------------

export async function buildStaticData(
  runs,
  prs,
  { repoUrl, fetchStatusFn = fetchLinearStatus, recoveryEvents, runnerData } = {}
) {
  const raw = { runs, prs, recoveryEvents: recoveryEvents || [], runnerData };
  const data = buildDashboardData(raw);

  // Strip internal fields
  const { _active, _completed, _prMap, _dailyCount, ...publicData } = data;

  // Override PR URLs with correct repo URL
  const effectiveRepoUrl = repoUrl || getRepoUrl();
  for (const entry of publicData.history) {
    if (entry.prNumber) {
      entry.prUrl = `${effectiveRepoUrl}/pull/${entry.prNumber}`;
    }
  }

  // Enrich active agents with Linear status
  publicData.activeAgents = await enrichWithLinearStatus(
    publicData.activeAgents,
    fetchStatusFn
  );

  publicData.buildTime = new Date().toISOString();

  return publicData;
}

// ---------------------------------------------------------------------------
// Static HTML generator
// ---------------------------------------------------------------------------

export function generateStaticHTML(data) {
  // Escape < to \u003c to prevent </script> injection
  const dataJson = JSON.stringify(data).replace(/</g, "\\u003c");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="refresh" content="60">
<title>Agent Control Center</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #0d1117; color: #c9d1d9;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
    line-height: 1.5;
  }
  header {
    background: #161b22; padding: 12px 24px;
    border-bottom: 1px solid #30363d;
    display: flex; justify-content: space-between; align-items: center;
  }
  header h1 { font-size: 16px; color: #fff; font-weight: 600; }
  .header-right { display: flex; gap: 16px; align-items: center; font-size: 12px; color: #8b949e; }
  .refresh-dot { color: #3fb950; }
  .container { max-width: 1200px; margin: 0 auto; padding: 20px 24px; }
  .gauges { display: flex; gap: 16px; margin-bottom: 24px; }
  .gauge {
    flex: 1; background: #161b22; border: 1px solid #30363d;
    border-radius: 10px; padding: 16px; text-align: center;
  }
  .gauge-value { font-size: 36px; font-weight: bold; }
  .gauge-label {
    color: #8b949e; font-size: 11px;
    text-transform: uppercase; letter-spacing: 1px; margin-top: 4px;
  }
  .gauge-sub { color: #8b949e; font-size: 11px; margin-top: 2px; }
  .gauge-running .gauge-value { color: #58a6ff; }
  .gauge-succeeded .gauge-value { color: #3fb950; }
  .gauge-failed .gauge-value { color: #f85149; }
  .gauge-quota .gauge-value { color: #d29922; }
  .runner-health { margin-bottom: 24px; }
  .health-cards { display: flex; gap: 12px; flex-wrap: wrap; }
  .health-card {
    flex: 1; min-width: 150px; background: #161b22; border: 1px solid #30363d;
    border-radius: 10px; padding: 16px; text-align: center;
  }
  .health-value { font-size: 24px; font-weight: bold; }
  .health-label {
    color: #8b949e; font-size: 11px;
    text-transform: uppercase; letter-spacing: 1px; margin-top: 4px;
  }
  .health-sub { color: #8b949e; font-size: 11px; margin-top: 2px; }
  .health-trend { font-size: 14px; margin-left: 4px; }
  .trend-up { color: #3fb950; }
  .trend-down { color: #f85149; }
  .trend-flat { color: #8b949e; }
  .status-online { color: #3fb950; }
  .status-busy { color: #d29922; }
  .status-offline { color: #f85149; }
  .status-unknown { color: #8b949e; }
  .section-label {
    color: #8b949e; font-size: 12px;
    text-transform: uppercase; letter-spacing: 1px;
    margin-bottom: 10px;
  }
  .recovery-panel { margin-bottom: 24px; }
  .recovery-alert-banner {
    background: rgba(248, 81, 73, 0.15); border: 1px solid #f85149;
    border-radius: 8px; padding: 10px 16px; margin-bottom: 12px;
    color: #f85149; font-weight: 600; font-size: 13px;
  }
  .recovery-cards { display: flex; gap: 12px; }
  .recovery-card {
    flex: 1; background: #161b22; border: 1px solid #30363d;
    border-radius: 10px; padding: 16px; text-align: center;
    cursor: pointer; transition: border-color 0.2s;
  }
  .recovery-card:hover { border-color: #58a6ff; }
  .recovery-card.level-3-active { border-color: #f85149; border-width: 2px; }
  .recovery-value { font-size: 28px; font-weight: bold; }
  .recovery-label { font-size: 12px; text-transform: uppercase; letter-spacing: 1px; margin-top: 4px; }
  .recovery-sublabel { color: #8b949e; font-size: 11px; margin-top: 2px; }
  .recovery-today { color: #8b949e; font-size: 11px; margin-top: 4px; }
  .recovery-detail {
    background: #161b22; border: 1px solid #30363d; border-radius: 8px;
    padding: 14px; margin-top: 10px; display: none;
  }
  .recovery-detail.open { display: block; }
  .recovery-detail-header { font-size: 12px; text-transform: uppercase; color: #8b949e; letter-spacing: 1px; margin-bottom: 8px; }
  .recovery-event { padding: 6px 0; border-bottom: 1px solid #21262d; font-size: 13px; display: flex; justify-content: space-between; }
  .recovery-event:last-child { border-bottom: none; }
  .recovery-event-issue { color: #58a6ff; font-weight: 500; }
  .recovery-event-time { color: #8b949e; font-size: 12px; }
  .agents { margin-bottom: 24px; }
  .agent-card {
    background: #161b22; border: 1px solid #30363d;
    border-radius: 8px; padding: 14px; margin-bottom: 10px;
  }
  .agent-card.in-progress { border-left: 3px solid #58a6ff; }
  .agent-card.queued { border-left: 3px solid #d29922; }
  .agent-top { display: flex; justify-content: space-between; align-items: center; }
  .agent-issue { color: #58a6ff; font-weight: bold; font-size: 14px; }
  .agent-title { color: #c9d1d9; margin-left: 10px; }
  .agent-right { display: flex; gap: 10px; align-items: center; }
  .pill {
    padding: 3px 10px; border-radius: 12px;
    font-size: 11px; color: #fff; font-weight: 500;
  }
  .pill-progress { background: #1f6feb; }
  .pill-queued { background: #9e6a03; }
  .pill-linear { background: #30363d; color: #c9d1d9; }
  .agent-duration { color: #ffd54f; font-family: 'Cascadia Code', 'Fira Code', monospace; }
  .agent-meta { color: #8b949e; font-size: 12px; margin-top: 6px; }
  .agent-meta span { color: #c9d1d9; }
  .empty-state { color: #8b949e; font-style: italic; padding: 16px 0; }
  .history { margin-bottom: 24px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  thead tr { border-bottom: 1px solid #30363d; color: #8b949e; text-align: left; }
  th { padding: 8px 12px 8px 0; font-weight: 500; }
  td { padding: 8px 12px 8px 0; }
  tbody tr { border-bottom: 1px solid #21262d; }
  .status-success { color: #3fb950; }
  .status-failed { color: #f85149; }
  .issue-link { color: #58a6ff; text-decoration: none; }
  .issue-link:hover { text-decoration: underline; }
  .pr-link { color: #58a6ff; text-decoration: none; }
  .pr-link:hover { text-decoration: underline; }
  .pr-none { color: #8b949e; }
  .duration { font-family: 'Cascadia Code', 'Fira Code', monospace; color: #ffd54f; position: relative; }
  .duration-bar {
    position: absolute; top: 4px; left: 0; bottom: 4px;
    background: rgba(255, 213, 79, 0.15); border-radius: 3px;
    pointer-events: none;
  }
  .duration-text { position: relative; z-index: 1; }
  .when { color: #8b949e; }
  .check { font-size: 16px; }
  .footer { color: #8b949e; font-size: 12px; padding-top: 16px; border-top: 1px solid #21262d; }
  .gantt-panel { margin-bottom: 24px; }
  .gantt-chart {
    background: #161b22; border: 1px solid #30363d; border-radius: 10px;
    padding: 16px; overflow-x: auto;
  }
  .gantt-axis {
    display: flex; justify-content: space-between;
    color: #8b949e; font-size: 11px; padding: 0 0 8px 120px;
    border-bottom: 1px solid #21262d; margin-bottom: 8px;
  }
  .gantt-rows { min-width: 600px; }
  .gantt-row {
    display: flex; align-items: center; padding: 4px 0;
    border-bottom: 1px solid #161b22;
  }
  .gantt-row:hover { background: rgba(88, 166, 255, 0.04); }
  .gantt-label {
    width: 120px; min-width: 120px; font-size: 12px;
    color: #58a6ff; font-weight: 500; padding-right: 8px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .gantt-track {
    flex: 1; position: relative; height: 22px;
    background: rgba(48, 54, 61, 0.3); border-radius: 3px;
  }
  .gantt-bar {
    position: absolute; top: 2px; bottom: 2px; border-radius: 3px;
    min-width: 4px; cursor: default; transition: opacity 0.2s;
  }
  .gantt-bar:hover { opacity: 0.85; }
  .gantt-bar-text {
    position: absolute; left: 6px; top: 50%; transform: translateY(-50%);
    font-size: 10px; color: #fff; white-space: nowrap;
    pointer-events: none; text-shadow: 0 1px 2px rgba(0,0,0,0.5);
  }
  .gantt-legend {
    display: flex; gap: 16px; margin-top: 12px; padding-top: 8px;
    border-top: 1px solid #21262d;
  }
  .gantt-legend-item { display: flex; align-items: center; gap: 6px; font-size: 11px; color: #8b949e; }
  .gantt-legend-dot { width: 10px; height: 10px; border-radius: 2px; }
  .gantt-empty { color: #8b949e; font-style: italic; padding: 16px; text-align: center; }
  @media (max-width: 768px) {
    .gauges { flex-wrap: wrap; }
    .gauge { flex: 1 1 45%; min-width: 140px; }
    table { display: block; overflow-x: auto; }
    .agent-top { flex-direction: column; align-items: flex-start; gap: 8px; }
    .agent-right { flex-wrap: wrap; }
    .gantt-label { width: 80px; min-width: 80px; font-size: 11px; }
    .gantt-axis { padding-left: 80px; }
    .gantt-bar-text { display: none; }
  }
</style>
</head>
<body>
<header>
  <h1>Agent Control Center</h1>
  <div class="header-right">
    <span id="build-time"></span>
    <span><span class="refresh-dot">&#9679;</span> Auto-refresh: 60s</span>
  </div>
</header>
<div class="container">
  <div class="gauges" id="gauges"></div>
  <div id="runner-health"></div>
  <div id="recovery-panel"></div>
  <div class="agents">
    <div class="section-label">Active Agents</div>
    <div id="agents-list"></div>
  </div>
  <div class="history">
    <div class="section-label">Recent Runs</div>
    <div id="history-table"></div>
  </div>
  <div class="gantt-panel">
    <div class="section-label">Workflow Timeline</div>
    <div id="gantt-chart"></div>
  </div>
  <div class="footer" id="footer"></div>
</div>
<script>
var DASHBOARD_DATA = ${dataJson};

function escapeHtml(str) {
  var div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

function renderLinearPill(status) {
  if (!status) return '';
  return ' <span class="pill pill-linear">' + escapeHtml(status) + '</span>';
}

function renderGauges(g) {
  return '<div class="gauge gauge-running"><div class="gauge-value">' + g.running + '</div><div class="gauge-label">Running</div></div>'
    + '<div class="gauge gauge-succeeded"><div class="gauge-value">' + g.totalSucceeded + '</div><div class="gauge-label">Succeeded</div><div class="gauge-sub">' + g.succeeded + ' today</div></div>'
    + '<div class="gauge gauge-failed"><div class="gauge-value">' + g.totalFailed + '</div><div class="gauge-label">Failed</div><div class="gauge-sub">' + g.failed + ' today</div></div>'
    + '<div class="gauge gauge-quota"><div class="gauge-value">' + g.dailyUsed + '/' + g.dailyLimit + '</div><div class="gauge-label">Daily Quota</div></div>';
}

function renderAgents(agents) {
  if (!agents.length) return '<div class="empty-state">No agents currently running</div>';
  return agents.map(function(a) {
    var cls = a.status === 'In Progress' ? 'in-progress' : 'queued';
    var pillCls = a.status === 'In Progress' ? 'pill-progress' : 'pill-queued';
    return '<div class="agent-card ' + cls + '">'
      + '<div class="agent-top"><div>'
      + '<span class="agent-issue">' + escapeHtml(a.issueId) + '</span>'
      + '<span class="agent-title">' + escapeHtml(a.issueTitle) + '</span>'
      + '</div><div class="agent-right">'
      + '<span class="pill ' + pillCls + '">' + escapeHtml(a.status) + '</span>'
      + renderLinearPill(a.linearStatus)
      + '<span class="agent-duration">' + escapeHtml(a.duration) + '</span>'
      + '</div></div>'
      + '<div class="agent-meta">Runner: <span>' + escapeHtml(a.runner) + '</span>'
      + ' | Branch: <span>' + escapeHtml(a.branch) + '</span></div></div>';
  }).join('');
}

function renderHistory(history) {
  if (!history.length) return '<div class="empty-state">No agent runs yet</div>';
  var maxMs = Math.max.apply(null, history.map(function(h) { return h.durationMs || 0; }).concat([1]));
  var rows = history.map(function(h) {
    var statusIcon = h.success
      ? '<span class="check status-success">&#10003;</span> <span class="status-success">Success</span>'
      : '<span class="check status-failed">&#10007;</span> <span class="status-failed">Failed</span>';
    var prCell = h.prNumber
      ? '<a class="pr-link" href="' + escapeHtml(h.prUrl) + '" target="_blank">#' + h.prNumber + '</a>'
      : '<span class="pr-none">&mdash;</span>';
    var pct = maxMs > 0 ? Math.round(((h.durationMs || 0) / maxMs) * 100) : 0;
    return '<tr><td>' + statusIcon + '</td><td class="issue-link">' + escapeHtml(h.issueId) + '</td>'
      + '<td>' + escapeHtml(h.issueTitle) + '</td><td>' + prCell + '</td>'
      + '<td class="duration"><div class="duration-bar" style="width:' + pct + '%"></div><span class="duration-text">' + escapeHtml(h.duration) + '</span></td>'
      + '<td class="when">' + escapeHtml(h.when) + '</td></tr>';
  }).join('');
  return '<table><thead><tr><th>Status</th><th>Issue</th><th>Title</th><th>PR</th><th>Duration</th><th>When</th></tr></thead><tbody>' + rows + '</tbody></table>';
}

function renderRunnerHealth(h) {
  if (!h) return '';
  var statusColor = h.runner.status === 'online' ? 'status-online'
    : h.runner.status === 'busy' ? 'status-busy'
    : h.runner.status === 'offline' ? 'status-offline' : 'status-unknown';
  var quotaTrend = h.quotaTrend.trend === 'up' ? '<span class="health-trend trend-down">&#8593;</span>'
    : h.quotaTrend.trend === 'down' ? '<span class="health-trend trend-up">&#8595;</span>'
    : '<span class="health-trend trend-flat">&#8594;</span>';
  var rateColor = h.successRate.rate >= 80 ? 'status-online'
    : h.successRate.rate >= 50 ? 'status-busy' : 'status-offline';
  var rateTrend = h.successRate.trend === 'up' ? '<span class="health-trend trend-up">&#8593;</span>'
    : h.successRate.trend === 'down' ? '<span class="health-trend trend-down">&#8595;</span>'
    : '<span class="health-trend trend-flat">&#8594;</span>';
  var incidentStr = h.daysSinceIncident.days === null ? 'N/A'
    : h.daysSinceIncident.days === 0 ? 'TODAY' : String(h.daysSinceIncident.days);
  var incidentColor = h.daysSinceIncident.days === null ? 'status-online'
    : h.daysSinceIncident.days === 0 ? 'status-offline' : 'status-online';
  var runnerCard = h.runner.status !== 'unknown'
    ? '<div class="health-card"><div class="health-value ' + statusColor + '">' + escapeHtml(h.runner.status.toUpperCase()) + '</div><div class="health-label">Runner</div></div>'
    : '<div class="health-card"><div class="health-value status-unknown">N/A</div><div class="health-label">Runner</div><div class="health-sub">needs admin token</div></div>';
  return '<div class="runner-health"><div class="section-label">Runner Health</div><div class="health-cards">'
    + runnerCard
    + '<div class="health-card"><div class="health-value" style="color:#d29922">' + h.quotaTrend.today + quotaTrend + '</div><div class="health-label">Quota (24h)</div><div class="health-sub">yesterday: ' + h.quotaTrend.yesterday + '</div></div>'
    + '<div class="health-card"><div class="health-value" style="color:#ffd54f">' + escapeHtml(h.avgDuration.avgFormatted) + '</div><div class="health-label">Avg Duration</div><div class="health-sub">' + h.avgDuration.sampleSize + ' runs (7d)</div></div>'
    + '<div class="health-card"><div class="health-value ' + rateColor + '">' + h.successRate.rate + '%' + rateTrend + '</div><div class="health-label">Success Rate</div><div class="health-sub">' + h.successRate.currentWindow.succeeded + '/' + h.successRate.currentWindow.total + ' (7d)</div></div>'
    + '<div class="health-card"><div class="health-value ' + incidentColor + '">' + incidentStr + '</div><div class="health-label">Days Since Incident</div><div class="health-sub">Level 3 escalations</div></div>'
    + '</div></div>';
}

var LEVEL_META = {
  1: { label: 'Level 1', desc: 'Auto-fix', color: '#d29922' },
  2: { label: 'Level 2', desc: 'Kill + Retry', color: '#f0883e' },
  3: { label: 'Level 3', desc: 'Halt + Incident', color: '#f85149' },
};

function renderRecoveryPanel(recovery) {
  if (!recovery) return '';
  var levels = recovery.levels;
  var total = levels[1].allTime + levels[2].allTime + levels[3].allTime;
  if (total === 0) return '';
  var alert = recovery.hasLevel3Today
    ? '<div class="recovery-alert-banner">&#9888; Level 3 incidents detected today</div>' : '';
  var cards = [1,2,3].map(function(lvl) {
    var m = LEVEL_META[lvl]; var d = levels[lvl];
    var ac = lvl === 3 && d.today > 0 ? ' level-3-active' : '';
    return '<div class="recovery-card' + ac + '" onclick="toggleRecoveryDetail(' + lvl + ')">'
      + '<div class="recovery-value" style="color:' + m.color + '">' + d.allTime + '</div>'
      + '<div class="recovery-label" style="color:' + m.color + '">' + escapeHtml(m.label) + '</div>'
      + '<div class="recovery-sublabel">' + escapeHtml(m.desc) + '</div>'
      + '<div class="recovery-today">' + d.today + ' today</div></div>';
  }).join('');
  var details = [1,2,3].map(function(lvl) {
    var m = LEVEL_META[lvl]; var d = levels[lvl];
    if (!d.events.length) return '<div class="recovery-detail" id="recovery-detail-' + lvl + '"><div class="recovery-detail-header">' + escapeHtml(m.label) + ' Events</div><div style="color:#8b949e;font-style:italic">No events</div></div>';
    var rows = d.events.slice(0,10).map(function(e) {
      return '<div class="recovery-event"><div><span class="recovery-event-issue">' + escapeHtml(e.issueId || '') + '</span> ' + escapeHtml(e.issueTitle || '') + '</div><div class="recovery-event-time">' + (e.timestamp ? new Date(e.timestamp).toLocaleString() : '') + '</div></div>';
    }).join('');
    return '<div class="recovery-detail" id="recovery-detail-' + lvl + '"><div class="recovery-detail-header">' + escapeHtml(m.label) + ' Events (' + d.events.length + ')</div>' + rows + '</div>';
  }).join('');
  return '<div class="recovery-panel"><div class="section-label">Recovery Levels</div>' + alert + '<div class="recovery-cards">' + cards + '</div>' + details + '</div>';
}

function toggleRecoveryDetail(level) {
  var el = document.getElementById('recovery-detail-' + level);
  if (el) el.classList.toggle('open');
}

function renderGanttChart(gantt) {
  if (!gantt || !gantt.bars || gantt.bars.length === 0) {
    return '<div class="gantt-empty">No workflow runs to display</div>';
  }
  var bars = gantt.bars;
  var minTime = gantt.minTime;
  var maxTime = gantt.maxTime;
  var range = maxTime - minTime || 1;

  var axisCount = 5;
  var axisLabels = [];
  for (var i = 0; i < axisCount; i++) {
    var t = minTime + (range * i / (axisCount - 1));
    var d = new Date(t);
    axisLabels.push(d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
  }
  var axisHtml = '<div class="gantt-axis">' + axisLabels.map(function(l) {
    return '<span>' + escapeHtml(l) + '</span>';
  }).join('') + '</div>';

  var rowsHtml = bars.map(function(bar) {
    var leftPct = Math.max(0, ((bar.startMs - minTime) / range) * 100);
    var widthPct = Math.max(0.5, ((bar.endMs - bar.startMs) / range) * 100);
    var barTitle = escapeHtml(bar.issueId + ': ' + bar.issueTitle + ' (' + bar.duration + ')');
    var textHtml = widthPct > 8
      ? '<span class="gantt-bar-text">' + escapeHtml(bar.duration) + '</span>'
      : '';
    return '<div class="gantt-row">'
      + '<div class="gantt-label" title="' + escapeHtml(bar.issueTitle) + '">' + escapeHtml(bar.issueId) + '</div>'
      + '<div class="gantt-track">'
      + '<div class="gantt-bar" style="left:' + leftPct.toFixed(2) + '%;width:' + widthPct.toFixed(2) + '%;background:' + bar.color + '" title="' + barTitle + '">'
      + textHtml
      + '</div></div></div>';
  }).join('');

  var legendItems = [
    { color: '#3fb950', label: 'Success' },
    { color: '#f85149', label: 'Failed' },
    { color: '#58a6ff', label: 'In Progress' },
    { color: '#d29922', label: 'Queued' },
  ];
  var legendHtml = '<div class="gantt-legend">' + legendItems.map(function(item) {
    return '<div class="gantt-legend-item"><div class="gantt-legend-dot" style="background:' + item.color + '"></div>' + item.label + '</div>';
  }).join('') + '</div>';

  return '<div class="gantt-chart">' + axisHtml + '<div class="gantt-rows">' + rowsHtml + '</div>' + legendHtml + '</div>';
}

document.getElementById('gauges').innerHTML = renderGauges(DASHBOARD_DATA.gauges);
document.getElementById('runner-health').innerHTML = renderRunnerHealth(DASHBOARD_DATA.runnerHealth);
document.getElementById('recovery-panel').innerHTML = renderRecoveryPanel(DASHBOARD_DATA.recoveryLevels);
document.getElementById('agents-list').innerHTML = renderAgents(DASHBOARD_DATA.activeAgents);
document.getElementById('history-table').innerHTML = renderHistory(DASHBOARD_DATA.history);
document.getElementById('gantt-chart').innerHTML = renderGanttChart(DASHBOARD_DATA.gantt);
document.getElementById('build-time').textContent = 'Built: ' + new Date(DASHBOARD_DATA.buildTime).toLocaleString();
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const { out } = parseArgs(process.argv.slice(2));
  const repo = process.env.GITHUB_REPOSITORY || "danielvaucrosson/AI-Agent-Orchestration";
  const repoUrl = getRepoUrl();

  console.log(`Fetching workflow runs for ${repo}...`);
  const runs = await fetchWorkflowRuns(repo);
  console.log(`  ${runs.length} runs found`);

  console.log("Fetching recent PRs...");
  const prs = await fetchRecentPRs(repo);
  console.log(`  ${prs.length} PRs found`);

  console.log("Fetching runner data...");
  const runnerData = await fetchRunnerData(repo);
  console.log(`  ${runnerData.runners.length} runner(s) found`);

  const recoveryEvents = readRecoveryEvents();
  console.log(`  ${recoveryEvents.length} recovery event(s) found`);

  console.log("Building dashboard data (with Linear enrichment)...");
  const data = await buildStaticData(runs, prs, { repoUrl, recoveryEvents, runnerData });

  console.log("Generating static HTML...");
  const html = generateStaticHTML(data);

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html, "utf8");
  console.log(
    `Dashboard written to ${out} (${(html.length / 1024).toFixed(1)} KB)`
  );
}
