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

/**
 * Runs tests up to `retries` times. Returns { passed, flaky, outputs[] }.
 * Accepts an optional `execFn` for testing (defaults to execSync with npm test).
 */
export function runTestsWithRetry(retries = MAX_RETRIES, execFn = null) {
  const run = execFn || (() => execSync("npm test 2>&1", {
    encoding: "utf-8",
    cwd: PROJECT_ROOT,
    timeout: 120000,
  }));

  const outputs = [];
  for (let i = 0; i < retries; i++) {
    try {
      const output = run();
      outputs.push(output);
      return {
        passed: true,
        flaky: i > 0,
        outputs,
      };
    } catch (err) {
      outputs.push(err.stdout || err.stderr || err.message || "");
    }
  }

  return { passed: false, flaky: false, outputs };
}
