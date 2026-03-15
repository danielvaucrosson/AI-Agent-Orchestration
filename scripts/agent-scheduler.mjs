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

// Temporary stubs — replaced in Tasks 2 and 3
export function parseRetryCount() { throw new Error("Not implemented"); }
export function filterForScheduler() { throw new Error("Not implemented"); }
export function setOutput() { throw new Error("Not implemented"); }
