# Rollback Orchestration Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically detect test failures on `main`, isolate the culprit merge via bisection, create a revert PR, and notify via Linear + GitHub.

**Architecture:** A thin GitHub Actions workflow (`rollback.yml`) triggers on pushes to `main` and delegates to `scripts/rollback.mjs`. The script handles flaky detection (3 retries), bisection over merge commits, revert PR creation via `gh`, and notifications via Linear CLI + GitHub API.

**Tech Stack:** Node.js 20+, GitHub Actions, `@linear/sdk`, `gh` CLI, `node:child_process`, `node --test`

**Spec:** `docs/superpowers/specs/2026-03-14-rollback-orchestration-design.md`

---

## Chunk 1: Core Pure Logic

### Task 1: `extractIssueId` — test and implement

**Files:**
- Create: `tests/rollback.test.mjs`
- Create: `scripts/rollback.mjs`

- [ ] **Step 1: Write failing tests for `extractIssueId`**

Create `tests/rollback.test.mjs` with this exact content:

```javascript
// tests/rollback.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractIssueId,
} from "../scripts/rollback.mjs";

describe("extractIssueId", () => {
  it("extracts issue ID from merge commit message", () => {
    assert.equal(extractIssueId("Merge pull request #5 from feature/DVA-5-add-readme"), "DVA-5");
  });

  it("extracts issue ID from PR title format", () => {
    assert.equal(extractIssueId("DVA-12: Fix the auth flow"), "DVA-12");
  });

  it("returns null when no issue ID found", () => {
    assert.equal(extractIssueId("Update dependencies"), null);
  });

  it("extracts first match when multiple IDs present", () => {
    assert.equal(extractIssueId("DVA-5: relates to DVA-10"), "DVA-5");
  });

  it("handles empty string", () => {
    assert.equal(extractIssueId(""), null);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/rollback.test.mjs`
Expected: FAIL — `extractIssueId` not found

- [ ] **Step 3: Implement `extractIssueId`**

Create `scripts/rollback.mjs` with this exact content:

```javascript
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/rollback.test.mjs`
Expected: PASS — all 5 tests green

- [ ] **Step 5: Commit**

```bash
git add scripts/rollback.mjs tests/rollback.test.mjs
git commit -m "DVA-17: add extractIssueId with tests"
```

---

### Task 2: `runTestsWithRetry` — test and implement

**Files:**
- Modify: `tests/rollback.test.mjs`
- Modify: `scripts/rollback.mjs`

- [ ] **Step 1: Write failing tests for `runTestsWithRetry`**

Update the import block at the top of `tests/rollback.test.mjs` to add `runTestsWithRetry`:

```javascript
import {
  extractIssueId,
  runTestsWithRetry,
} from "../scripts/rollback.mjs";
```

Then append this describe block at the end of the file:

```javascript
describe("runTestsWithRetry", () => {
  it("returns passed=true on first success", () => {
    const execMock = () => "pass 5\nfail 0";
    const result = runTestsWithRetry(3, execMock);
    assert.equal(result.passed, true);
    assert.equal(result.flaky, false);
    assert.equal(result.outputs.length, 1);
  });

  it("returns flaky=true when second attempt passes", () => {
    let call = 0;
    const execMock = () => {
      call++;
      if (call === 1) {
        const err = new Error("test failed");
        err.stdout = "fail 2\npass 3";
        err.stderr = "";
        throw err;
      }
      return "pass 5\nfail 0";
    };
    const result = runTestsWithRetry(3, execMock);
    assert.equal(result.passed, true);
    assert.equal(result.flaky, true);
    assert.equal(result.outputs.length, 2);
  });

  it("returns passed=false when all attempts fail", () => {
    const execMock = () => {
      const err = new Error("test failed");
      err.stdout = "fail 5\npass 0";
      err.stderr = "";
      throw err;
    };
    const result = runTestsWithRetry(3, execMock);
    assert.equal(result.passed, false);
    assert.equal(result.flaky, false);
    assert.equal(result.outputs.length, 3);
  });

  it("returns flaky=true when third attempt passes", () => {
    let call = 0;
    const execMock = () => {
      call++;
      if (call <= 2) {
        const err = new Error("test failed");
        err.stdout = "fail 1";
        err.stderr = "";
        throw err;
      }
      return "pass 5\nfail 0";
    };
    const result = runTestsWithRetry(3, execMock);
    assert.equal(result.passed, true);
    assert.equal(result.flaky, true);
    assert.equal(result.outputs.length, 3);
  });
});
```

- [ ] **Step 2: Run tests to verify new tests fail**

Run: `node --test tests/rollback.test.mjs`
Expected: FAIL — `runTestsWithRetry` not exported

- [ ] **Step 3: Implement `runTestsWithRetry`**

Append to `scripts/rollback.mjs` (after `extractIssueId`):

```javascript
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/rollback.test.mjs`
Expected: PASS — all tests green

- [ ] **Step 5: Commit**

```bash
git add scripts/rollback.mjs tests/rollback.test.mjs
git commit -m "DVA-17: add runTestsWithRetry with flaky detection"
```

---

### Task 3: `bisectCulprit` — test and implement

