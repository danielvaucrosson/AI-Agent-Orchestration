/**
 * Agent Performance Dashboard — collects metrics from Git, GitHub, and Linear,
 * then generates a self-contained HTML dashboard with Chart.js.
 *
 * Usage: node scripts/dashboard.mjs
 * npm:   npm run dashboard
 */

import { execSync } from "node:child_process";
import {
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

const ISSUE_RE = /\b([A-Z]{1,5}-\d+)\b/;

// ---------------------------------------------------------------------------
// Shell helper — returns null on failure instead of throwing
// ---------------------------------------------------------------------------

function run(cmd) {
  try {
    return execSync(cmd, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      cwd: REPO_ROOT,
    }).trim();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Pure functions (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Parse `git log` output into per-issue metrics.
 * Expected format: "COMMIT|<hash>|<date>|<subject>" lines interleaved with
 * numstat lines "<added>\t<removed>\t<file>".
 */
export function parseGitLog(rawLog) {
  if (!rawLog) return [];

  const issues = new Map();
  let currentId = null;

  for (const line of rawLog.split("\n")) {
    if (line.startsWith("COMMIT|")) {
      const parts = line.split("|");
      const date = parts[2];
      const subject = parts.slice(3).join("|");
      const match = subject?.match(ISSUE_RE);
      currentId = match ? match[1] : null;
      if (currentId) {
        if (!issues.has(currentId)) {
          issues.set(currentId, {
            id: currentId,
            commits: 0,
            linesAdded: 0,
            linesRemoved: 0,
            firstCommitAt: null,
            lastCommitAt: null,
          });
        }
        const entry = issues.get(currentId);
        entry.commits++;
        const ts = date?.trim();
        if (ts) {
          if (!entry.firstCommitAt || ts < entry.firstCommitAt)
            entry.firstCommitAt = ts;
          if (!entry.lastCommitAt || ts > entry.lastCommitAt)
            entry.lastCommitAt = ts;
        }
      }
    } else if (currentId && /^\d+\t\d+\t/.test(line)) {
      const [added, removed] = line.split("\t");
      const entry = issues.get(currentId);
      entry.linesAdded += parseInt(added, 10) || 0;
      entry.linesRemoved += parseInt(removed, 10) || 0;
    }
  }

  return [...issues.values()];
}

/**
 * Parse `gh pr list --json ...` output and map PRs to issue IDs.
 * Returns a Map<issueId, prData>.
 */
export function parsePrJson(rawJson) {
  if (!rawJson) return new Map();
  let prs;
  try {
    prs = JSON.parse(rawJson);
  } catch {
    return new Map();
  }
  const result = new Map();
  for (const pr of prs) {
    const branch = pr.headRefName || pr.title || "";
    const match = branch.match(ISSUE_RE) || pr.title?.match(ISSUE_RE);
    const id = match ? match[1] : null;
    if (id && !result.has(id)) {
      result.set(id, {
        prNumber: pr.number,
        prTitle: pr.title,
        prCreatedAt: pr.createdAt,
        prMergedAt: pr.mergedAt,
        reviewCount: pr.reviews?.totalCount ?? pr.reviews?.length ?? 0,
      });
    }
  }
  return result;
}

/**
 * Load audit trail JSON files from a directory.
 * Returns an array of parsed audit entries; skips malformed files.
 */
export function loadAuditTrails(dir) {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  const entries = [];
  for (const file of files) {
    try {
      const data = JSON.parse(readFileSync(resolve(dir, file), "utf-8"));
      entries.push(data);
    } catch {
      // skip malformed files
    }
  }
  return entries;
}

/**
 * Merge metrics from all sources into a single dashboard entry.
 */
export function mergeMetrics(issueId, gitEntry, prEntry, linearEntry, auditEntries) {
  const createdAt = linearEntry?.createdAt ?? gitEntry?.firstCommitAt ?? null;
  const completedAt = linearEntry?.completedAt ?? prEntry?.prMergedAt ?? gitEntry?.lastCommitAt ?? null;

  let cycleTimeDays = null;
  if (createdAt && completedAt) {
    const ms = new Date(completedAt) - new Date(createdAt);
    if (!isNaN(ms) && ms >= 0) {
      cycleTimeDays = ms / (1000 * 60 * 60 * 24);
    }
  }

  const matchingAudits = auditEntries.filter(
    (a) => a.issueId === issueId || a.issue === issueId
  );

  return {
    id: issueId,
    title: linearEntry?.title ?? prEntry?.prTitle ?? issueId,
    status: linearEntry?.status ?? "Unknown",
    createdAt,
    completedAt,
    cycleTimeDays,
    commits: gitEntry?.commits ?? 0,
    linesAdded: gitEntry?.linesAdded ?? 0,
    linesRemoved: gitEntry?.linesRemoved ?? 0,
    prNumber: prEntry?.prNumber ?? null,
    prMergedAt: prEntry?.prMergedAt ?? null,
    reviewCount: prEntry?.reviewCount ?? 0,
    auditEvents: matchingAudits.length,
  };
}

/**
 * Compute summary statistics from dashboard entries.
 */
export function computeSummary(entries) {
  const cycleTimes = entries
    .map((e) => e.cycleTimeDays)
    .filter((t) => t != null && Number.isFinite(t) && t >= 0);
  const avgCycleTimeDays =
    cycleTimes.length > 0
      ? cycleTimes.reduce((a, b) => a + b, 0) / cycleTimes.length
      : null;

  return {
    totalIssues: entries.length,
    avgCycleTimeDays,
    totalCommits: entries.reduce((s, e) => s + (e.commits ?? 0), 0),
    totalLinesChanged: entries.reduce(
      (s, e) => s + (e.linesAdded ?? 0) + (e.linesRemoved ?? 0),
      0
    ),
  };
}

/**
 * Render a self-contained HTML dashboard from dashboard data.
 */
export function renderHtml(data) {
  const issueLabels = JSON.stringify(data.issues.map((i) => i.id));
  const cycleTimes = JSON.stringify(
    data.issues.map((i) => i.cycleTimeDays ?? 0)
  );
  const commitCounts = JSON.stringify(
    data.issues.map((i) => i.commits ?? 0)
  );
  const linesAdded = JSON.stringify(
    data.issues.map((i) => i.linesAdded ?? 0)
  );
  const linesRemoved = JSON.stringify(
    data.issues.map((i) => i.linesRemoved ?? 0)
  );

  const esc = (s) =>
    String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  const badge = (status) => {
    if (!status) return "badge-other";
    const s = status.toLowerCase();
    if (s === "done") return "badge-done";
    if (s.includes("progress")) return "badge-progress";
    if (s.includes("review")) return "badge-review";
    return "badge-other";
  };

  const rows = data.issues
    .map(
      (i) => `
      <tr>
        <td>${esc(i.id)}</td>
        <td>${esc(i.title)}</td>
        <td><span class="badge ${badge(i.status)}">${esc(i.status)}</span></td>
        <td>${i.cycleTimeDays != null ? i.cycleTimeDays.toFixed(1) : "\u2014"}</td>
        <td>${i.commits ?? "\u2014"}</td>
        <td>+${i.linesAdded ?? 0} / -${i.linesRemoved ?? 0}</td>
        <td>${i.prNumber != null ? `#${i.prNumber}` : "\u2014"}</td>
      </tr>`
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Agent Performance Dashboard</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, sans-serif; margin: 2rem; background: #f8f9fa; color: #212529; }
    h1 { font-size: 1.5rem; margin-bottom: .5rem; }
    .subtitle { font-size: .85rem; color: #6c757d; margin-bottom: 1.5rem; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 1rem; margin-bottom: 2rem; }
    .stat { background: #fff; border-radius: 8px; padding: 1.25rem; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
    .stat-value { font-size: 2rem; font-weight: 700; color: #0d6efd; }
    .stat-label { font-size: .85rem; color: #6c757d; margin-top: .25rem; }
    .charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(400px, 1fr)); gap: 1.5rem; margin-bottom: 2rem; }
    .card { background: #fff; border-radius: 8px; padding: 1.25rem; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
    table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
    th, td { padding: .75rem 1rem; text-align: left; border-bottom: 1px solid #dee2e6; font-size: .875rem; }
    th { background: #f1f3f5; font-weight: 600; }
    .badge { display: inline-block; padding: .2rem .6rem; border-radius: 4px; font-size: .8rem; font-weight: 500; }
    .badge-done { background: #d1fae5; color: #065f46; }
    .badge-progress { background: #dbeafe; color: #1e40af; }
    .badge-review { background: #fef3c7; color: #92400e; }
    .badge-other { background: #f3f4f6; color: #374151; }
    .footer { font-size: .8rem; color: #6c757d; margin-top: 1.5rem; }
  </style>
</head>
<body>
  <h1>Agent Performance Dashboard</h1>
  <p class="subtitle">Tracking AI agent task execution across the Agent Orchestration project</p>

  <div class="stats">
    <div class="stat">
      <div class="stat-value">${data.summary.totalIssues}</div>
      <div class="stat-label">Issues Tracked</div>
    </div>
    <div class="stat">
      <div class="stat-value">${data.summary.avgCycleTimeDays != null ? data.summary.avgCycleTimeDays.toFixed(1) : "N/A"}</div>
      <div class="stat-label">Avg Cycle Time (days)</div>
    </div>
    <div class="stat">
      <div class="stat-value">${data.summary.totalCommits}</div>
      <div class="stat-label">Total Commits</div>
    </div>
    <div class="stat">
      <div class="stat-value">${data.summary.totalLinesChanged.toLocaleString()}</div>
      <div class="stat-label">Lines Changed</div>
    </div>
  </div>

  <div class="charts">
    <div class="card"><canvas id="cycleChart"></canvas></div>
    <div class="card"><canvas id="commitChart"></canvas></div>
    <div class="card"><canvas id="linesChart"></canvas></div>
  </div>

  <table>
    <thead>
      <tr><th>Issue</th><th>Title</th><th>Status</th><th>Cycle (days)</th><th>Commits</th><th>Lines +/-</th><th>PR</th></tr>
    </thead>
    <tbody>${rows}
    </tbody>
  </table>

  <p class="footer">Generated: ${esc(data.generatedAt)}</p>

  <script>
    const labels = ${issueLabels};

    new Chart(document.getElementById('cycleChart'), {
      type: 'bar',
      data: {
        labels,
        datasets: [{ label: 'Cycle Time (days)', data: ${cycleTimes}, backgroundColor: '#6ea8fe' }]
      },
      options: {
        responsive: true,
        plugins: { legend: { display: false }, title: { display: true, text: 'Cycle Time per Issue' } },
        scales: { y: { beginAtZero: true } }
      }
    });

    new Chart(document.getElementById('commitChart'), {
      type: 'bar',
      data: {
        labels,
        datasets: [{ label: 'Commits', data: ${commitCounts}, backgroundColor: '#a3cfbb' }]
      },
      options: {
        responsive: true,
        plugins: { legend: { display: false }, title: { display: true, text: 'Commits per Issue' } },
        scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } }
      }
    });

    new Chart(document.getElementById('linesChart'), {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { label: 'Lines Added', data: ${linesAdded}, backgroundColor: '#a3cfbb' },
          { label: 'Lines Removed', data: ${linesRemoved}, backgroundColor: '#f4a0a0' }
        ]
      },
      options: {
        responsive: true,
        plugins: { title: { display: true, text: 'Lines Changed per Issue' } },
        scales: { y: { beginAtZero: true } }
      }
    });
  </script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Data collectors (side-effectful, not exported)
// ---------------------------------------------------------------------------

function collectGitMetrics() {
  const raw = run(
    'git log --all --no-merges --format="COMMIT|%h|%aI|%s" --numstat'
  );
  return parseGitLog(raw);
}

function collectPrData() {
  const raw = run(
    "gh pr list --state all --json number,title,headRefName,createdAt,mergedAt,reviews --limit 100"
  );
  return parsePrJson(raw);
}

async function collectLinearData(issueIds) {
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) {
    console.warn("LINEAR_API_KEY not set \u2014 skipping Linear data");
    return new Map();
  }

  const { LinearClient } = await import("@linear/sdk");
  const client = new LinearClient({ apiKey });
  const result = new Map();

  for (const id of issueIds) {
    try {
      const issue = await client.issue(id);
      const state = await issue.state;
      result.set(id, {
        title: issue.title,
        status: state?.name ?? "Unknown",
        createdAt: issue.createdAt?.toISOString?.() ?? issue.createdAt,
        completedAt: issue.completedAt?.toISOString?.() ?? issue.completedAt,
      });
    } catch (err) {
      console.warn(`Linear: could not fetch ${id}: ${err.message}`);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith("dashboard.mjs") ||
    process.argv[1].replace(/\\/g, "/").endsWith("scripts/dashboard.mjs"));

if (isMain) {
  try {
    console.log("Collecting metrics...\n");

    // 1. Git metrics
    const gitMetrics = collectGitMetrics();
    const gitMap = new Map(gitMetrics.map((g) => [g.id, g]));
    console.log(`  Git: found ${gitMetrics.length} issues from commit history`);

    // 2. GitHub PR data
    const prMap = collectPrData();
    console.log(`  GitHub: found ${prMap.size} PRs`);

    // 3. Discover all issue IDs
    const allIds = [
      ...new Set([...gitMap.keys(), ...prMap.keys()]),
    ].sort();

    // 4. Linear data
    const linearMap = await collectLinearData(allIds);
    console.log(`  Linear: fetched ${linearMap.size} issues`);

    // 5. Audit trails
    const auditDir = resolve(REPO_ROOT, "metrics", "audits");
    const auditEntries = loadAuditTrails(auditDir);
    console.log(`  Audits: found ${auditEntries.length} trail files`);

    // 6. Merge
    const entries = allIds.map((id) =>
      mergeMetrics(id, gitMap.get(id), prMap.get(id), linearMap.get(id), auditEntries)
    );

    const data = {
      generatedAt: new Date().toISOString(),
      issues: entries,
      summary: computeSummary(entries),
    };

    // 7. Write outputs
    const metricsDir = resolve(REPO_ROOT, "metrics");
    mkdirSync(metricsDir, { recursive: true });

    const jsonPath = resolve(metricsDir, "dashboard-data.json");
    writeFileSync(jsonPath, JSON.stringify(data, null, 2));
    console.log(`\nMetrics written to ${jsonPath}`);

    const htmlPath = resolve(metricsDir, "dashboard.html");
    writeFileSync(htmlPath, renderHtml(data));
    console.log(`Dashboard written to ${htmlPath}`);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}
