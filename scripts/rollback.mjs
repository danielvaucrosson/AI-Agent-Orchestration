// scripts/rollback.mjs
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..");

const MAX_RETRIES = 3;
const MAX_BISECT_ITERATIONS = 5;
const LINEAR_SCRIPT = join(__dirname, "linear.mjs");

// Linear issue IDs: uppercase team key + dash + number
const ISSUE_RE = /\b([A-Z]{1,5}-\d+)\b/;

export function extractIssueId(text) {
  if (!text) return null;
  const match = text.match(ISSUE_RE);
  return match ? match[1] : null;
}