**Files:**
- Modify: `tests/rollback.test.mjs`
- Modify: `scripts/rollback.mjs`

- [ ] **Step 1: Write failing tests for `bisectCulprit`**

Update the import block at the top of `tests/rollback.test.mjs` to add `bisectCulprit`:

```javascript
import {
  extractIssueId,
  runTestsWithRetry,
  bisectCulprit,
} from "../scripts/rollback.mjs";
```

Then append this describe block at the end of the file:

```javascript
describe("bisectCulprit", () => {
  it("returns the only merge when list has one entry", () => {
    const result = bisectCulprit(
      [{ sha: "aaa", message: "merge A" }],
      () => true // test function (not called for single entry)
    );
    assert.equal(result.sha, "aaa");
  });

  it("isolates culprit in second half", () => {
    // Merges: M1(ok), M2(ok), M3(bad), M4(bad)
    // M3 is the culprit — tests pass at M2, fail at M3
    const merges = [
      { sha: "m1", message: "merge 1" },
      { sha: "m2", message: "merge 2" },
      { sha: "m3", message: "merge 3" },
      { sha: "m4", message: "merge 4" },
    ];
    const testAtSha = (sha) => sha === "m1" || sha === "m2";
    const result = bisectCulprit(merges, testAtSha);
    assert.equal(result.sha, "m3");
  });

  it("isolates culprit in first half", () => {
    // M1 is the culprit — tests fail from M1 onward
    const merges = [
      { sha: "m1", message: "merge 1" },
      { sha: "m2", message: "merge 2" },
      { sha: "m3", message: "merge 3" },
    ];
    const testAtSha = () => false; // all fail
    const result = bisectCulprit(merges, testAtSha);
    assert.equal(result.sha, "m1");
  });

  it("handles two merges correctly", () => {
    const merges = [
      { sha: "m1", message: "merge 1" },
      { sha: "m2", message: "merge 2" },
    ];
    // Tests pass at m1, fail at m2 => m2 is culprit
    const testAtSha = (sha) => sha === "m1";
    const result = bisectCulprit(merges, testAtSha);
    assert.equal(result.sha, "m2");
  });

  it("allows bisection for exactly 32 merges (within cap)", () => {
    const merges = Array.from({ length: 32 }, (_, i) => ({
      sha: `m${i}`,
      message: `merge ${i}`,
    }));
    // Only m0 passes, so culprit is m1
    const testAtSha = (sha) => sha === "m0";
    const result = bisectCulprit(merges, testAtSha, 5);
    assert.equal(result.sha, "m1");
    assert.equal(result.skippedBisection, undefined);
  });

  it("respects safety cap for 33+ merges and returns last merge", () => {
    const merges = Array.from({ length: 33 }, (_, i) => ({
      sha: `m${i}`,
      message: `merge ${i}`,
    }));
    let testCallCount = 0;
    const testAtSha = () => { testCallCount++; return false; };
    const result = bisectCulprit(merges, testAtSha, 5);
    assert.equal(result.sha, "m32");
    assert.equal(result.skippedBisection, true);
    assert.equal(testCallCount, 0);
  });
});
```

- [ ] **Step 2: Run tests to verify new tests fail**

Run: `node --test tests/rollback.test.mjs`
Expected: FAIL — `bisectCulprit` not found

- [ ] **Step 3: Implement `bisectCulprit`**

Append to `scripts/rollback.mjs`:

```javascript
/**
 * Binary search over merge commits to find the first one that breaks tests.
 * `merges` is an array of { sha, message } ordered oldest-to-newest.
 * `testFn(sha)` returns true if tests pass at that SHA, false if they fail.
 * Returns the culprit merge object, with optional `skippedBisection` flag.
 */
export function bisectCulprit(merges, testFn, maxIterations = MAX_BISECT_ITERATIONS) {
  if (merges.length === 0) return null;
  if (merges.length === 1) return merges[0];

  // Safety cap: if too many merges, skip bisection (33+ merges for default cap of 5)
  if (Math.ceil(Math.log2(merges.length)) > maxIterations) {
    const last = merges[merges.length - 1];
    return { ...last, skippedBisection: true };
  }

  let lo = 0;
  let hi = merges.length - 1;

  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const passes = testFn(merges[mid].sha);
    if (passes) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }

  return merges[lo];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/rollback.test.mjs`
Expected: PASS — all tests green

- [ ] **Step 5: Commit**

```bash
git add scripts/rollback.mjs tests/rollback.test.mjs
git commit -m "DVA-17: add bisectCulprit with safety cap"
```

---

## Chunk 2: Shell-Calling Functions

### Task 4: `findLastGreenSha` — test and implement

**Files:**
- Modify: `tests/rollback.test.mjs`
- Modify: `scripts/rollback.mjs`

- [ ] **Step 1: Write failing tests for `findLastGreenSha`**

Update the import block at the top of `tests/rollback.test.mjs`:

```javascript
import {
  extractIssueId,
  runTestsWithRetry,
  bisectCulprit,
  findLastGreenSha,
} from "../scripts/rollback.mjs";
```

Append this describe block:

