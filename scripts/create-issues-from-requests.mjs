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
 *   GITHUB_STEP_SUMMARY — path to write job summary
 */

import { readdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";

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
    // Write body to temp file to avoid shell escaping issues
    const bodyFile = join(tmpdir(), `issue-body-${Date.now()}.md`);
    writeFileSync(bodyFile, req.body || "");

    const args = ["issue", "create", "--title", req.title, "--body-file", bodyFile];
    for (const label of req.labels || []) {
      args.push("--label", label);
    }

    const url = execFileSync("gh", args, { encoding: "utf8" }).trim();
    const number = url.match(/\/(\d+)$/)?.[1] || "?";
    console.log(`GitHub issue #${number}: ${url}`);
    ghResults.push({ file: req.file, number, url, title: req.title, body: req.body || "", linear: req.linear || {} });
  } catch (err) {
    console.error(`GitHub issue creation failed for "${req.title}": ${err.stderr || err.message}`);
  }
}

// ── Linear issue creation (via SDK) ────────────────────────────────────

const linearResults = [];
const linearApiKey = process.env.LINEAR_API_KEY;

if (linearApiKey && ghResults.length > 0) {
  let LinearClient;
  try {
    const mod = await import("@linear/sdk");
    LinearClient = mod.LinearClient;
    console.log("Linear SDK loaded successfully");
  } catch (err) {
    console.error(`Linear SDK import failed: ${err.message}`);
    console.error(err.stack);
  }

  if (LinearClient) {
    try {
      const client = new LinearClient({ apiKey: linearApiKey });

      // Verify connection
      const viewer = await client.viewer;
      console.log(`Linear authenticated as: ${viewer.name}`);

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
            console.log(`Resolved team: ${team.name} (${team.key})`);
            teamCache.set(teamKey, team);
          }
          const team = teamCache.get(teamKey);

          // Get target state
          const states = await team.states();
          const state = states.nodes.find(
            (s) => s.name.toLowerCase() === status.toLowerCase()
          );
          if (!state) {
            const available = states.nodes.map((s) => s.name).join(", ");
            throw new Error(`State "${status}" not found. Available: ${available}`);
          }

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
          console.error(err.stack);
        }
      }
    } catch (err) {
      console.error(`Linear client error: ${err.message}`);
      console.error(err.stack);
    }
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
