// scripts/pulse-check.mjs — Agent health monitoring (pulse check)
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const WORKFLOW_FILE = "agent-worker.yml";
const QUEUE_TIMEOUT_MS = 2 * 60 * 1000;
const RUNNING_TIMEOUT_MS = 60 * 60 * 1000;
const MAX_STUCK_OBSERVATIONS = 3;
const MAX_PULSE_RETRIES = 2;
const ISSUE_RE = /\b([A-Z]{1,5}-\d+)\b/;

/**
 * Classify a workflow run's health based on its status and elapsed time.
 * @param {object} run - GitHub Actions workflow run object
 * @param {Date} now - current timestamp
 * @returns {"healthy"|"stuck-queued"|"stuck-running"}
 */
export function classifyRun(run, now) {
  if (run.status === "queued") {
    const elapsed = now - new Date(run.created_at);
    return elapsed >= QUEUE_TIMEOUT_MS ? "stuck-queued" : "healthy";
  }
  if (run.status === "in_progress") {
    const startedAt = run.run_started_at || run.created_at;
    const elapsed = now - new Date(startedAt);
    return elapsed >= RUNNING_TIMEOUT_MS ? "stuck-running" : "healthy";
  }
  return "healthy";
}

/**
 * Return a fresh empty pulse-check state object.
 * @returns {{ runs: Record<string, object>, retryBudget: Record<string, {count: number, day: string}> }}
 */
export function emptyState() {
  return { runs: {}, retryBudget: {} };
}

/**
 * Check whether the given issue can be retried today.
 * Resets the budget when the day rolls over.
 * @param {string} issueId
 * @param {object} state - pulse-check state
 * @param {number} maxRetries - max retries per day (default MAX_PULSE_RETRIES)
 * @param {string|null} today - ISO date string (YYYY-MM-DD), defaults to today's date
 * @returns {boolean}
 */
export function canRetry(issueId, state, maxRetries = MAX_PULSE_RETRIES, today = null) {
  const day = today || new Date().toISOString().slice(0, 10);
  const entry = state.retryBudget[issueId];
  if (!entry) return true;
  if (entry.day !== day) return true;
  return entry.count < maxRetries;
}

/**
 * Increment (or create) the retry budget for an issue.
 * Resets the counter if the day has changed.
 * @param {string} issueId
 * @param {object} state - pulse-check state (mutated in place)
 * @param {string} today - ISO date string (YYYY-MM-DD)
 */
export function incrementBudget(issueId, state, today) {
  const entry = state.retryBudget[issueId];
  if (!entry || entry.day !== today) {
    state.retryBudget[issueId] = { count: 1, day: today };
  } else {
    entry.count += 1;
  }
}

/**
 * Remove tracked runs that are no longer in the active set.
 * @param {object} state - pulse-check state (mutated in place)
 * @param {Set<string>} activeRunIds - IDs of currently active runs
 */
export function pruneState(state, activeRunIds) {
  for (const id of Object.keys(state.runs)) {
    if (!activeRunIds.has(id)) {
      delete state.runs[id];
    }
  }
}

/**
 * Extract a Linear issue ID from a workflow run object.
 * Checks inputs.issue_id first (skipping "PULSE-CHECK"), then regex on name/display_title.
 * @param {object} run - GitHub Actions workflow run object
 * @returns {string} issue ID (e.g. "DVA-10") or "unknown"
 */
export function extractIssueFromRun(run) {
  const inputId = run.inputs?.issue_id;
  if (inputId && inputId !== "PULSE-CHECK") {
    return inputId;
  }
  const nameMatch = (run.name || "").match(ISSUE_RE);
  if (nameMatch) return nameMatch[1];
  const titleMatch = (run.display_title || "").match(ISSUE_RE);
  if (titleMatch) return titleMatch[1];
  return "unknown";
}

/**
 * Check whether a workflow run is a pulse-check run (not a real task).
 * @param {object} run - GitHub Actions workflow run object
 * @returns {boolean}
 */
export function isPulseCheckRun(run) {
  if (run.inputs?.issue_id === "PULSE-CHECK") return true;
  if ((run.name || "").includes("PULSE-CHECK")) return true;
  if ((run.display_title || "").includes("PULSE-CHECK")) return true;
  return false;
}