```javascript
describe("findLastGreenSha", () => {
  it("returns SHA from last successful workflow run", () => {
    const execMock = () => JSON.stringify([
      { conclusion: "success", headSha: "abc1234def5678" },
    ]);
    const result = findLastGreenSha(execMock);
    assert.equal(result, "abc1234def5678");
  });

  it("skips failed runs and returns first success", () => {
    const execMock = () => JSON.stringify([
      { conclusion: "failure", headSha: "bad1" },
      { conclusion: "success", headSha: "good1" },
    ]);
    const result = findLastGreenSha(execMock);
    assert.equal(result, "good1");
  });

  it("returns null when no successful runs exist", () => {
    const execMock = () => JSON.stringify([
      { conclusion: "failure", headSha: "bad1" },
    ]);
    const result = findLastGreenSha(execMock);
    assert.equal(result, null);
  });

  it("returns null when API returns empty array", () => {
    const execMock = () => "[]";
    const result = findLastGreenSha(execMock);
    assert.equal(result, null);
  });
});
```

- [ ] **Step 2: Run tests to verify new tests fail**

Run: `node --test tests/rollback.test.mjs`
Expected: FAIL — `findLastGreenSha` not found

- [ ] **Step 3: Implement `findLastGreenSha`**

Append to `scripts/rollback.mjs`:

```javascript
/**
 * Queries GitHub Actions API for the last successful run of the rollback workflow.
 * Uses `conclusion=success` (not `status=success`) to filter by outcome.
 * Returns the head SHA of that run, or null if none found.
 * Accepts optional execFn for testing.
 */
export function findLastGreenSha(execFn = null) {
  const run = execFn || (() => execSync(
    'gh api "/repos/{owner}/{repo}/actions/workflows/rollback.yml/runs?branch=main&conclusion=success&per_page=5" --jq ".workflow_runs | map({conclusion, headSha: .head_sha})"',
    { encoding: "utf-8", cwd: PROJECT_ROOT }
  ));

  try {
    const data = JSON.parse(run());
    const success = data.find((r) => r.conclusion === "success");
    return success ? success.headSha : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/rollback.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/rollback.mjs tests/rollback.test.mjs
git commit -m "DVA-17: add findLastGreenSha"
```

---

### Task 5: `getMergeCommitsSince` — test and implement

**Files:**
- Modify: `tests/rollback.test.mjs`
- Modify: `scripts/rollback.mjs`

- [ ] **Step 1: Write failing tests for `getMergeCommitsSince`**

Update the import block at the top of `tests/rollback.test.mjs`:

```javascript
import {
  extractIssueId,
  runTestsWithRetry,
  bisectCulprit,
  findLastGreenSha,
  getMergeCommitsSince,
} from "../scripts/rollback.mjs";
```

Append this describe block:

```javascript
describe("getMergeCommitsSince", () => {
  it("parses git log output into merge objects", () => {
    const execMock = () => "abc1234 Merge pull request #5 from feature/DVA-5\ndef5678 Merge pull request #6 from fix/DVA-6";
    const result = getMergeCommitsSince("base123", execMock);
    assert.equal(result.length, 2);
    assert.equal(result[0].sha, "abc1234");
    assert.equal(result[0].message, "Merge pull request #5 from feature/DVA-5");
    assert.equal(result[1].sha, "def5678");
  });

  it("returns empty array when no merges found", () => {
    const execMock = () => "";
    const result = getMergeCommitsSince("base123", execMock);
    assert.deepEqual(result, []);
  });

  it("works when baseSha is null", () => {
    // Note: the -n 50 limit in the real command is verified by code review,
    // not by this mock (the mock replaces the entire exec call).
    const execMock = () => "abc1234 Some merge commit";
    const result = getMergeCommitsSince(null, execMock);
    assert.equal(result.length, 1);
  });
});
```

- [ ] **Step 2: Run tests to verify new tests fail**

Run: `node --test tests/rollback.test.mjs`
Expected: FAIL — `getMergeCommitsSince` not found

- [ ] **Step 3: Implement `getMergeCommitsSince`**

Append to `scripts/rollback.mjs`:

```javascript
/**
 * Lists merge commits between baseSha and HEAD.
 * Returns array of { sha, message } ordered oldest-to-newest.
 * If baseSha is null, uses HEAD with -n 50 limit.
 */
export function getMergeCommitsSince(baseSha, execFn = null) {
  const range = baseSha ? `${baseSha}..HEAD` : "HEAD";
  const limit = baseSha ? "" : " -n 50";
  const cmd = `git log --merges --reverse --format="%H %s"${limit} ${range}`;

  const run = execFn || (() => execSync(cmd, {
    encoding: "utf-8",
    cwd: PROJECT_ROOT,
  }));

  const output = run().trim();
  if (!output) return [];

  return output.split("\n").map((line) => {
    const spaceIdx = line.indexOf(" ");
    return {
      sha: line.substring(0, spaceIdx),
      message: line.substring(spaceIdx + 1),
    };
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/rollback.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/rollback.mjs tests/rollback.test.mjs
git commit -m "DVA-17: add getMergeCommitsSince"
```

---

### Task 6: `createRevertPR` — test and implement

**Files:**
- Modify: `tests/rollback.test.mjs`
- Modify: `scripts/rollback.mjs`

- [ ] **Step 1: Write failing tests for `createRevertPR`**

