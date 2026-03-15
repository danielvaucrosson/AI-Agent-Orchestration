/**
 * Process issue request JSON files from .github/issue-requests/.
 * Creates issues in GitHub (via gh CLI) and Linear (via SDK).
 *
 * Called by the create-issue.yml workflow — not intended for local use.
 *
 * JSON schema:
 *   {
 *     "title": "Issue title",
 *     "body": "Markdown body",
 *     "labels": ["bug"],
 *     "linear": { "team": "DVA", "status": "Backlog", "labels": ["size:small"] }
 *   }
 *
 * Environment:
 *   GITHUB_TOKEN     — provided by GitHub Actions
 *   LINEAR_API_KEY   — optional, skips Linear if missing
 *   GITHUB_REPOSITORY — e.g. "owner/repo"
 *   GITHUB_STEP_SUMMARY — path to write job summary
 */

import { readdirSync, readFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

const DIR = ".github/issue-requests";

// ── Collect request files ──────────────────────────────────────────────

if (!existsSync(DIR)) {
  console.log("No issue-requests directory found");
  process.exit(0);
}

const files = readdirSync(DIR).filter((f) => f.endsWith(".json"));
if (files.length === 0) {
  console.log("No issue request files found");
  process.exit(0);
}

const requests = files.map((file) => ({
  file,
  ...JSON.parse(readFileSync(join(DIR, file), "utf8")),
}));

// ── GitHub issue creation (via gh CLI) ─────────────────────────────────

const ghResults = [];

for (const req of requests) {
  try {
    const labelArgs = (req.labels || []).map((l) => `--label "${l}"`).join(" ");
    const cmd = `gh issue create --title "${req.title.replace(/"/g, '\\"')}" --body "${(req.body || "").replace(/"/g, '\\"')}" ${labelArgs}`;
    const url = execSync(cmd, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
    const number = url.match(/\/(\d+)$/)?.[1] || "?";
    console.log(`GitHub issue #${number}: ${url}`);
    ghResults.push({ file: req.file, number, url, title: req.title, body: req.body || "", linear: req.linear || {} });
  } catch (err) {
    console.error(`GitHub issue creation failed for "${req.title}": ${err.message}`);
  }
}

// ── Linear issue creation (via SDK) ────────────────────────────────────

const linearResults = [];
const linearApiKey = process.env.LINEAR_API_KEY;

if (linearApiKey && ghResults.length > 0) {
  try {
    const { LinearClient } = await import("@linear/sdk");
    const client = new LinearClient({ apiKey: linearApiKey });

    const teamCache = new Map();

    for (const item of ghResults) {
      try {
        const teamKey = item.linear.team || "DVA";
        const status = item.linear.status || "Backlog";
        const linearLabels = item.linear.labels || [];

        // Get team (cached)
        if (!teamCache.has(teamKey)) {
          const teams = await client.teams();
          const team = teams.nodes.find((t) => t.key === teamKey);
          if (!team) throw new Error(`Team not found: ${teamKey}`);
          teamCache.set(teamKey, team);
        }
        const team = teamCache.get(teamKey);

        // Get target state
        const states = await team.states();
        const state = states.nodes.find(
          (s) => s.name.toLowerCase() === status.toLowerCase()
        );
        if (!state) throw new Error(`State "${status}" not found`);

        // Resolve label IDs
        let labelIds = [];
        if (linearLabels.length > 0) {
          const teamLabelNodes = await team.labels();
          labelIds = linearLabels
            .map((name) => teamLabelNodes.nodes.find((l) => l.name === name))
            .filter(Boolean)
            .map((l) => l.id);
        }

        // Build body with GitHub issue link
        const linkedBody = `${item.body}\n\n---\nGitHub issue: ${item.url}`;

        // Create issue
        const payload = await client.createIssue({
          teamId: team.id,
          title: item.title,
          description: linkedBody,
          stateId: state.id,
          ...(labelIds.length > 0 && { labelIds }),
        });
        const linearIssue = await payload.issue;

        console.log(`Linear issue ${linearIssue.identifier}: ${linearIssue.url}`);
        linearResults.push({
          file: item.file,
          identifier: linearIssue.identifier,
          url: linearIssue.url,
        });
      } catch (err) {
        console.error(`Linear creation failed for "${item.title}": ${err.message}`);
      }
    }
  } catch (err) {
    console.error(`Linear SDK init failed: ${err.message}`);
  }
} else if (!linearApiKey) {
  console.log("No LINEAR_API_KEY — skipping Linear issue creation");
}

// ── Job summary ────────────────────────────────────────────────────────

const summaryFile = process.env.GITHUB_STEP_SUMMARY;
if (summaryFile) {
  let summary = "### Issues Created\n\n";
  summary += "| Source | ID | Link |\n|--------|-----|------|\n";
  for (const c of ghResults) {
    summary += `| GitHub | #${c.number} | [${c.url}](${c.url}) |\n`;
    const lr = linearResults.find((l) => l.file === c.file);
    if (lr) {
      summary += `| Linear | ${lr.identifier} | [${lr.url}](${lr.url}) |\n`;
    }
  }
  appendFileSync(summaryFile, summary);
}

console.log(`Done — ${ghResults.length} GitHub + ${linearResults.length} Linear issues created.`);
