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
