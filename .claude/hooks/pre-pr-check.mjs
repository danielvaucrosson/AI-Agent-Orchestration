/**
 * Claude Code "PreToolUse" hook for pre-PR review gating.
 *
 * Intercepts Bash commands that create PRs (gh pr create) and checks
 * whether the agent has already run the pre-PR review. If not, it
 * blocks the PR creation and reminds the agent to run the review first.
 *
 * Input (stdin): JSON with { tool_name, tool_input }
 * Output (stdout): JSON with { decision, reason } to block, or nothing to allow.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..", "..");

// Marker file created when the review passes
const REVIEW_MARKER = join(PROJECT_ROOT, ".claude", "audit", "_review-passed.marker");

// Patterns that indicate PR creation commands.
// Anchored so `gh` must be at command start or after a separator (&&, ||, ;, |)
// to avoid false positives when "gh pr create" appears inside quoted text
// (e.g., in a git commit message describing this hook).
const PR_CREATE_PATTERNS = [
  /(?:^|(?:&&|\|\||[;&|])\s*)gh\s+pr\s+create\b/,
];

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
    process.stdin.resume();
  });
}

try {
  const input = await readStdin();
  const data = JSON.parse(input);

  // Only act on Bash tool calls
  if (data.tool_name !== "Bash") {
    process.exit(0);
  }

  const command = data.tool_input?.command || "";

  // Check if this is a PR creation command
  const isPRCreate = PR_CREATE_PATTERNS.some((re) => re.test(command));

  if (!isPRCreate) {
    process.exit(0);
  }

  // Check if the command includes --force or --skip-review override
  if (/--force\b|--skip-review\b/.test(command)) {
    process.exit(0);
  }

  // Check if the review has already been run and passed
  if (existsSync(REVIEW_MARKER)) {
    // Read the marker to check timestamp (stale after 30 minutes)
    try {
      const markerContent = readFileSync(REVIEW_MARKER, "utf-8").trim();
      const markerTime = new Date(markerContent);
      const now = new Date();
      const ageMinutes = (now - markerTime) / (1000 * 60);

      if (ageMinutes < 30) {
        // Review is recent — allow PR creation
        process.exit(0);
      }
    } catch {
      // Marker exists but can't be read — proceed with reminder
    }
  }

  // Block and remind the agent to run the review
  const result = {
    decision: "block",
    reason: [
      "⚠️  Pre-PR review has not been run yet.",
      "",
      "Before creating a PR, please run the quality gate review:",
      "",
      "  node scripts/pre-pr-review.mjs",
      "",
      "This checks: tests, security, conventions, code quality, and diff size.",
      "If all gates pass, proceed with the PR creation.",
      "If gates fail, fix the issues first or use --force to override for urgent fixes.",
      "",
      "To skip this check, add --force to your gh pr create command.",
    ].join("\n"),
  };

  console.log(JSON.stringify(result));
} catch (err) {
  // If the hook fails, don't block — just let the command proceed
  process.exit(0);
}
