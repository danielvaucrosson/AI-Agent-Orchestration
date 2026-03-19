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
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

// ---------------------------------------------------------------------------
// Recovery events — read and aggregate
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_RECOVERY_EVENTS_PATH = join(__dirname, "..", ".claude", "recovery-events.jsonl");

/**
 * Recovery level metadata for display.
 */
export const RECOVERY_LEVELS = {
  1: { label: "Level 1", description: "Auto-fix", color: "#d29922", cliColor: "yellow" },
  2: { label: "Level 2", description: "Kill + Retry", color: "#f0883e", cliColor: "orange" },
  3: { label: "Level 3", description: "Halt + Incident", color: "#f85149", cliColor: "red" },
};

/**
 * Read recovery events from the JSONL file.
 * Returns an array of event objects. Silently returns [] on errors.
 *
 * @param {string} [filePath] - Path to recovery-events.jsonl
 * @returns {object[]}
 */
export function readRecoveryEvents(filePath = DEFAULT_RECOVERY_EVENTS_PATH) {
  try {
    const raw = readFileSync(filePath, "utf8").trim();
    if (!raw) return [];
    return raw.split("\n").map((line) => {
      try { return JSON.parse(line); }
      catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Aggregate recovery events into counts by level (today + all-time),
 * plus detail records grouped by level.
 *
 * @param {object[]} events - Array of recovery event objects
 * @param {string} [today] - ISO date string (YYYY-MM-DD), defaults to today
 * @returns {{ levels: Record<number, { today: number, allTime: number, events: object[] }>, hasLevel3Today: boolean }}
 */
export function aggregateRecoveryLevels(events, today = null) {
  const day = today || new Date().toISOString().slice(0, 10);
  const levels = {
    1: { today: 0, allTime: 0, events: [] },
    2: { today: 0, allTime: 0, events: [] },
    3: { today: 0, allTime: 0, events: [] },
  };

  for (const event of events) {
    const level = event.level;
    if (!levels[level]) continue;

    levels[level].allTime++;
    levels[level].events.push(event);

    const eventDay = (event.timestamp || "").slice(0, 10);
    if (eventDay === day) {
      levels[level].today++;
    }
  }

  // Sort events newest-first within each level
  for (const level of Object.values(levels)) {
    level.events.sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""));
  }

  return {
    levels,
    hasLevel3Today: levels[3].today > 0,
  };
}

// ---------------------------------------------------------------------------
// Runner health metrics — pure functions
// ---------------------------------------------------------------------------

/**
 * Compute runner status summary from GitHub Actions runner objects.
 *
 * @param {{ runners: object[] }} runnerData - from /repos/{owner}/{repo}/actions/runners
 * @returns {{ status: "online"|"offline"|"busy"|"unknown", lastSeen: string|null }}
 */
export function computeRunnerStatus(runnerData) {
  const runners = runnerData?.runners || [];
  if (runners.length === 0) return { status: "unknown", lastSeen: null };

  const online = runners.filter((r) => r.status === "online");
  const busy = online.filter((r) => r.busy);

  // Prefer the most recent runner's labels for lastSeen
  const lastSeen = runners[0]?.os
    ? new Date().toISOString()
    : null;

  if (online.length === 0) return { status: "offline", lastSeen };
  if (busy.length === online.length) return { status: "busy", lastSeen };
  return { status: "online", lastSeen };
}

/**
 * Compute the daily quota trend by comparing today's run count
 * against yesterday's.
 *
 * @param {object[]} runs - All workflow runs (with created_at)
 * @param {number} [nowMs] - Current time in ms (for testing)
 * @returns {{ today: number, yesterday: number, trend: "up"|"down"|"flat" }}
 */
export function computeQuotaTrend(runs, nowMs = Date.now()) {
  const todayCutoff = nowMs - 24 * 60 * 60 * 1000;
  const yesterdayCutoff = nowMs - 48 * 60 * 60 * 1000;

  let today = 0;
  let yesterday = 0;
  for (const r of runs) {
    const ts = new Date(r.created_at).getTime();
    if (ts > todayCutoff) today++;
    else if (ts > yesterdayCutoff) yesterday++;
  }

  const trend = today > yesterday ? "up" : today < yesterday ? "down" : "flat";
  return { today, yesterday, trend };
}

/**
 * Compute rolling average task duration from completed runs.
 *
 * @param {object[]} completedRuns - Completed workflow runs
 * @param {number} [days=7] - Rolling window in days
 * @param {number} [nowMs] - Current time in ms (for testing)
 * @returns {{ avgMs: number, avgFormatted: string, sampleSize: number }}
 */
export function computeAvgDuration(completedRuns, days = 7, nowMs = Date.now()) {
  const cutoff = nowMs - days * 24 * 60 * 60 * 1000;
  const durations = [];

  for (const run of completedRuns) {
    const createdTs = new Date(run.created_at).getTime();
    if (createdTs < cutoff) continue;

    const startTs = run.run_started_at || run.created_at;
    const endTs = run.updated_at;
    if (!startTs || !endTs) continue;

    const ms = new Date(endTs).getTime() - new Date(startTs).getTime();
    if (ms > 0) durations.push(ms);
  }

  if (durations.length === 0) {
    return { avgMs: 0, avgFormatted: "—", sampleSize: 0 };
  }

  const avgMs = Math.round(durations.reduce((a, b) => a + b, 0) / durations.length);
  const totalSecs = Math.floor(avgMs / 1000);
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;

  return { avgMs, avgFormatted: `${mins}m ${secs}s`, sampleSize: durations.length };
}

/**
 * Compute rolling success rate from completed runs.
 *
 * @param {object[]} completedRuns - Completed workflow runs
 * @param {number} [days=7] - Rolling window in days
 * @param {number} [nowMs] - Current time in ms (for testing)
 * @returns {{ rate: number, trend: "up"|"down"|"flat", currentWindow: { succeeded: number, total: number }, previousWindow: { succeeded: number, total: number } }}
 */
export function computeSuccessRate(completedRuns, days = 7, nowMs = Date.now()) {
  const currentCutoff = nowMs - days * 24 * 60 * 60 * 1000;
  const previousCutoff = nowMs - 2 * days * 24 * 60 * 60 * 1000;

  let curSuccess = 0, curTotal = 0;
  let prevSuccess = 0, prevTotal = 0;

  for (const run of completedRuns) {
    const ts = new Date(run.created_at).getTime();
    if (ts >= currentCutoff) {
      curTotal++;
      if (run.conclusion === "success") curSuccess++;
    } else if (ts >= previousCutoff) {
      prevTotal++;
      if (run.conclusion === "success") prevSuccess++;
    }
  }

  const rate = curTotal > 0 ? Math.round((curSuccess / curTotal) * 100) : 0;
  const prevRate = prevTotal > 0 ? Math.round((prevSuccess / prevTotal) * 100) : 0;
  const trend = curTotal === 0 && prevTotal === 0 ? "flat"
    : rate > prevRate ? "up" : rate < prevRate ? "down" : "flat";

  return {
    rate,
    trend,
    currentWindow: { succeeded: curSuccess, total: curTotal },
    previousWindow: { succeeded: prevSuccess, total: prevTotal },
  };
}

/**
 * Compute days since the last Level 3 recovery incident.
 *
 * @param {object[]} recoveryEvents - Recovery event objects
 * @param {number} [nowMs] - Current time in ms (for testing)
 * @returns {{ days: number|null, lastIncidentDate: string|null }}
 */
export function computeDaysSinceIncident(recoveryEvents, nowMs = Date.now()) {
  const level3Events = (recoveryEvents || []).filter((e) => e.level === 3);
  if (level3Events.length === 0) {
    return { days: null, lastIncidentDate: null };
  }

  // Find most recent Level 3 event
  let latestMs = 0;
  let latestDate = null;
  for (const e of level3Events) {
    const ts = new Date(e.timestamp).getTime();
    if (ts > latestMs) {
      latestMs = ts;
      latestDate = e.timestamp;
    }
  }

  const days = Math.floor((nowMs - latestMs) / (24 * 60 * 60 * 1000));
  return { days, lastIncidentDate: latestDate };
}

/**
 * Build the complete runner health metrics object.
 *
 * @param {object} params
 * @param {object[]} params.runs - All workflow runs
 * @param {object[]} params.completedRuns - Completed workflow runs
 * @param {object[]} params.recoveryEvents - Recovery event objects
 * @param {{ runners: object[] }} [params.runnerData] - Runner API response
 * @param {number} [params.nowMs] - Current time in ms (for testing)
 * @returns {object} Runner health metrics
 */
export function buildRunnerHealth({ runs, completedRuns, recoveryEvents, runnerData, nowMs }) {
  const now = nowMs || Date.now();
  return {
    runner: computeRunnerStatus(runnerData),
    quotaTrend: computeQuotaTrend(runs, now),
    avgDuration: computeAvgDuration(completedRuns, 7, now),
    successRate: computeSuccessRate(completedRuns, 7, now),
    daysSinceIncident: computeDaysSinceIncident(recoveryEvents, now),
  };
}

// ---------------------------------------------------------------------------
// Gantt chart data builder
// ---------------------------------------------------------------------------

/**
 * Status-to-color mapping for Gantt bars.
 */
export const GANTT_COLORS = {
  success: "#3fb950",
  failure: "#f85149",
  in_progress: "#58a6ff",
  queued: "#d29922",
};

/**
 * Build Gantt chart data from workflow runs.
 * Each run becomes a horizontal bar with a start time, end time, and status.
 *
 * @param {object[]} runs - Workflow run objects from GitHub API
 * @param {number} [nowMs] - Current time in ms (for testing)
 * @returns {{ bars: object[], minTime: number, maxTime: number }}
 */
export function buildGanttData(runs, nowMs = Date.now()) {
  if (!runs || runs.length === 0) {
    return { bars: [], minTime: nowMs, maxTime: nowMs };
  }

  const bars = [];

  for (const run of runs) {
    const { issueId, issueTitle } = extractRunInfo(run);
    const startTs = run.run_started_at || run.created_at;
    if (!startTs) continue;

    const startMs = new Date(startTs).getTime();
    if (isNaN(startMs)) continue;

    let endMs;
    let status;

    if (run.status === "queued") {
      status = "queued";
      // Queued runs show a thin bar from created_at to now
      endMs = nowMs;
    } else if (run.status === "in_progress") {
      status = "in_progress";
      endMs = nowMs;
    } else if (run.status === "completed") {
      status = run.conclusion === "success" ? "success" : "failure";
      endMs = run.updated_at ? new Date(run.updated_at).getTime() : nowMs;
      if (isNaN(endMs)) endMs = nowMs;
    } else {
      continue;
    }

    // Ensure bar has a minimum visible width (at least 1% of total range later)
    if (endMs < startMs) endMs = startMs;

    bars.push({
      issueId,
      issueTitle,
      status,
      color: GANTT_COLORS[status] || "#8b949e",
      startMs,
      endMs,
      startTime: startTs,
      endTime: run.updated_at || new Date(nowMs).toISOString(),
      duration: run.status === "completed"
        ? formatCompletedDuration(startTs, run.updated_at)
        : formatDuration(startTs),
    });
  }

  // Sort bars by start time (earliest first)
  bars.sort((a, b) => a.startMs - b.startMs);

  // Compute the time range for the chart
  let minTime = nowMs;
  let maxTime = 0;
  for (const bar of bars) {
    if (bar.startMs < minTime) minTime = bar.startMs;
    if (bar.endMs > maxTime) maxTime = bar.endMs;
  }
  if (maxTime <= minTime) maxTime = minTime + 1;

  return { bars, minTime, maxTime };
}

// ---------------------------------------------------------------------------
// Dashboard data builder
// ---------------------------------------------------------------------------

/**
 * Build structured dashboard data from raw API results.
 * Used by both CLI renderer and web API endpoint.
 *
 * @param {object} raw
 * @param {object[]} raw.runs - Workflow run objects
 * @param {object[]} raw.prs - PR objects
 * @param {object[]} [raw.recoveryEvents] - Recovery event objects (optional)
 * @param {{ runners: object[] }} [raw.runnerData] - Runner API response (optional)
 * @returns {object} Structured dashboard data
 */
export function buildDashboardData(raw) {
  const { runs, prs, recoveryEvents, runnerData } = raw;
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
    const startTs = run.run_started_at || run.created_at;
    const endTs = run.updated_at;
    const rawMs = startTs && endTs
      ? new Date(endTs).getTime() - new Date(startTs).getTime()
      : 0;
    return {
      issueId,
      issueTitle,
      success: run.conclusion === "success",
      prNumber: prInfo?.number || null,
      prUrl: prInfo ? `${REPO_URL}/pull/${prInfo.number}` : null,
      duration: formatCompletedDuration(startTs, endTs),
      durationMs: rawMs > 0 ? rawMs : 0,
      when: formatRelativeTime(run.updated_at),
      updatedAt: run.updated_at,
    };
  });

  const recovery = aggregateRecoveryLevels(recoveryEvents || []);

  const runnerHealth = buildRunnerHealth({
    runs,
    completedRuns: completed,
    recoveryEvents: recoveryEvents || [],
    runnerData,
  });

  const gantt = buildGanttData(runs);

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
    recoveryLevels: recovery,
    runnerHealth,
    gantt,
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

  // Runner health panel
  const health = data.runnerHealth;
  if (health) {
    lines.push(`${C.dim}${"─".repeat(62)}${C.reset}`);
    lines.push(`${C.cyan}RUNNER HEALTH${C.reset}`);
    lines.push("");

    // Runner status
    const statusColor = health.runner.status === "online" ? C.green
      : health.runner.status === "busy" ? C.yellow
      : health.runner.status === "offline" ? C.red : C.dim;
    lines.push(
      `  Runner:         ${statusColor}${C.bold}${health.runner.status.toUpperCase()}${C.reset}`
    );

    // Quota trend
    const trendArrow = health.quotaTrend.trend === "up" ? `${C.red}\u2191${C.reset}`
      : health.quotaTrend.trend === "down" ? `${C.green}\u2193${C.reset}` : `${C.dim}\u2192${C.reset}`;
    lines.push(
      `  Quota:          ${dailyCount}/${dailyLimit} ${trendArrow}  ${C.dim}(yesterday: ${health.quotaTrend.yesterday})${C.reset}`
    );

    // Avg duration
    lines.push(
      `  Avg duration:   ${C.yellow}${health.avgDuration.avgFormatted}${C.reset}  ${C.dim}(${health.avgDuration.sampleSize} runs, 7d)${C.reset}`
    );

    // Success rate
    const rateColor = health.successRate.rate >= 80 ? C.green
      : health.successRate.rate >= 50 ? C.yellow : C.red;
    const rateTrend = health.successRate.trend === "up" ? `${C.green}\u2191${C.reset}`
      : health.successRate.trend === "down" ? `${C.red}\u2193${C.reset}` : `${C.dim}\u2192${C.reset}`;
    lines.push(
      `  Success rate:   ${rateColor}${C.bold}${health.successRate.rate}%${C.reset} ${rateTrend}  ${C.dim}(${health.successRate.currentWindow.succeeded}/${health.successRate.currentWindow.total}, 7d)${C.reset}`
    );

    // Days since incident
    const incidentStr = health.daysSinceIncident.days === null
      ? `${C.green}No incidents recorded${C.reset}`
      : health.daysSinceIncident.days === 0
        ? `${C.red}${C.bold}TODAY${C.reset}`
        : `${C.green}${health.daysSinceIncident.days}${C.reset} ${C.dim}day${health.daysSinceIncident.days !== 1 ? "s" : ""}${C.reset}`;
    lines.push(
      `  Since incident: ${incidentStr}`
    );

    lines.push("");
  }

  // Recovery levels
  const recovery = data.recoveryLevels;
  if (recovery) {
    const totalRecovery = recovery.levels[1].allTime + recovery.levels[2].allTime + recovery.levels[3].allTime;
    if (totalRecovery > 0 || recovery.hasLevel3Today) {
      lines.push(`${C.dim}${"─".repeat(62)}${C.reset}`);
      const alertPrefix = recovery.hasLevel3Today
        ? `${C.bgRed}${C.bold} ⚠ RECOVERY LEVELS ${C.reset}`
        : `${C.yellow}RECOVERY LEVELS${C.reset}`;
      lines.push(alertPrefix);
      lines.push("");
      for (const lvl of [1, 2, 3]) {
        const info = RECOVERY_LEVELS[lvl];
        const counts = recovery.levels[lvl];
        const colorCode = lvl === 3 ? C.red : lvl === 2 ? C.orange : C.yellow;
        const todayStr = counts.today > 0 ? `${C.bold}${counts.today}${C.reset}` : `${C.dim}0${C.reset}`;
        lines.push(
          `  ${colorCode}${info.label}${C.reset} ${C.dim}(${info.description})${C.reset}` +
          `${" ".repeat(Math.max(1, 25 - info.label.length - info.description.length))}` +
          `today: ${todayStr}  ${C.dim}all-time: ${counts.allTime}${C.reset}`
        );
      }
      lines.push("");
    }
  }

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

  // Gantt chart
  const gantt = data.gantt;
  if (gantt && gantt.bars && gantt.bars.length > 0) {
    lines.push("");
    lines.push(`${C.dim}${"─".repeat(62)}${C.reset}`);
    lines.push(`${C.cyan}WORKFLOW TIMELINE${C.reset}`);
    lines.push("");

    const range = gantt.maxTime - gantt.minTime || 1;
    const trackWidth = 36; // characters wide

    for (const bar of gantt.bars) {
      const leftFrac = (bar.startMs - gantt.minTime) / range;
      const widthFrac = (bar.endMs - bar.startMs) / range;
      const leftChars = Math.round(leftFrac * trackWidth);
      const widthChars = Math.max(1, Math.round(widthFrac * trackWidth));

      const colorCode = bar.status === "success" ? C.green
        : bar.status === "failure" ? C.red
        : bar.status === "in_progress" ? C.cyan
        : C.yellow;

      const label = bar.issueId.padEnd(10);
      const prefix = " ".repeat(leftChars);
      const barStr = "█".repeat(widthChars);

      lines.push(
        `  ${C.cyan}${label}${C.reset} ${prefix}${colorCode}${barStr}${C.reset} ${C.dim}${bar.duration}${C.reset}`
      );
    }

    lines.push("");
    lines.push(
      `  ${C.green}█${C.reset} Success  ${C.red}█${C.reset} Failed  ${C.cyan}█${C.reset} Running  ${C.yellow}█${C.reset} Queued`
    );
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

  /* Runner health panel */
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

  /* Recovery levels panel */
  .recovery-panel { margin-bottom: 24px; }
  .recovery-panel.has-alert { }
  .recovery-alert-banner {
    background: rgba(248, 81, 73, 0.15); border: 1px solid #f85149;
    border-radius: 8px; padding: 10px 16px; margin-bottom: 12px;
    color: #f85149; font-weight: 600; font-size: 13px;
    display: flex; align-items: center; gap: 8px;
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
  .recovery-detail-header {
    font-size: 12px; text-transform: uppercase; color: #8b949e;
    letter-spacing: 1px; margin-bottom: 8px;
  }
  .recovery-event {
    padding: 6px 0; border-bottom: 1px solid #21262d;
    font-size: 13px; display: flex; justify-content: space-between;
  }
  .recovery-event:last-child { border-bottom: none; }
  .recovery-event-issue { color: #58a6ff; font-weight: 500; }
  .recovery-event-time { color: #8b949e; font-size: 12px; }
  .recovery-event-diagnosis { color: #8b949e; font-size: 11px; }

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
  .duration { font-family: 'Cascadia Code', 'Fira Code', monospace; color: #ffd54f; position: relative; }
  .duration-bar {
    position: absolute; top: 4px; left: 0; bottom: 4px;
    background: rgba(255, 213, 79, 0.15); border-radius: 3px;
    pointer-events: none;
  }
  .duration-text { position: relative; z-index: 1; }
  .when { color: #8b949e; }
  .check { font-size: 16px; }

  /* Gantt chart */
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
    <span id="last-update"></span>
    <span><span class="refresh-dot">&#9679;</span> Auto-refresh: 10s</span>
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
  const maxMs = Math.max(...history.map(h => h.durationMs || 0), 1);
  const rows = history.map(h => {
    const statusIcon = h.success
      ? '<span class="check status-success">&#10003;</span> <span class="status-success">Success</span>'
      : '<span class="check status-failed">&#10007;</span> <span class="status-failed">Failed</span>';
    const prCell = h.prNumber
      ? \`<a class="pr-link" href="\${escapeHtml(h.prUrl)}" target="_blank">#\${h.prNumber}</a>\`
      : '<span class="pr-none">&mdash;</span>';
    const pct = maxMs > 0 ? Math.round(((h.durationMs || 0) / maxMs) * 100) : 0;
    return \`
      <tr>
        <td>\${statusIcon}</td>
        <td class="issue-link">\${escapeHtml(h.issueId)}</td>
        <td>\${escapeHtml(h.issueTitle)}</td>
        <td>\${prCell}</td>
        <td class="duration"><div class="duration-bar" style="width:\${pct}%"></div><span class="duration-text">\${escapeHtml(h.duration)}</span></td>
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

function renderRunnerHealth(h) {
  if (!h) return '';
  const statusColor = h.runner.status === 'online' ? 'status-online'
    : h.runner.status === 'busy' ? 'status-busy'
    : h.runner.status === 'offline' ? 'status-offline' : 'status-unknown';
  const quotaTrend = h.quotaTrend.trend === 'up' ? '<span class="health-trend trend-down">&#8593;</span>'
    : h.quotaTrend.trend === 'down' ? '<span class="health-trend trend-up">&#8595;</span>'
    : '<span class="health-trend trend-flat">&#8594;</span>';
  const rateColor = h.successRate.rate >= 80 ? 'status-online'
    : h.successRate.rate >= 50 ? 'status-busy' : 'status-offline';
  const rateTrend = h.successRate.trend === 'up' ? '<span class="health-trend trend-up">&#8593;</span>'
    : h.successRate.trend === 'down' ? '<span class="health-trend trend-down">&#8595;</span>'
    : '<span class="health-trend trend-flat">&#8594;</span>';
  const incidentStr = h.daysSinceIncident.days === null ? 'N/A'
    : h.daysSinceIncident.days === 0 ? 'TODAY' : String(h.daysSinceIncident.days);
  const incidentColor = h.daysSinceIncident.days === null ? 'status-online'
    : h.daysSinceIncident.days === 0 ? 'status-offline' : 'status-online';
  return \`
    <div class="runner-health">
      <div class="section-label">Runner Health</div>
      <div class="health-cards">
        <div class="health-card">
          <div class="health-value \${statusColor}">\${escapeHtml(h.runner.status.toUpperCase())}</div>
          <div class="health-label">Runner</div>
        </div>
        <div class="health-card">
          <div class="health-value" style="color:#d29922">\${h.quotaTrend.today}\${quotaTrend}</div>
          <div class="health-label">Quota (24h)</div>
          <div class="health-sub">yesterday: \${h.quotaTrend.yesterday}</div>
        </div>
        <div class="health-card">
          <div class="health-value" style="color:#ffd54f">\${escapeHtml(h.avgDuration.avgFormatted)}</div>
          <div class="health-label">Avg Duration</div>
          <div class="health-sub">\${h.avgDuration.sampleSize} runs (7d)</div>
        </div>
        <div class="health-card">
          <div class="health-value \${rateColor}">\${h.successRate.rate}%\${rateTrend}</div>
          <div class="health-label">Success Rate</div>
          <div class="health-sub">\${h.successRate.currentWindow.succeeded}/\${h.successRate.currentWindow.total} (7d)</div>
        </div>
        <div class="health-card">
          <div class="health-value \${incidentColor}">\${incidentStr}</div>
          <div class="health-label">Days Since Incident</div>
          <div class="health-sub">Level 3 escalations</div>
        </div>
      </div>
    </div>
  \`;
}

const LEVEL_META = {
  1: { label: 'Level 1', desc: 'Auto-fix', color: '#d29922' },
  2: { label: 'Level 2', desc: 'Kill + Retry', color: '#f0883e' },
  3: { label: 'Level 3', desc: 'Halt + Incident', color: '#f85149' },
};

function renderRecoveryPanel(recovery) {
  if (!recovery) return '';
  const { levels, hasLevel3Today } = recovery;
  const total = levels[1].allTime + levels[2].allTime + levels[3].allTime;
  if (total === 0 && !hasLevel3Today) return '';

  const alertBanner = hasLevel3Today
    ? '<div class="recovery-alert-banner">&#9888; Level 3 incidents detected today — all agents were halted</div>'
    : '';

  const cards = [1, 2, 3].map(lvl => {
    const meta = LEVEL_META[lvl];
    const data = levels[lvl];
    const activeClass = lvl === 3 && data.today > 0 ? ' level-3-active' : '';
    return \`
      <div class="recovery-card\${activeClass}" onclick="toggleRecoveryDetail(\${lvl})" title="Click to see affected tasks">
        <div class="recovery-value" style="color:\${meta.color}">\${data.allTime}</div>
        <div class="recovery-label" style="color:\${meta.color}">\${escapeHtml(meta.label)}</div>
        <div class="recovery-sublabel">\${escapeHtml(meta.desc)}</div>
        <div class="recovery-today">\${data.today} today</div>
      </div>
    \`;
  }).join('');

  const details = [1, 2, 3].map(lvl => {
    const meta = LEVEL_META[lvl];
    const data = levels[lvl];
    if (data.events.length === 0) {
      return \`<div class="recovery-detail" id="recovery-detail-\${lvl}">
        <div class="recovery-detail-header">\${escapeHtml(meta.label)} Events</div>
        <div style="color:#8b949e;font-size:13px;font-style:italic;">No events recorded</div>
      </div>\`;
    }
    const rows = data.events.slice(0, 10).map(e => \`
      <div class="recovery-event">
        <div>
          <span class="recovery-event-issue">\${escapeHtml(e.issueId || 'unknown')}</span>
          <span style="margin-left:8px">\${escapeHtml(e.issueTitle || '')}</span>
          <span class="recovery-event-diagnosis">\${e.diagnosis ? ' — ' + escapeHtml(e.diagnosis) : ''}</span>
        </div>
        <div class="recovery-event-time">\${e.timestamp ? new Date(e.timestamp).toLocaleString() : ''}</div>
      </div>
    \`).join('');
    return \`<div class="recovery-detail" id="recovery-detail-\${lvl}">
      <div class="recovery-detail-header">\${escapeHtml(meta.label)} Events (\${data.events.length} total)</div>
      \${rows}
    </div>\`;
  }).join('');

  return \`
    <div class="recovery-panel\${hasLevel3Today ? ' has-alert' : ''}">
      <div class="section-label">Recovery Levels</div>
      \${alertBanner}
      <div class="recovery-cards">\${cards}</div>
      \${details}
    </div>
  \`;
}

function toggleRecoveryDetail(level) {
  const el = document.getElementById('recovery-detail-' + level);
  if (el) el.classList.toggle('open');
}

function renderGanttChart(gantt) {
  if (!gantt || !gantt.bars || gantt.bars.length === 0) {
    return '<div class="gantt-empty">No workflow runs to display</div>';
  }
  const { bars, minTime, maxTime } = gantt;
  const range = maxTime - minTime || 1;

  // Build time axis labels (up to 5 evenly spaced)
  const axisCount = 5;
  const axisLabels = [];
  for (let i = 0; i < axisCount; i++) {
    const t = minTime + (range * i / (axisCount - 1));
    const d = new Date(t);
    axisLabels.push(d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
  }
  const axisHtml = '<div class="gantt-axis">' + axisLabels.map(function(l) {
    return '<span>' + escapeHtml(l) + '</span>';
  }).join('') + '</div>';

  // Build rows
  const rowsHtml = bars.map(function(bar) {
    const leftPct = Math.max(0, ((bar.startMs - minTime) / range) * 100);
    const widthPct = Math.max(0.5, ((bar.endMs - bar.startMs) / range) * 100);
    const barTitle = escapeHtml(bar.issueId + ': ' + bar.issueTitle + ' (' + bar.duration + ')');
    // Only show text if bar is wide enough
    const textHtml = widthPct > 8
      ? '<span class="gantt-bar-text">' + escapeHtml(bar.duration) + '</span>'
      : '';
    return '<div class="gantt-row">'
      + '<div class="gantt-label" title="' + escapeHtml(bar.issueTitle) + '">' + escapeHtml(bar.issueId) + '</div>'
      + '<div class="gantt-track">'
      + '<div class="gantt-bar" style="left:' + leftPct.toFixed(2) + '%;width:' + widthPct.toFixed(2) + '%;background:' + bar.color + '" title="' + barTitle + '">'
      + textHtml
      + '</div></div></div>';
  }).join('');

  // Legend
  const legendItems = [
    { color: '#3fb950', label: 'Success' },
    { color: '#f85149', label: 'Failed' },
    { color: '#58a6ff', label: 'In Progress' },
    { color: '#d29922', label: 'Queued' },
  ];
  const legendHtml = '<div class="gantt-legend">' + legendItems.map(function(item) {
    return '<div class="gantt-legend-item"><div class="gantt-legend-dot" style="background:' + item.color + '"></div>' + item.label + '</div>';
  }).join('') + '</div>';

  return '<div class="gantt-chart">' + axisHtml + '<div class="gantt-rows">' + rowsHtml + '</div>' + legendHtml + '</div>';
}

async function refresh() {
  try {
    const res = await fetch('/api/status');
    if (!res.ok) throw new Error('API error');
    const data = await res.json();
    document.getElementById('gauges').innerHTML = renderGauges(data.gauges);
    document.getElementById('runner-health').innerHTML = renderRunnerHealth(data.runnerHealth);
    document.getElementById('recovery-panel').innerHTML = renderRecoveryPanel(data.recoveryLevels);
    document.getElementById('agents-list').innerHTML = renderAgents(data.activeAgents);
    document.getElementById('history-table').innerHTML = renderHistory(data.history);
    document.getElementById('gantt-chart').innerHTML = renderGanttChart(data.gantt);
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

function fetchRunnerData() {
  const data = ghApi(`/repos/{owner}/{repo}/actions/runners`);
  return data || { runners: [] };
}

function fetchRawData() {
  return {
    runs: fetchWorkflowRuns(),
    prs: fetchRecentPRs(),
    recoveryEvents: readRecoveryEvents(),
    runnerData: fetchRunnerData(),
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
      // Strip internal fields before sending to client (keep recoveryLevels)
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
