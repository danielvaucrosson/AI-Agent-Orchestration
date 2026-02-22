/**
 * Extracts a Linear issue identifier (e.g. TES-42) from the branch name,
 * PR title, or PR body.  Sets a GitHub Actions output so downstream steps
 * can reference it.
 *
 * Linear identifiers follow the pattern: 1-5 uppercase letters, a dash,
 * then one or more digits  (e.g. TES-1, ENG-123, ACME-9).
 */

// Linear issue IDs: uppercase team key + dash + number
const ISSUE_RE = /\b([A-Z]{1,5}-\d+)\b/;

function extract(sources) {
  for (const text of sources) {
    if (!text) continue;
    const match = text.match(ISSUE_RE);
    if (match) return match[1];
  }
  return "";
}

const branchName = process.env.BRANCH_NAME || "";
const prTitle = process.env.PR_TITLE || "";
const prBody = process.env.PR_BODY || "";

const issueId = extract([branchName, prTitle, prBody]);

if (issueId) {
  console.log(`Detected Linear issue: ${issueId}`);
} else {
  console.log("No Linear issue ID found in branch name, PR title, or PR body.");
}

// Write to $GITHUB_OUTPUT so subsequent steps can use it
import { appendFileSync } from "node:fs";
const outputFile = process.env.GITHUB_OUTPUT;
if (outputFile) {
  appendFileSync(outputFile, `issue_id=${issueId}\n`);
} else {
  // Running locally — just print
  console.log(`issue_id=${issueId}`);
}
