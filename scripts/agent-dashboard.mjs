/**
 * Agent CLI Dashboard — live-updating terminal display of agent workflow status.
 *
 * Shows running agents, queued jobs, and recent completions by polling
 * the GitHub Actions API for agent-worker.yml workflow runs.
 *
 * Usage: node scripts/agent-dashboard.mjs
 *        node scripts/agent-dashboard.mjs --once   (single render, no refresh)
 *
 * Requires: GITHUB_TOKEN env var (or gh CLI authentication)
 */

import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WORKFLOW_FILE = "agent-worker.yml";
const REFRESH_INTERVAL_MS = 10_000;
const MAX_COMPLETIONS = 5;
const DAILY_LIMIT = 4;

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
  // workflow_dispatch inputs are in run.inputs (if available from API)
  // or sometimes embedded in run.name / run.display_title
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
 * Render the CLI dashboard output string from processed data.
 *
 * @param {object} data - Dashboard data
 * @param {object[]} data.active - Active runs
 * @param {object[]} data.completed - Completed runs (latest N)
 * @param {number} data.dailyCount - Runs in last 24h
 * @param {number} data.dailyLimit - Max daily runs
 * @param {Map<number, object>} data.prMap - Run ID -> PR info
 * @returns {string} ANSI-formatted terminal output
 */
export function renderDashboard(data) {
  const lines = [];

  // Header
  lines.push(
    `${C.cyan}${C.bold}  AGENT DASHBOARD  ${"─".repeat(42)}${C.reset}`
  );
  lines.push("");

  // Running gauge
  const runningCount = data.active.filter(
    (r) => r.status === "in_progress"
  ).length;
  lines.push(
    `${C.green}RUNNING:${C.reset} ${C.bgGreen}${C.bold} ${runningCount} ${C.reset} / ${data.dailyLimit} daily` +
      `${C.dim}    Used today: ${data.dailyCount}${C.reset}`
  );
  lines.push("");

  // Active agents
  if (data.active.length === 0) {
    lines.push(`${C.dim}  No agents currently running${C.reset}`);
  } else {
    for (const run of data.active) {
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
  lines.push(
    `${C.dim}${"─".repeat(62)}${C.reset}`
  );
  lines.push(`${C.green}RECENT COMPLETIONS${C.reset}`);

  const recent = data.completed.slice(0, MAX_COMPLETIONS);
  if (recent.length === 0) {
    lines.push(`${C.dim}  No recent completions${C.reset}`);
  } else {
    for (const run of recent) {
      const { issueId, issueTitle } = extractRunInfo(run);
      const ok = run.conclusion === "success";
      const statusStr = ok
        ? `${C.green}OK  ${C.reset}`
        : `${C.red}FAIL${C.reset}`;
      const prInfo = data.prMap.get(run.id);
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
  lines.push(
    `${C.dim}Auto-refresh: 10s | q = quit | r = refresh now${C.reset}`
  );

  return lines.join("\n");
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

async function fetchAndRender() {
  const runs = fetchWorkflowRuns();
  const { active, completed } = categorizeRuns(runs);
  const prs = fetchRecentPRs();
  const prMap = matchRunsToPRs(completed, prs);
  const dailyCount = countDailyRuns(runs);

  return renderDashboard({
    active,
    completed,
    dailyCount,
    dailyLimit: DAILY_LIMIT,
    prMap,
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

  // Clear screen helper
  const clear = () => process.stdout.write("\x1b[2J\x1b[H");

  const refresh = async () => {
    try {
      const output = await fetchAndRender();
      clear();
      console.log(output);
    } catch (err) {
      console.error(`Error: ${err.message}`);
    }
  };

  await refresh();

  if (!once) {
    // Set up periodic refresh
    const timer = setInterval(refresh, REFRESH_INTERVAL_MS);

    // Listen for keyboard input
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding("utf8");

      process.stdin.on("data", async (key) => {
        if (key === "q" || key === "\u0003") {
          // q or Ctrl+C
          clearInterval(timer);
          process.stdin.setRawMode(false);
          process.stdout.write("\x1b[?25h"); // show cursor
          console.log("\nDashboard closed.");
          process.exit(0);
        }
        if (key === "r") {
          await refresh();
        }
      });

      // Hide cursor for cleaner display
      process.stdout.write("\x1b[?25l");

      // Restore cursor on exit
      process.on("exit", () => {
        process.stdout.write("\x1b[?25h");
      });
    }
  }
}