Update the import block at the top of `tests/rollback.test.mjs`:

```javascript
import {
  extractIssueId,
  runTestsWithRetry,
  bisectCulprit,
  findLastGreenSha,
  getMergeCommitsSince,
  createRevertPR,
} from "../scripts/rollback.mjs";
```

Append this describe block:

```javascript
describe("createRevertPR", () => {
  it("runs correct git and gh commands for merge commit with issue ID", () => {
    const commands = [];
    const execMock = (cmd) => {
      commands.push(cmd);
      if (cmd.includes("gh pr create")) return "https://github.com/owner/repo/pull/99";
      if (cmd.includes("git log")) return "DVA-5: Add readme feature";
      return "";
    };

    const result = createRevertPR({
      sha: "abc1234def5678",
      message: "Merge pull request #5 from feature/DVA-5-add-readme",
      isMergeCommit: true,
      issueId: "DVA-5",
      failureOutput: "test_math failed: expected 4 got 5",
    }, execMock);

    assert.ok(commands.some((c) => c.includes("git checkout -b revert/dva-5-")));
    assert.ok(commands.some((c) => c.includes("git revert abc1234def5678 -m 1 --no-edit")));
    assert.ok(commands.some((c) => c.includes("git push")));
    assert.ok(commands.some((c) => c.includes("gh pr create")));
    assert.equal(result.prUrl, "https://github.com/owner/repo/pull/99");
  });

  it("omits -m 1 flag for non-merge commits", () => {
    const commands = [];
    const execMock = (cmd) => {
      commands.push(cmd);
      if (cmd.includes("gh pr create")) return "https://github.com/owner/repo/pull/100";
      if (cmd.includes("git log")) return "Direct push commit";
      return "";
    };

    createRevertPR({
      sha: "def4567abc1234",
      message: "Direct push commit",
      isMergeCommit: false,
      issueId: null,
      failureOutput: "test failed",
    }, execMock);

    const revertCmd = commands.find((c) => c.includes("git revert"));
    assert.ok(revertCmd);
    assert.ok(!revertCmd.includes("-m 1"));
  });

  it("uses commit subject in PR title when no issue ID", () => {
    const commands = [];
    const execMock = (cmd) => {
      commands.push(cmd);
      if (cmd.includes("gh pr create")) return "https://github.com/owner/repo/pull/101";
      if (cmd.includes("git log")) return "Some commit without issue";
      return "";
    };

    createRevertPR({
      sha: "ghi7890abc1234",
      message: "Some commit without issue",
      isMergeCommit: true,
      issueId: null,
      failureOutput: "test failed",
    }, execMock);

    const prCmd = commands.find((c) => c.includes("gh pr create"));
    assert.ok(prCmd.includes("Revert:"));
    assert.ok(!prCmd.includes("DVA-"));
  });
});
```

- [ ] **Step 2: Run tests to verify new tests fail**

Run: `node --test tests/rollback.test.mjs`
Expected: FAIL — `createRevertPR` not found

- [ ] **Step 3: Implement `createRevertPR`**

Append to `scripts/rollback.mjs`:

```javascript
/**
 * Creates a revert branch, reverts the culprit commit, pushes, and opens a PR.
 * Returns { prUrl, branchName }.
 */
export function createRevertPR(culprit, execFn = null) {
  const { sha, message, isMergeCommit, issueId, failureOutput } = culprit;
  const run = execFn || ((cmd) => execSync(cmd, { encoding: "utf-8", cwd: PROJECT_ROOT }).trim());

  // Get the original commit subject for the PR title
  const commitSubject = run(`git log --format="%s" -1 ${sha}`);

  // Build branch name (lowercase, with short SHA suffix)
  const shortDesc = (issueId || "unknown").toLowerCase();
  const branchName = `revert/${shortDesc}-${sha.substring(0, 7)}`;

  // Create revert branch
  run(`git checkout -b ${branchName}`);

  // Revert the commit (use -m 1 for merge commits)
  const revertFlag = isMergeCommit ? " -m 1" : "";
  run(`git revert ${sha}${revertFlag} --no-edit`);

  // Push the branch
  run(`git push origin ${branchName}`);

  // Build PR title and body
  const prTitle = issueId
    ? `Revert ${issueId}: ${commitSubject}`
    : `Revert: ${commitSubject}`;

  const truncatedOutput = (failureOutput || "").substring(0, 2000);
  const prBody = [
    "## Automated Rollback",
    "",
    `Tests failed on \`main\` after commit ${sha.substring(0, 7)}.`,
    "",
    "### Failure Output",
    "```",
    truncatedOutput,
    "```",
    "",
    "**This revert PR requires human approval to merge.**",
  ].join("\n");

  // Create the PR
  const prUrl = run(`gh pr create --title "${prTitle}" --body "${prBody.replace(/"/g, '\\"')}" --base main --head ${branchName}`);

  // Return to main
  run("git checkout main");

  return { prUrl, branchName };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/rollback.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/rollback.mjs tests/rollback.test.mjs
