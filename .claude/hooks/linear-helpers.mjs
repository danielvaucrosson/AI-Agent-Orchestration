/**
 * Shared helpers for Claude Code hooks that need Linear issue context.
 * Extracts the Linear issue ID from the current git branch name.
 */

import { execSync } from "node:child_process";

const ISSUE_RE = /\b([A-Z]{1,5}-\d+)\b/;

/**
 * Returns the current git branch name, or "" if not in a git repo.
 */
export function getBranch() {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return "";
  }
}

/**
 * Extracts a Linear issue ID (e.g. DVA-5) from the given text.
 * Returns the ID string or "" if none found.
 */
export function extractIssueId(text) {
  const match = text.match(ISSUE_RE);
  return match ? match[1] : "";
}
