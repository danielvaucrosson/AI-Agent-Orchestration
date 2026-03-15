/**
 * Scheduler logic for automated agent task pickup.
 *
 * Handles rate limiting, task selection (with retry filtering),
 * and output for the GitHub Actions scheduler workflow.
 *
 * Usage:
 *   node scripts/agent-scheduler.mjs next [--max-daily N] [--team DVA]
 *   node scripts/agent-scheduler.mjs --help
 */

import { execSync } from "node:child_process";
import { existsSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Check if dispatching another agent run is allowed under the rate limit.
 *
 * Caller is responsible for passing only runs from the last 24 hours.
 * This function counts them and compares against the limit.
 *
 * @param {object[]} runs - Recent workflow runs from GitHub API
 *   (each has `created_at` and `conclusion`)
 * @param {number} maxDaily - Maximum allowed runs per 24 hours
 * @returns {{ allowed: boolean, currentCount: number, maxDaily: number }}
 */
export function checkRateLimit(runs, maxDaily) {
  const currentCount = runs.length;
  return {
    allowed: currentCount < maxDaily,
    currentCount,
    maxDaily,
  };
}

/**
 * Parse the retry count from an issue's comments.
 * Looks for structured markers like `[agent-retry: N]`.
 *
 * @param {object[]} comments - Array of comment objects with `body` string
 * @returns {number} The highest retry count found, or 0
 */
export function parseRetryCount(comments) {
  let maxRetry = 0;
  const pattern = /\[agent-retry:\s*(\d+)\]/;
  for (const comment of comments) {
    const match = comment.body.match(pattern);
    if (match) {
      const count = parseInt(match[1], 10);
      if (count > maxRetry) maxRetry = count;
    }
  }
  return maxRetry;
}

/**
 * Filter task list to issues suitable for automated pickup.
 * - Only "Todo" status (not Backlog — those aren't ready)
 * - Exclude issues with `agent-failed` label and retry count >= maxRetries
 *
 * @param {object[]} tasks - Ordered list of task objects (from task-ordering.mjs)
 * @param {Object<string, object[]>} commentsMap - Map of identifier -> comments array
 * @param {number} [maxRetries=2] - Maximum retry attempts before skipping
 * @returns {object[]} Filtered and ordered tasks
 */
export function filterForScheduler(tasks, commentsMap = {}, maxRetries = 2) {
  return tasks.filter((task) => {
    if (task.statusLower !== "todo") return false;

    const hasFailedLabel = (task.labels || []).includes("agent-failed");
    if (hasFailedLabel) {
      const comments = commentsMap[task.identifier] || [];
      const retryCount = parseRetryCount(comments);
      if (retryCount >= maxRetries) return false;
    }

    return true;
  });
}

/**
 * Write a key=value pair to GitHub Actions output.
 * Falls back to console.log if not running in Actions.
 *
 * @param {string} key - Output variable name
 * @param {string} value - Output value
 */
export function setOutput(key, value) {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile && existsSync(outputFile)) {
    appendFileSync(outputFile, `${key}=${value}\n`);
  }
  console.log(`${key}=${value}`);
}
