/**
 * Claude Code "Stop" hook.
 *
 * Runs when the agent is about to finish. If the current branch is linked to
 * a Linear issue and the agent hasn't mentioned updating Linear, it blocks
 * and reminds the agent to update the issue status and post a summary comment.
 *
 * Input (stdin): JSON with { stop_hook_active, last_assistant_message, ... }
 * Output (stdout): JSON with { decision, reason } to block, or nothing to allow.
 */

import { getBranch, extractIssueId } from "./linear-helpers.mjs";

// Patterns that indicate the agent already updated Linear this turn
const UPDATED_PATTERNS = [
  /linear\.mjs\s+(status|comment|link-pr)/i,
  /update[d]?\s+(the\s+)?linear/i,
  /move[d]?\s+.*\s+to\s+(in progress|in review|done|backlog|todo)/i,
  /post(ed)?\s+(a\s+)?comment\s+(on|to)\s+(the\s+)?linear/i,
  /\bupdate_issue\b/i,
  /\bcreate_comment\b/i,
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

  // Prevent infinite loops — if the hook already fired once, let the agent finish
  if (data.stop_hook_active) {
    process.exit(0);
  }

  const branch = getBranch();
  const issueId = extractIssueId(branch);

  // No Linear issue on this branch — nothing to do
  if (!issueId) {
    process.exit(0);
  }

  const lastMsg = data.last_assistant_message || "";

  // Check if the agent already mentioned updating Linear
  const alreadyUpdated = UPDATED_PATTERNS.some((re) => re.test(lastMsg));
  if (alreadyUpdated) {
    process.exit(0);
  }

  // Block and remind the agent
  const result = {
    decision: "block",
    reason: [
      `You are working on Linear issue ${issueId}.`,
      `Before finishing, please update Linear:`,
      `1. Update the issue status if appropriate using the Linear MCP update_issue tool (set state to "In Progress", "In Review", or "Done")`,
      `2. Post a summary comment using the Linear MCP create_comment tool describing what was accomplished`,
      `If MCP tools are unavailable, use the CLI fallback:`,
      `   LINEAR_API_KEY="$LINEAR_API_KEY" node scripts/linear.mjs status ${issueId} "In Progress"`,
      `   LINEAR_API_KEY="$LINEAR_API_KEY" node scripts/linear.mjs comment ${issueId} "<summary of work done>"`,
    ].join("\n"),
  };

  console.log(JSON.stringify(result));
} catch (err) {
  // If the hook itself fails, don't block the agent — just let it finish
  console.error(`check-linear-update hook error: ${err.message}`);
  process.exit(0);
}
