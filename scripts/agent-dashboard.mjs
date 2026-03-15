/**
 * Agent Dashboard — CLI + Web observability for agent workflow runs.
 *
 * Usage: node scripts/agent-dashboard.mjs          (CLI live terminal display)
 *        node scripts/agent-dashboard.mjs --once   (single render, exit)
 *        node scripts/agent-dashboard.mjs --web    (starts HTTP server + CLI)
 *
 * Requires: GITHUB_TOKEN env var (or gh CLI authentication)
 */

import { createServer } from "node:http";
import { execSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WORKFLOW_FILE = "agent-worker.yml";
const REFRESH_INTERVAL_MS = 10_000;
const MAX_COMPLETIONS = 5;
const MAX_HISTORY = 20;
const DEFAULT_DAILY_LIMIT = 2;

/**
 * Read the daily task limit from AGENT_MAX_DAILY_RUNS env var,
 * matching the same setting used by the agent scheduler workflow.
 * Falls back to DEFAULT_DAILY_LIMIT (2) when unset.
 */
function getDailyLimit() {
  const envVal = process.env.AGENT_MAX_DAILY_RUNS;
  if (envVal) {
    const parsed = parseInt(envVal, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_DAILY_LIMIT;
}
const REPO_URL = process.env.GITHUB_REPOSITORY
  ? `https://github.com/${process.env.GITHUB_REPOSITORY}`
  : "https://github.com/danielvaucrosson/AI-Agent-Orchestration";

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  orange: "\x1b[38;5;208m",
  white: "\x1b[37m",
  bgGreen: "\x1b[42m",
  bgRed: "\x1b[41m",
};

// ---------------------------------------------------------------------------
// Pure functions (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Categorize workflow runs into active (in_progress/queued) and completed.
 *
 * @param {object[]} runs - Workflow run objects from GitHub API
 * @returns {{ active: object[], completed: object[] }}
 */
export function categorizeRuns(runs) {
  const active = [];
  const completed = [];

  for (const run of runs) {
    const status = run.status;
    if (status === "in_progress" || status === "queued") {
      active.push(run);
    } else if (status === "completed") {
      completed.push(run);
    }
  }

  return { active, completed };
}

/**
 * Extract issue ID and title from a workflow run's dispatch inputs or name.
 *
 * @param {object} run - A GitHub Actions workflow run object
 * @returns {{ issueId: string, issueTitle: string }}
 */
export function extractRunInfo(run) {
  const issueId =
    run.inputs?.issue_id ||
    run.name?.match(/\b([A-Z]{1,5}-\d+)\b/)?.[1] ||
    run.display_title?.match(/\b([A-Z]{1,5}-\d+)\b/)?.[1] ||
    "unknown";

  const issueTitle =
    run.inputs?.issue_title ||
    run.display_title ||
    run.name ||
    "";

  return { issueId, issueTitle };
}

/**
 * Format elapsed duration from a start time ISO string to now.
 *
 * @param {string} startedAt - ISO 8601 timestamp
 * @returns {string} e.g., "5m 23s"
 */
export function formatDuration(startedAt) {
  if (!startedAt) return "0m 0s";
  const ms = Date.now() - new Date(startedAt).getTime();
  if (isNaN(ms) || ms < 0) return "0m 0s";
  const totalSecs = Math.floor(ms / 1000);
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  return `${mins}m ${secs}s`;
}

/**
 * Format a completed duration from start and end timestamps.
 *
 * @param {string} startedAt - ISO 8601 timestamp
 * @param {string} updatedAt - ISO 8601 timestamp
 * @returns {string} e.g., "6m 0s"
 */
export function formatCompletedDuration(startedAt, updatedAt) {
  if (!startedAt || !updatedAt) return "?";
  const ms = new Date(updatedAt).getTime() - new Date(startedAt).getTime();
  if (isNaN(ms) || ms < 0) return "?";
  const totalSecs = Math.floor(ms / 1000);
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  return `${mins}m ${secs}s`;
}

/**
 * Count runs from the last 24 hours (for daily limit tracking).
 *
 * @param {object[]} runs - All workflow runs
 * @returns {number}
 */
export function countDailyRuns(runs) {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  return runs.filter((r) => new Date(r.created_at).getTime() > cutoff).length;
}

/**
 * Match completed runs to PRs by issue ID.
 *
 * @param {object[]} completedRuns - Completed workflow runs
 * @param {object[]} prs - PR objects with { number, title, headRefName }
 * @returns {Map<number, object>} Map of run.id -> PR info
 */
export function matchRunsToPRs(completedRuns, prs) {
  const result = new Map();
  const issueRe = /\b([A-Z]{1,5}-\d+)\b/;

  for (const run of completedRuns) {
    const { issueId } = extractRunInfo(run);
    if (issueId === "unknown") continue;

    const matchingPr = prs.find((pr) => {
      const titleMatch = pr.title?.match(issueRe);
      const branchMatch = pr.headRefName?.match(issueRe);
      return (
        titleMatch?.[1] === issueId || branchMatch?.[1] === issueId
      );
    });

    if (matchingPr) {
      result.set(run.id, { number: matchingPr.number, title: matchingPr.title });
    }
  }

  return result;
}

/**
 * Format a timestamp as relative time (e.g., "5 min ago", "2h ago").
 *
 * @param {string} timestamp - ISO 8601 timestamp
 * @returns {string}
 */
export function formatRelativeTime(timestamp) {
  if (!timestamp) return "";
  const ms = Date.now() - new Date(timestamp).getTime();
  if (isNaN(ms) || ms < 0) return "just now";
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Build structured dashboard data from raw API results.
 * Used by both CLI renderer and web API endpoint.
 *
 * @param {object} raw
 * @param {object[]} raw.runs - Workflow run objects
 * @param {object[]} raw.prs - PR objects
 * @returns {object} Structured dashboard data
 */
export function buildDashboardData(raw) {
  const { runs, prs } = raw;
  const { active, completed } = categorizeRuns(runs);
  const prMap = matchRunsToPRs(completed, prs);
  const dailyCount = countDailyRuns(runs);

  const runningCount = active.filter((r) => r.status === "in_progress").length;
  const totalSucceeded = completed.filter((r) => r.conclusion === "success").length;
  const totalFailed = completed.filter((r) => r.conclusion === "failure").length;
  const succeededToday = completed.filter((r) => {
    const inLast24h =
      Date.now() - new Date(r.created_at).getTime() < 24 * 60 * 60 * 1000;
    return inLast24h && r.conclusion === "success";
  }).length;
  const failedToday = completed.filter((r) => {
    const inLast24h =
      Date.now() - new Date(r.created_at).getTime() < 24 * 60 * 60 * 1000;
    return inLast24h && r.conclusion === "failure";
  }).length;

  const activeAgents = active.map((run) => {
    const { issueId, issueTitle } = extractRunInfo(run);
    return {
      issueId,
      issueTitle,
      status: run.status === "in_progress" ? "In Progress" : "Queued",
      duration: formatDuration(run.run_started_at || run.created_at),
      startedAt: run.run_started_at || run.created_at,
      runner: run.runner_name || "unknown",
      branch: run.head_branch || "",
    };
  });

  const history = completed.slice(0, MAX_HISTORY).map((run) => {
    const { issueId, issueTitle } = extractRunInfo(run);
    const prInfo = prMap.get(run.id);
    return {
      issueId,
      issueTitle,
      success: run.conclusion === "success",
      prNumber: prInfo?.number || null,
      prUrl: prInfo ? `${REPO_URL}/pull/${prInfo.number}` : null,
      duration: formatCompletedDuration(
        run.run_started_at || run.created_at,
        run.updated_at
      ),
      when: formatRelativeTime(run.updated_at),
      updatedAt: run.updated_at,
    };
  });

  return {
    gauges: {
      running: runningCount,
      succeeded: succeededToday,
      failed: failedToday,
      totalSucceeded,
      totalFailed,
      dailyUsed: dailyCount,
      dailyLimit: getDailyLimit(),
    },
    activeAgents,
    history,
    // Keep raw references for CLI renderer
    _active: active,
    _completed: completed,
    _prMap: prMap,
    _dailyCount: dailyCount,
  };
}

/**
 * Render the CLI dashboard output string from processed data.
 *
 * @param {object} data - Dashboard data from buildDashboardData
 * @param {object} [opts] - Options
 * @param {string} [opts.webUrl] - Web dashboard URL to display
 * @returns {string} ANSI-formatted terminal output
 */
export function renderDashboard(data, opts = {}) {
  const lines = [];

  // Header
  lines.push(
    `${C.cyan}${C.bold}  AGENT DASHBOARD  ${"─".repeat(42)}${C.reset}`
  );
  lines.push("");

  // Running gauge
  const runningCount = data._active
    ? data._active.filter((r) => r.status === "in_progress").length
    : data.active?.filter((r) => r.status === "in_progress").length ?? 0;
  const dailyLimit = data.gauges?.dailyLimit ?? data.dailyLimit ?? getDailyLimit();
  const dailyCount = data._dailyCount ?? data.dailyCount;
  const totalSucceeded = data.gauges?.totalSucceeded ?? 0;
  const totalFailed = data.gauges?.totalFailed ?? 0;
  lines.push(
    `${C.green}RUNNING:${C.reset} ${C.bgGreen}${C.bold} ${runningCount} ${C.reset} / ${dailyLimit} daily` +
      `${C.dim}    Used today: ${dailyCount}${C.reset}`
  );
  lines.push(
    `${C.green}TOTAL:${C.reset}   ${C.green}${totalSucceeded} succeeded${C.reset}  ${C.red}${totalFailed} failed${C.reset}`
  );
  lines.push("");

  // Active agents
  const activeRuns = data._active || data.active || [];
  if (activeRuns.length === 0) {
    lines.push(`${C.dim}  No agents currently running${C.reset}`);
  } else {
    for (const run of activeRuns) {
      const { issueId, issueTitle } = extractRunInfo(run);
      const isRunning = run.status === "in_progress";
      const dot = isRunning
        ? `${C.green}●${C.reset}`
        : `${C.orange}●${C.reset}`;
      const duration = formatDuration(run.run_started_at || run.created_at);
      const statusTag = isRunning ? "" : ` ${C.dim}(queued)${C.reset}`;
      const titleStr =
        issueTitle.length > 40
          ? issueTitle.slice(0, 37) + "..."
          : issueTitle;
      lines.push(
        `${dot} ${C.cyan}${issueId}${C.reset} ${titleStr}${" ".repeat(Math.max(1, 42 - issueId.length - titleStr.length))}${C.yellow}${duration}${C.reset}${statusTag}`
      );
    }
  }

  // Recent completions
  lines.push("");
  lines.push(`${C.dim}${"─".repeat(62)}${C.reset}`);
  lines.push(`${C.green}RECENT COMPLETIONS${C.reset}`);

  const completedRuns = data._completed || data.completed || [];
  const prMap = data._prMap || data.prMap || new Map();
  const recent = completedRuns.slice(0, MAX_COMPLETIONS);
  if (recent.length === 0) {
    lines.push(`${C.dim}  No recent completions${C.reset}`);
  } else {
    for (const run of recent) {
      const { issueId, issueTitle } = extractRunInfo(run);
      const ok = run.conclusion === "success";
      const statusStr = ok
        ? `${C.green}OK  ${C.reset}`
        : `${C.red}FAIL${C.reset}`;
      const prInfo = prMap.get(run.id);
      const prStr = prInfo
        ? `${C.cyan}PR #${prInfo.number}${C.reset}`
        : `${C.dim}no PR${C.reset}`;
      const duration = formatCompletedDuration(
        run.run_started_at || run.created_at,
        run.updated_at
      );
      const titleShort =
        issueTitle.length > 30
          ? issueTitle.slice(0, 27) + "..."
          : issueTitle;
      lines.push(
        `${statusStr} ${issueId} ${titleShort} ${"─".repeat(Math.max(1, 30 - issueId.length - titleShort.length))} ${prStr}  ${C.yellow}${duration}${C.reset}`
      );
    }
  }

  // Footer
  lines.push("");
  if (opts.webUrl) {
    lines.push(`${C.dim}Web: ${C.cyan}${opts.webUrl}${C.reset}`);
  }
  lines.push(
    `${C.dim}Auto-refresh: 10s | q = quit | r = refresh now${C.reset}`
  );

  return lines.join("\n");
}

/**
 * Generate the self-contained HTML dashboard page.
 * All CSS is inline — no external dependencies.
 *
 * @returns {string} Complete HTML document
 */
export function generateDashboardHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
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

  /* Gauge cards */
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

  /* Section headers */
  .section-label {
    color: #8b949e; font-size: 12px;
    text-transform: uppercase; letter-spacing: 1px;
    margin-bottom: 10px;
  }

  /* Agent cards */
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
  .agent-duration { color: #ffd54f; font-family: 'Cascadia Code', 'Fira Code', monospace; }
  .agent-meta { color: #8b949e; font-size: 12px; margin-top: 6px; }
  .agent-meta span { color: #c9d1d9; }
  .empty-state { color: #8b949e; font-style: italic; padding: 16px 0; }

  /* History table */
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
</style>
</head>
<body>
<header>
  <h1>Agent Control Center</h1>
  <div class="header-right">
    <span id="last-update"></span>
    <span><span class="refresh-dot">&#9679;</span> Auto-refresh: 10s</span>
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
</div>
<script>
const REPO_URL = ${JSON.stringify(REPO_URL)};

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function renderGauges(g) {
  return \`
    <div class="gauge gauge-running">
      <div class="gauge-value">\${g.running}</div>
      <div class="gauge-label">Running</div>
    </div>
    <div class="gauge gauge-succeeded">
      <div class="gauge-value">\${g.totalSucceeded}</div>
      <div class="gauge-label">Succeeded</div>
      <div class="gauge-sub">\${g.succeeded} today</div>
    </div>
    <div class="gauge gauge-failed">
      <div class="gauge-value">\${g.totalFailed}</div>
      <div class="gauge-label">Failed</div>
      <div class="gauge-sub">\${g.failed} today</div>
    </div>
    <div class="gauge gauge-quota">
      <div class="gauge-value">\${g.dailyUsed}/\${g.dailyLimit}</div>
      <div class="gauge-label">Daily Quota</div>
    </div>
  \`;
}

function renderAgents(agents) {
  if (!agents.length) return '<div class="empty-state">No agents currently running</div>';
  return agents.map(a => {
    const cls = a.status === 'In Progress' ? 'in-progress' : 'queued';
    const pillCls = a.status === 'In Progress' ? 'pill-progress' : 'pill-queued';
    return \`
      <div class="agent-card \${cls}">
        <div class="agent-top">
          <div>
            <span class="agent-issue">\${escapeHtml(a.issueId)}</span>
            <span class="agent-title">\${escapeHtml(a.issueTitle)}</span>
          </div>
          <div class="agent-right">
            <span class="pill \${pillCls}">\${escapeHtml(a.status)}</span>
            <span class="agent-duration">\${escapeHtml(a.duration)}</span>
          </div>
        </div>
        <div class="agent-meta">
          Runner: <span>\${escapeHtml(a.runner)}</span>
          &nbsp;|&nbsp; Branch: <span>\${escapeHtml(a.branch)}</span>
        </div>
      </div>
    \`;
  }).join('');
}

function renderHistory(history) {
  if (!history.length) return '<div class="empty-state">No recent runs</div>';
  const rows = history.map(h => {
    const statusIcon = h.success
      ? '<span class="check status-success">&#10003;</span> <span class="status-success">Success</span>'
      : '<span class="check status-failed">&#10007;</span> <span class="status-failed">Failed</span>';
    const prCell = h.prNumber
      ? \`<a class="pr-link" href="\${escapeHtml(h.prUrl)}" target="_blank">#\${h.prNumber}</a>\`
      : '<span class="pr-none">&mdash;</span>';
    return \`
      <tr>
        <td>\${statusIcon}</td>
        <td class="issue-link">\${escapeHtml(h.issueId)}</td>
        <td>\${escapeHtml(h.issueTitle)}</td>
        <td>\${prCell}</td>
        <td class="duration">\${escapeHtml(h.duration)}</td>
        <td class="when">\${escapeHtml(h.when)}</td>
      </tr>
    \`;
  }).join('');
  return \`
    <table>
      <thead><tr><th>Status</th><th>Issue</th><th>Title</th><th>PR</th><th>Duration</th><th>When</th></tr></thead>
      <tbody>\${rows}</tbody>
    </table>
  \`;
}

async function refresh() {
  try {
    const res = await fetch('/api/status');
    if (!res.ok) throw new Error('API error');
    const data = await res.json();
    document.getElementById('gauges').innerHTML = renderGauges(data.gauges);
    document.getElementById('agents-list').innerHTML = renderAgents(data.activeAgents);
    document.getElementById('history-table').innerHTML = renderHistory(data.history);
    document.getElementById('last-update').textContent =
      'Updated: ' + new Date().toLocaleTimeString();
  } catch (err) {
    console.error('Refresh failed:', err);
  }
}

refresh();
setInterval(refresh, 10000);
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Data fetchers (side-effectful, not exported)
// ---------------------------------------------------------------------------

function ghApi(endpoint) {
  try {
    const output = execSync(`gh api "${endpoint}"`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return JSON.parse(output);
  } catch {
    return null;
  }
}

function fetchWorkflowRuns() {
  const data = ghApi(
    `/repos/{owner}/{repo}/actions/workflows/${WORKFLOW_FILE}/runs?per_page=30`
  );
  return data?.workflow_runs || [];
}

function fetchRecentPRs() {
  try {
    const output = execSync(
      "gh pr list --state all --json number,title,headRefName --limit 30",
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
    );
    return JSON.parse(output);
  } catch {
    return [];
  }
}

function fetchRawData() {
  return {
    runs: fetchWorkflowRuns(),
    prs: fetchRecentPRs(),
  };
}

// ---------------------------------------------------------------------------
// Web server
// ---------------------------------------------------------------------------

function startWebServer(port = 0) {
  const html = generateDashboardHTML();

  const server = createServer((req, res) => {
    if (req.url === "/api/status") {
      const raw = fetchRawData();
      const data = buildDashboardData(raw);
      // Strip internal fields before sending to client
      const { _active, _completed, _prMap, _dailyCount, ...publicData } = data;
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
      });
      res.end(JSON.stringify(publicData));
    } else {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    }
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, port: addr.port, url: `http://localhost:${addr.port}` });
    });
  });
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const once = process.argv.includes("--once");
  const web = process.argv.includes("--web");

  let webUrl = null;
  if (web) {
    const { url } = await startWebServer();
    webUrl = url;
    console.log(`Web dashboard: ${webUrl}`);
  }

  const clear = () => process.stdout.write("\x1b[2J\x1b[H");

  const refresh = async () => {
    try {
      const raw = fetchRawData();
      const data = buildDashboardData(raw);
      const output = renderDashboard(data, { webUrl });
      clear();
      console.log(output);
    } catch (err) {
      console.error(`Error: ${err.message}`);
    }
  };

  await refresh();

  if (!once) {
    const timer = setInterval(refresh, REFRESH_INTERVAL_MS);

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding("utf8");

      process.stdin.on("data", async (key) => {
        if (key === "q" || key === "\u0003") {
          clearInterval(timer);
          process.stdin.setRawMode(false);
          process.stdout.write("\x1b[?25h");
          console.log("\nDashboard closed.");
          process.exit(0);
        }
        if (key === "r") {
          await refresh();
        }
      });

      process.stdout.write("\x1b[?25l");
      process.on("exit", () => {
        process.stdout.write("\x1b[?25h");
      });
    }
  }
}