git commit -m "DVA-17: add createRevertPR"
```

---

## Chunk 3: Notification Functions

### Task 7: `updateLinear` and `postRevertLink` — test and implement

**Files:**
- Modify: `tests/rollback.test.mjs`
- Modify: `scripts/rollback.mjs`

- [ ] **Step 1: Write failing tests for `updateLinear` and `postRevertLink`**

Update the import block at the top of `tests/rollback.test.mjs`:

```javascript
import {
  extractIssueId,
  runTestsWithRetry,
  bisectCulprit,
  findLastGreenSha,
  getMergeCommitsSince,
  createRevertPR,
  updateLinear,
  postRevertLink,
} from "../scripts/rollback.mjs";
```

Append these describe blocks:

```javascript
describe("updateLinear", () => {
  it("calls linear.mjs with correct status and comment", () => {
    const commands = [];
    const execMock = (cmd) => { commands.push(cmd); return ""; };

    updateLinear("DVA-5", {
      failureOutput: "test_math failed",
      culpritSha: "abc1234",
      usedBisection: true,
    }, execMock);

    assert.ok(commands.some((c) => c.includes("linear.mjs") && c.includes("status") && c.includes("DVA-5") && c.includes("In Progress")));
    assert.ok(commands.some((c) => c.includes("linear.mjs") && c.includes("comment") && c.includes("DVA-5")));
  });

  it("skips when issueId is null", () => {
    const commands = [];
    const execMock = (cmd) => { commands.push(cmd); return ""; };

    updateLinear(null, { failureOutput: "test failed", culpritSha: "abc", usedBisection: false }, execMock);
    assert.equal(commands.length, 0);
  });
});

describe("postRevertLink", () => {
  it("posts a Linear comment with the revert PR URL", () => {
    const commands = [];
    const execMock = (cmd) => { commands.push(cmd); return ""; };

    postRevertLink("DVA-5", "https://github.com/owner/repo/pull/99", execMock);

    assert.equal(commands.length, 1);
    assert.ok(commands[0].includes("linear.mjs"));
    assert.ok(commands[0].includes("comment"));
    assert.ok(commands[0].includes("DVA-5"));
    assert.ok(commands[0].includes("pull/99"));
  });

  it("skips when issueId is null", () => {
    const commands = [];
    const execMock = (cmd) => { commands.push(cmd); return ""; };

    postRevertLink(null, "https://github.com/owner/repo/pull/99", execMock);
    assert.equal(commands.length, 0);
  });
});
```

- [ ] **Step 2: Run tests to verify new tests fail**

Run: `node --test tests/rollback.test.mjs`
Expected: FAIL — functions not found

- [ ] **Step 3: Implement `updateLinear` and `postRevertLink`**

Append to `scripts/rollback.mjs`:

```javascript
/**
 * Moves the Linear issue to "In Progress" and posts a failure comment.
 * Skips if issueId is null.
 */
export function updateLinear(issueId, details, execFn = null) {
  if (!issueId) return;
  const run = execFn || ((cmd) => execSync(cmd, { encoding: "utf-8", cwd: PROJECT_ROOT }).trim());

  run(`node "${LINEAR_SCRIPT}" status ${issueId} "In Progress"`);

  const truncated = (details.failureOutput || "").substring(0, 1500);
  const bisectNote = details.usedBisection ? "Bisection was used to isolate this commit." : "Single merge since last green — no bisection needed.";
  const comment = `Rollback triggered: tests failed on main.\\n\\nCulprit commit: ${details.culpritSha}\\n${bisectNote}\\n\\nFailure output:\\n\`\`\`\\n${truncated}\\n\`\`\``;

  run(`node "${LINEAR_SCRIPT}" comment ${issueId} "${comment.replace(/"/g, '\\"')}"`);
}

/**
 * Posts a follow-up Linear comment with the revert PR link.
 * Skips if issueId is null.
 */
