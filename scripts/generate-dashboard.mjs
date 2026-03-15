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
