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
import { buildDashboardData, extractRunInfo } from "./agent-dashboard.mjs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WORKFLOW_FILE = "agent-worker.yml";

function getRepoUrl() {
  const repo = process.env.GITHUB_REPOSITORY; // "owner/repo"
  return repo
    ? `https://github.com/${repo}`
    : "https://github.com/danielvaucrosson/Test";
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
  { repoUrl, fetchStatusFn = fetchLinearStatus } = {}
) {
  const raw = { runs, prs };
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
  .section-label {
    color: #8b949e; font-size: 12px;
    text-transform: uppercase; letter-spacing: 1px;
    margin-bottom: 10px;
  }
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
  .duration { font-family: 'Cascadia Code', 'Fira Code', monospace; color: #ffd54f; }
  .when { color: #8b949e; }
  .check { font-size: 16px; }
  .footer { color: #8b949e; font-size: 12px; padding-top: 16px; border-top: 1px solid #21262d; }
  @media (max-width: 768px) {
    .gauges { flex-wrap: wrap; }
    .gauge { flex: 1 1 45%; min-width: 140px; }
    table { display: block; overflow-x: auto; }
    .agent-top { flex-direction: column; align-items: flex-start; gap: 8px; }
    .agent-right { flex-wrap: wrap; }
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
  <div class="agents">
    <div class="section-label">Active Agents</div>
    <div id="agents-list"></div>
  </div>
  <div class="history">
    <div class="section-label">Recent Runs</div>
    <div id="history-table"></div>
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
  var rows = history.map(function(h) {
    var statusIcon = h.success
      ? '<span class="check status-success">&#10003;</span> <span class="status-success">Success</span>'
      : '<span class="check status-failed">&#10007;</span> <span class="status-failed">Failed</span>';
    var prCell = h.prNumber
      ? '<a class="pr-link" href="' + escapeHtml(h.prUrl) + '" target="_blank">#' + h.prNumber + '</a>'
      : '<span class="pr-none">&mdash;</span>';
    return '<tr><td>' + statusIcon + '</td><td class="issue-link">' + escapeHtml(h.issueId) + '</td>'
      + '<td>' + escapeHtml(h.issueTitle) + '</td><td>' + prCell + '</td>'
      + '<td class="duration">' + escapeHtml(h.duration) + '</td>'
      + '<td class="when">' + escapeHtml(h.when) + '</td></tr>';
  }).join('');
  return '<table><thead><tr><th>Status</th><th>Issue</th><th>Title</th><th>PR</th><th>Duration</th><th>When</th></tr></thead><tbody>' + rows + '</tbody></table>';
}

document.getElementById('gauges').innerHTML = renderGauges(DASHBOARD_DATA.gauges);
document.getElementById('agents-list').innerHTML = renderAgents(DASHBOARD_DATA.activeAgents);
document.getElementById('history-table').innerHTML = renderHistory(DASHBOARD_DATA.history);
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
  const repo = process.env.GITHUB_REPOSITORY || "danielvaucrosson/Test";
  const repoUrl = getRepoUrl();

  console.log(`Fetching workflow runs for ${repo}...`);
  const runs = await fetchWorkflowRuns(repo);
  console.log(`  ${runs.length} runs found`);

  console.log("Fetching recent PRs...");
  const prs = await fetchRecentPRs(repo);
  console.log(`  ${prs.length} PRs found`);

  console.log("Building dashboard data (with Linear enrichment)...");
  const data = await buildStaticData(runs, prs, { repoUrl });

  console.log("Generating static HTML...");
  const html = generateStaticHTML(data);

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html, "utf8");
  console.log(
    `Dashboard written to ${out} (${(html.length / 1024).toFixed(1)} KB)`
  );
}