export function postRevertLink(issueId, prUrl, execFn = null) {
  if (!issueId) return;
  const run = execFn || ((cmd) => execSync(cmd, { encoding: "utf-8", cwd: PROJECT_ROOT }).trim());

  run(`node "${LINEAR_SCRIPT}" comment ${issueId} "Revert PR created: ${prUrl}"`);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/rollback.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/rollback.mjs tests/rollback.test.mjs
git commit -m "DVA-17: add updateLinear and postRevertLink"
```

---

### Task 8: `commentOnOriginalPR` — test and implement

**Files:**
- Modify: `tests/rollback.test.mjs`
- Modify: `scripts/rollback.mjs`

- [ ] **Step 1: Write failing tests for `commentOnOriginalPR`**

Update the import block at the top of `tests/rollback.test.mjs`:

```javascript
import {
  extractIssueId,
  runTestsWithRetry,
  bisectCulprit,
  findLastGreenSha,
  getMergeCommitsSince,
  createRevertPR,
  updateLinear,
  postRevertLink,
  commentOnOriginalPR,
} from "../scripts/rollback.mjs";
```

Append this describe block:

```javascript
describe("commentOnOriginalPR", () => {
  it("looks up the PR and posts a comment", () => {
    const commands = [];
    const execMock = (cmd) => {
      commands.push(cmd);
      if (cmd.includes("commits") && cmd.includes("pulls")) {
        return JSON.stringify([{ number: 5 }]);
      }
      return "";
    };

    commentOnOriginalPR("abc1234", {
      failureOutput: "test failed",
      revertPrUrl: "https://github.com/owner/repo/pull/99",
      issueId: "DVA-5",
    }, execMock);

    assert.ok(commands.some((c) => c.includes("commits/abc1234/pulls")));
    assert.ok(commands.some((c) => c.includes("gh pr comment 5")));
  });

  it("skips comment when no PR found for commit", () => {
    const commands = [];
    const execMock = (cmd) => {
      commands.push(cmd);
      if (cmd.includes("commits") && cmd.includes("pulls")) return "[]";
      return "";
    };

    commentOnOriginalPR("abc1234", {
      failureOutput: "test failed",
      revertPrUrl: "https://github.com/owner/repo/pull/99",
      issueId: null,
    }, execMock);

    assert.ok(!commands.some((c) => c.includes("gh pr comment")));
  });
});
```

- [ ] **Step 2: Run tests to verify new tests fail**

Run: `node --test tests/rollback.test.mjs`
Expected: FAIL — `commentOnOriginalPR` not found

- [ ] **Step 3: Implement `commentOnOriginalPR`**

Append to `scripts/rollback.mjs`:

```javascript
/**
 * Finds the PR associated with a commit and posts a failure comment.
 * Skips if no PR is found for the commit.
 */
export function commentOnOriginalPR(commitSha, details, execFn = null) {
  const run = execFn || ((cmd) => execSync(cmd, { encoding: "utf-8", cwd: PROJECT_ROOT }).trim());

  // Look up the PR number from the commit SHA
  let prNumber;
  try {
    const pullsJson = run(`gh api "/repos/{owner}/{repo}/commits/${commitSha}/pulls" --jq "map({number})"`);
    const pulls = JSON.parse(pullsJson);
    if (!pulls.length) {
      console.log(`No PR found for commit ${commitSha} — skipping GitHub comment.`);
      return;
    }
    prNumber = pulls[0].number;
  } catch {
    console.log(`Failed to look up PR for commit ${commitSha} — skipping GitHub comment.`);
    return;
  }

  const truncated = (details.failureOutput || "").substring(0, 1500);
  const issueNote = details.issueId
    ? `Linear issue: [${details.issueId}](https://linear.app/dvaucrosson/issue/${details.issueId})`
    : "";

  const body = [
    "## Automated Rollback Notification",
    "",
    "Tests failed on `main` after this PR was merged.",
    "",
    `Revert PR: ${details.revertPrUrl}`,
    issueNote,
    "",
    "<details><summary>Failure output</summary>",
    "",
    "```",
    truncated,
    "```",
    "</details>",
  ].filter(Boolean).join("\n");

  run(`gh pr comment ${prNumber} --body "${body.replace(/"/g, '\\"')}"`);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/rollback.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/rollback.mjs tests/rollback.test.mjs
git commit -m "DVA-17: add commentOnOriginalPR"
```

---

## Chunk 4: Main Orchestration and Workflow

### Task 9: `orchestrate` — test and implement

**Files:**
- Modify: `tests/rollback.test.mjs`
- Modify: `scripts/rollback.mjs`

- [ ] **Step 1: Write failing tests for `orchestrate`**

Update the import block at the top of `tests/rollback.test.mjs`:

```javascript
import {
  extractIssueId,
  runTestsWithRetry,
  bisectCulprit,
  findLastGreenSha,
  getMergeCommitsSince,
  createRevertPR,
  updateLinear,
  postRevertLink,
  commentOnOriginalPR,
  orchestrate,
} from "../scripts/rollback.mjs";
```

Append this describe block:

```javascript
describe("orchestrate", () => {
  it("exits cleanly when tests pass on first try", () => {
    const calls = { testRuns: 0, linearCalls: 0 };
    const deps = {
      runTests: () => { calls.testRuns++; return { passed: true, flaky: false, outputs: ["all pass"] }; },
      findGreenSha: () => "prev123",
      getMerges: () => [],
      bisect: () => null,
      createPR: () => ({ prUrl: "" }),
      linear: () => { calls.linearCalls++; },
      revertLink: () => {},
      commentPR: () => {},
      restoreHead: () => {},
    };

    const result = orchestrate(deps);
    assert.equal(result.action, "none");
    assert.equal(calls.linearCalls, 0);
  });

  it("exits cleanly with flaky flag when tests are flaky", () => {
    const deps = {
      runTests: () => ({ passed: true, flaky: true, outputs: ["fail", "pass"] }),
      findGreenSha: () => "prev123",
      getMerges: () => [],
      bisect: () => null,
      createPR: () => ({ prUrl: "" }),
      linear: () => {},
      revertLink: () => {},
      commentPR: () => {},
      restoreHead: () => {},
    };

    const result = orchestrate(deps);
    assert.equal(result.action, "flaky");
  });

  it("creates revert PR and notifies on real failure with single merge", () => {
    const calls = { linearCalled: false, prCreated: false, commentPosted: false, revertLinked: false };
    const deps = {
      runTests: () => ({ passed: false, flaky: false, outputs: ["test_math failed"] }),
      findGreenSha: () => "prev123",
      getMerges: () => [{ sha: "bad4567abc1234", message: "Merge PR #5 DVA-5: Add feature" }],
      bisect: (merges) => merges[0],
      createPR: () => { calls.prCreated = true; return { prUrl: "https://github.com/owner/repo/pull/99" }; },
      linear: () => { calls.linearCalled = true; },
      revertLink: () => { calls.revertLinked = true; },
      commentPR: () => { calls.commentPosted = true; },
      restoreHead: () => {},
    };

    const result = orchestrate(deps);
    assert.equal(result.action, "reverted");
    assert.ok(calls.linearCalled);
    assert.ok(calls.prCreated);
    assert.ok(calls.commentPosted);
    assert.ok(calls.revertLinked);
  });

  it("calls bisect with testFn for multiple merges", () => {
    let bisectCalled = false;
    let bisectTestFnReceived = false;
    const deps = {
      runTests: () => ({ passed: false, flaky: false, outputs: ["test failed"] }),
      findGreenSha: () => "prev123",
      getMerges: () => [
        { sha: "aaa1234def56780", message: "Merge #1 DVA-1" },
        { sha: "bbb5678ghi90120", message: "Merge #2 DVA-2" },
      ],
      bisect: (merges, testFn) => {
        bisectCalled = true;
        bisectTestFnReceived = typeof testFn === "function";
        return merges[1]; // pretend second merge is culprit
      },
      createPR: () => ({ prUrl: "https://github.com/owner/repo/pull/50" }),
      linear: () => {},
      revertLink: () => {},
      commentPR: () => {},
      restoreHead: () => {},
    };

    const result = orchestrate(deps);
    assert.equal(result.action, "reverted");
    assert.ok(bisectCalled);
    assert.ok(bisectTestFnReceived);
  });

  it("calls restoreHead after bisection with multiple merges", () => {
    let restored = false;
    const deps = {
      runTests: () => ({ passed: false, flaky: false, outputs: ["fail"] }),
      findGreenSha: () => "prev123",
      getMerges: () => [
        { sha: "aaa1234def56780", message: "Merge #1" },
        { sha: "bbb5678ghi90120", message: "Merge #2" },
      ],
      bisect: (merges) => merges[0],
      createPR: () => ({ prUrl: "https://github.com/owner/repo/pull/60" }),
      linear: () => {},
      revertLink: () => {},
      commentPR: () => {},
      restoreHead: () => { restored = true; },
    };

    orchestrate(deps);
    assert.ok(restored);
  });

  it("skips Linear update when no issue ID in culprit", () => {
    const calls = { linearCalled: false };
    const deps = {
      runTests: () => ({ passed: false, flaky: false, outputs: ["test failed"] }),
      findGreenSha: () => null,
      getMerges: () => [{ sha: "xyz7890abc1234", message: "Update deps" }],
      bisect: (merges) => merges[0],
      createPR: () => ({ prUrl: "https://github.com/owner/repo/pull/100" }),
      linear: (id) => { if (id) calls.linearCalled = true; },
      revertLink: () => {},
      commentPR: () => {},
      restoreHead: () => {},
    };

    const result = orchestrate(deps);
    assert.equal(result.action, "reverted");
    assert.equal(calls.linearCalled, false);
  });

  it("blames most recent merge when no prior green baseline exists", () => {
    let blamedSha = null;
    let bisectCalled = false;
    const deps = {
      runTests: () => ({ passed: false, flaky: false, outputs: ["fail"] }),
      findGreenSha: () => null,
      getMerges: () => [
        { sha: "old1234def56780", message: "Merge old" },
        { sha: "new5678ghi90120", message: "Merge new" },
      ],
      bisect: () => { bisectCalled = true; return null; },
      createPR: (culprit) => { blamedSha = culprit.sha; return { prUrl: "https://github.com/owner/repo/pull/70" }; },
      linear: () => {},
      revertLink: () => {},
      commentPR: () => {},
      restoreHead: () => {},
    };

    orchestrate(deps);
    assert.equal(blamedSha, "new5678ghi90120");
    assert.equal(bisectCalled, false); // no baseline = skip bisect, blame latest
  });
});
```

- [ ] **Step 2: Run tests to verify new tests fail**

Run: `node --test tests/rollback.test.mjs`
Expected: FAIL — `orchestrate` not found

- [ ] **Step 3: Implement `orchestrate` and CLI entry point**

Append to `scripts/rollback.mjs`:

```javascript
/**
 * Main orchestration function. Accepts a `deps` object for testability.
 * In production, `deps` uses the real functions above.
 * Returns { action: "none"|"flaky"|"reverted", details? }.
 */
export function orchestrate(deps) {
  // Step 1: Run tests with retry
  const testResult = deps.runTests();

  if (testResult.passed && !testResult.flaky) {
    console.log("Tests passed on first try. All good.");
    return { action: "none" };
  }

  if (testResult.passed && testResult.flaky) {
    console.log("Tests flaky — passed on retry. No revert needed.");
    return { action: "flaky" };
  }

  // Step 2: Find culprit
  console.log("Tests failed consistently. Identifying culprit...");
  const greenSha = deps.findGreenSha();
  const merges = deps.getMerges(greenSha);

  if (merges.length === 0) {
    console.log("No merge commits found since last green. Cannot identify culprit.");
    return { action: "none" };
  }

  // Step 3: Identify culprit — single merge shortcut, no-baseline shortcut, or bisect
  let culprit;
  let usedBisection = false;

  if (merges.length === 1) {
    // Single merge — it's the culprit
    culprit = merges[0];
  } else if (!greenSha) {
    // No prior green baseline — can't bisect reliably, blame latest
    console.log("No prior green baseline — blaming most recent merge.");
    culprit = merges[merges.length - 1];
  } else {
    usedBisection = true;
    // Build a testFn that checks out each SHA, installs, and runs tests
    const testAtSha = (sha) => {
      try {
        execSync(`git checkout ${sha} && npm install && npm test`, {
          encoding: "utf-8", cwd: PROJECT_ROOT, timeout: 300000,
        });
        return true;
      } catch {
        return false;
      }
    };

    culprit = deps.bisect(merges, testAtSha);

    // Restore HEAD and node_modules after bisection
    deps.restoreHead();
  }

  if (!culprit) {
    console.log("Bisection failed to identify a culprit.");
    return { action: "none" };
  }

  const issueId = extractIssueId(culprit.message);
  const isMergeCommit = culprit.message.startsWith("Merge ");
  const failureOutput = testResult.outputs.join("\n---\n");

  console.log(`Culprit identified: ${culprit.sha.substring(0, 7)} (${issueId || "no issue ID"})`);

  // Step 4: Update Linear FIRST (before pushing revert branch)
  deps.linear(issueId, {
    failureOutput,
    culpritSha: culprit.sha,
    usedBisection: usedBisection && !culprit.skippedBisection,
  });

  // Step 5: Create revert PR
  const { prUrl } = deps.createPR({
    sha: culprit.sha,
    message: culprit.message,
    isMergeCommit,
    issueId,
    failureOutput,
  });

  // Step 6: Post follow-up Linear comment with PR link
  deps.revertLink(issueId, prUrl);

  // Step 7: Comment on original merged PR
  deps.commentPR(culprit.sha, {
    failureOutput,
    revertPrUrl: prUrl,
    issueId,
  });

  console.log(`Revert PR created: ${prUrl}`);
  return { action: "reverted", prUrl, issueId, culpritSha: culprit.sha };
}

// --- CLI entry point ---

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectRun) {
  const result = orchestrate({
    runTests: () => runTestsWithRetry(),
    findGreenSha: () => findLastGreenSha(),
    getMerges: (baseSha) => getMergeCommitsSince(baseSha),
    bisect: (merges, testFn) => bisectCulprit(merges, testFn),
    createPR: (culprit) => createRevertPR(culprit),
    linear: (issueId, details) => updateLinear(issueId, details),
    revertLink: (issueId, prUrl) => postRevertLink(issueId, prUrl),
    commentPR: (sha, details) => commentOnOriginalPR(sha, details),
    restoreHead: () => {
      execSync("git checkout main && npm install", {
        encoding: "utf-8", cwd: PROJECT_ROOT, timeout: 120000,
      });
    },
  });

  if (result.action === "none" || result.action === "flaky") {
    process.exit(0);
  }
  // Revert PR created — exit 1 so the workflow shows as failed
  process.exit(1);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/rollback.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/rollback.mjs tests/rollback.test.mjs
git commit -m "DVA-17: add orchestrate main function with restoreHead"
```

---

### Task 10: GitHub Actions workflow file

**Files:**
- Create: `.github/workflows/rollback.yml`

- [ ] **Step 1: Create the workflow file**

```yaml
# .github/workflows/rollback.yml
name: Rollback Orchestration

on:
  push:
    branches:
      - main

permissions:
  contents: write
  pull-requests: write
  actions: read

concurrency:
  group: rollback-main
  cancel-in-progress: true

jobs:
  rollback-check:
    runs-on: ubuntu-latest
    if: ${{ vars.LINEAR_ENABLED != 'false' }}
    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with:
          fetch-depth: 0
          token: ${{ secrets.GITHUB_TOKEN }}

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Install dependencies
        run: npm ci

      - name: Configure git
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"

      - name: Run rollback orchestration
        run: node scripts/rollback.mjs
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          LINEAR_API_KEY: ${{ secrets.LINEAR_API_KEY }}
```

Note: `GITHUB_REPOSITORY` and `GITHUB_SHA` are automatically available in GitHub Actions — no need to pass them explicitly. The `gh` CLI reads authentication from `GH_TOKEN`.

- [ ] **Step 2: Verify workflow YAML syntax**

Run: `node -e "const fs = require('fs'); const y = fs.readFileSync('.github/workflows/rollback.yml', 'utf-8'); console.log('YAML file created, lines:', y.split('\\n').length)"`
Expected: File exists with expected line count

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/rollback.yml
git commit -m "DVA-17: add rollback GitHub Actions workflow"
```

---

### Task 11: Run full test suite and verify

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: All tests pass, including new rollback tests

- [ ] **Step 2: Verify rollback script loads without syntax errors**

Run: `node --check scripts/rollback.mjs`
Expected: Exit code 0, no output (syntax valid)

- [ ] **Step 3: Final commit if any cleanup needed**

```bash
git add -A
git commit -m "DVA-17: final cleanup for rollback orchestration"
```
