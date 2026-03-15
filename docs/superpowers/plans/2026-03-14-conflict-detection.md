# DVA-16: Conflict Detection Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect file-level overlaps between concurrent agent branches and post severity-classified warnings to Linear.

**Architecture:** A single script (`scripts/conflict-detect.mjs`) with pure-function core logic and injected git/Linear dependencies for testability. A GitHub Action (`conflict-detect.yml`) runs the script on push to `feature/**` and `fix/**` branches.

**Tech Stack:** Node.js 20+, `node:test`, `node:crypto`, `@linear/sdk`, git CLI

---

## File Structure

| File | Responsibility |
|------|---------------|
| `scripts/conflict-detect.mjs` | CLI entrypoint + core logic (branch discovery, diff comparison, severity classification, dedup hash, Linear posting, output formatting) |
| `.github/workflows/conflict-detect.yml` | GitHub Action triggered on push to feature/fix branches |
| `tests/conflict-detect.test.mjs` | Unit tests for all exported pure functions |

No existing files are modified.

---

## Chunk 1: Core Pure Functions

### Task 1: Hunk header parser

**Files:**
- Create: `scripts/conflict-detect.mjs` (initial scaffold with `parseHunkHeaders` export)
- Create: `tests/conflict-detect.test.mjs` (initial scaffold with hunk parser tests)

- [ ] **Step 1: Write failing tests for `parseHunkHeaders`**

In `tests/conflict-detect.test.mjs`:

```javascript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseHunkHeaders } from "../scripts/conflict-detect.mjs";

describe("parseHunkHeaders", () => {
  it("parses standard hunk header with counts", () => {
    const result = parseHunkHeaders("@@ -10,5 +20,3 @@ function foo() {");
    assert.deepEqual(result, [{ oldStart: 10, oldCount: 5, newStart: 20, newCount: 3 }]);
  });

  it("parses single-line hunk (count omitted = 1)", () => {
    const result = parseHunkHeaders("@@ -42 +42 @@ const x = 1;");
    assert.deepEqual(result, [{ oldStart: 42, oldCount: 1, newStart: 42, newCount: 1 }]);
  });

  it("parses mixed: one side has count, other does not", () => {
    const result = parseHunkHeaders("@@ -5,3 +5 @@");
    assert.deepEqual(result, [{ oldStart: 5, oldCount: 3, newStart: 5, newCount: 1 }]);
  });

  it("parses multiple hunks from multiline input", () => {
    const input = "@@ -1,3 +1,4 @@\n some code\n+added\n@@ -20,2 +21,5 @@\n more code";
    const result = parseHunkHeaders(input);
    assert.equal(result.length, 2);
    assert.equal(result[0].oldStart, 1);
    assert.equal(result[1].oldStart, 20);
  });

  it("returns empty array for input with no hunks", () => {
    assert.deepEqual(parseHunkHeaders("no hunks here"), []);
  });

  it("parses hunk with zero count (pure deletion or addition)", () => {
    const result = parseHunkHeaders("@@ -10,0 +10,3 @@");
    assert.deepEqual(result, [{ oldStart: 10, oldCount: 0, newStart: 10, newCount: 3 }]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/conflict-detect.test.mjs`
Expected: FAIL — module `../scripts/conflict-detect.mjs` does not exist

- [ ] **Step 3: Implement `parseHunkHeaders`**

Create `scripts/conflict-detect.mjs` with initial scaffold:

```javascript
/**
 * Conflict detection between concurrent agent branches.
 *
 * Detects file-level overlaps between the current branch and other active
 * feature/fix branches. Posts severity-classified warnings to Linear.
 *
 * Usage:
 *   node scripts/conflict-detect.mjs scan   [--json]
 *   node scripts/conflict-detect.mjs warn   [--dry-run]
 *   node scripts/conflict-detect.mjs --help
 *
 * Commands:
 *   scan    Detect conflicts and print report
 *   warn    Detect conflicts and post warnings to Linear
 *
 * Options:
 *   --json      Output as JSON (scan only)
 *   --dry-run   Preview Linear comments without posting (warn only)
 */

import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// --- Issue ID extraction ---

/** Same regex as .claude/hooks/linear-helpers.mjs (duplicated to avoid cross-layer import) */
const ISSUE_ID_RE = /\b([A-Z]{1,5}-\d+)\b/;

/**
 * Extract a Linear issue ID from text (branch name, etc).
 * @param {string} text
 * @returns {string|null}
 */
export function extractIssueId(text) {
  const match = text.match(ISSUE_ID_RE);
  return match ? match[1] : null;
}

// --- Hunk header parsing ---

const HUNK_RE = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/;

/**
 * Parse git diff hunk headers from unified diff output.
 * Returns an array of { oldStart, oldCount, newStart, newCount }.
 *
 * Git omits the count when it's 1 (e.g., `@@ -42 +42 @@` means one line).
 * A count of 0 indicates a pure addition or deletion at that position.
 *
 * @param {string} diffOutput — raw `git diff --unified=0` output
 * @returns {Array<{oldStart: number, oldCount: number, newStart: number, newCount: number}>}
 */
export function parseHunkHeaders(diffOutput) {
  const hunks = [];
  for (const line of diffOutput.split("\n")) {
    const match = line.match(HUNK_RE);
    if (match) {
      hunks.push({
        oldStart: parseInt(match[1], 10),
        oldCount: match[2] !== undefined ? parseInt(match[2], 10) : 1,
        newStart: parseInt(match[3], 10),
        newCount: match[4] !== undefined ? parseInt(match[4], 10) : 1,
      });
    }
  }
  return hunks;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/conflict-detect.test.mjs`
Expected: All 6 `parseHunkHeaders` tests PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/conflict-detect.mjs tests/conflict-detect.test.mjs
git commit -m "DVA-16: Add hunk header parser with tests"
```

---

### Task 2: Line range overlap detection

**Files:**
- Modify: `scripts/conflict-detect.mjs` (add `rangesOverlap`)
- Modify: `tests/conflict-detect.test.mjs` (add overlap tests)

- [ ] **Step 1: Write failing tests for `rangesOverlap`**

Append to `tests/conflict-detect.test.mjs`:

```javascript
import { rangesOverlap } from "../scripts/conflict-detect.mjs";

describe("rangesOverlap", () => {
  it("detects overlapping ranges", () => {
    // Range A: lines 10-20, Range B: lines 15-25
    assert.equal(rangesOverlap(
      [{ newStart: 10, newCount: 11 }],
      [{ newStart: 15, newCount: 11 }],
    ), true);
  });

  it("detects non-overlapping ranges", () => {
    // Range A: lines 10-15, Range B: lines 20-25
    assert.equal(rangesOverlap(
      [{ newStart: 10, newCount: 6 }],
      [{ newStart: 20, newCount: 6 }],
    ), false);
  });

  it("detects adjacent ranges as non-overlapping", () => {
    // Range A: lines 10-14, Range B: lines 15-19
    assert.equal(rangesOverlap(
      [{ newStart: 10, newCount: 5 }],
      [{ newStart: 15, newCount: 5 }],
    ), false);
  });

  it("detects overlap when one range contains another", () => {
    assert.equal(rangesOverlap(
      [{ newStart: 5, newCount: 20 }],
      [{ newStart: 10, newCount: 3 }],
    ), true);
  });

  it("handles multiple hunks — overlap in any pair", () => {
    assert.equal(rangesOverlap(
      [{ newStart: 1, newCount: 3 }, { newStart: 50, newCount: 5 }],
      [{ newStart: 10, newCount: 3 }, { newStart: 52, newCount: 2 }],
    ), true);
  });

  it("handles multiple hunks — no overlap in any pair", () => {
    assert.equal(rangesOverlap(
      [{ newStart: 1, newCount: 3 }, { newStart: 50, newCount: 5 }],
      [{ newStart: 10, newCount: 3 }, { newStart: 60, newCount: 2 }],
    ), false);
  });

  it("returns false for empty hunk arrays", () => {
    assert.equal(rangesOverlap([], []), false);
    assert.equal(rangesOverlap([{ newStart: 1, newCount: 5 }], []), false);
  });

  it("handles zero-count hunks (pure additions)", () => {
    // Zero-count means no lines changed at that position — no overlap
    assert.equal(rangesOverlap(
      [{ newStart: 10, newCount: 0 }],
      [{ newStart: 10, newCount: 5 }],
    ), false);
  });
});
```

- [ ] **Step 2: Run tests to verify the new tests fail**

Run: `node --test tests/conflict-detect.test.mjs`
Expected: `rangesOverlap` tests FAIL — function not exported

- [ ] **Step 3: Implement `rangesOverlap`**

Add to `scripts/conflict-detect.mjs`:

```javascript
/**
 * Check whether any line ranges from two sets of hunks overlap.
 * Uses the "new" side (newStart/newCount) since both branches diff against main.
 *
 * @param {Array<{newStart: number, newCount: number}>} hunksA
 * @param {Array<{newStart: number, newCount: number}>} hunksB
 * @returns {boolean}
 */
export function rangesOverlap(hunksA, hunksB) {
  for (const a of hunksA) {
    if (a.newCount === 0) continue;
    const aEnd = a.newStart + a.newCount - 1;
    for (const b of hunksB) {
      if (b.newCount === 0) continue;
      const bEnd = b.newStart + b.newCount - 1;
      if (a.newStart <= bEnd && b.newStart <= aEnd) {
        return true;
      }
    }
  }
  return false;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/conflict-detect.test.mjs`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/conflict-detect.mjs tests/conflict-detect.test.mjs
git commit -m "DVA-16: Add line range overlap detection with tests"
```

---

### Task 3: Severity classification and conflict hash

**Files:**
- Modify: `scripts/conflict-detect.mjs` (add `classifySeverity`, `conflictHash`, `findOverlaps`)
- Modify: `tests/conflict-detect.test.mjs` (add classification and hash tests)

- [ ] **Step 1: Write failing tests**

Append to `tests/conflict-detect.test.mjs`:

```javascript
import { classifySeverity, conflictHash, findOverlaps, topLevelDir, findDirOverlaps } from "../scripts/conflict-detect.mjs";

describe("topLevelDir", () => {
  it("returns first path segment", () => {
    assert.equal(topLevelDir("src/auth.mjs"), "src");
  });

  it("returns '.' for root-level files", () => {
    assert.equal(topLevelDir("README.md"), ".");
  });
});

describe("findDirOverlaps", () => {
  it("finds shared directories not already covered by file overlaps", () => {
    const pushed = new Set(["scripts/a.mjs", "src/b.mjs"]);
    const other = new Set(["scripts/c.mjs", "tests/d.mjs"]);
    const fileOverlaps = []; // no file-level overlaps
    const dirs = findDirOverlaps(pushed, other, fileOverlaps);
    assert.deepEqual(dirs, ["scripts"]);
  });

  it("excludes directories already covered by file overlaps", () => {
    const pushed = new Set(["scripts/a.mjs", "scripts/b.mjs"]);
    const other = new Set(["scripts/a.mjs", "scripts/c.mjs"]);
    const fileOverlaps = ["scripts/a.mjs"];
    const dirs = findDirOverlaps(pushed, other, fileOverlaps);
    assert.deepEqual(dirs, []); // scripts/ is already covered
  });

  it("ignores root-level files", () => {
    const pushed = new Set(["README.md"]);
    const other = new Set(["CHANGELOG.md"]);
    const dirs = findDirOverlaps(pushed, other, []);
    assert.deepEqual(dirs, []);
  });
});

describe("classifySeverity", () => {
  it("returns 'warning' for shared files (default)", () => {
    assert.equal(classifySeverity("scripts/linear.mjs", false), "warning");
  });

  it("returns 'critical' when lines overlap", () => {
    assert.equal(classifySeverity("scripts/linear.mjs", true), "critical");
  });
});

describe("conflictHash", () => {
  it("produces consistent 12-char hex hashes", () => {
    const h = conflictHash("feature/DVA-1-a", "feature/DVA-2-b", ["file1.mjs", "file2.mjs"]);
    assert.match(h, /^[a-f0-9]{12}$/);
    const h2 = conflictHash("feature/DVA-1-a", "feature/DVA-2-b", ["file1.mjs", "file2.mjs"]);
    assert.equal(h, h2);
  });

  it("produces different hashes for different file sets", () => {
    const h1 = conflictHash("a", "b", ["file1.mjs"]);
    const h2 = conflictHash("a", "b", ["file2.mjs"]);
    assert.notEqual(h1, h2);
  });

  it("sorts files for order-independence", () => {
    const h1 = conflictHash("a", "b", ["z.mjs", "a.mjs"]);
    const h2 = conflictHash("a", "b", ["a.mjs", "z.mjs"]);
    assert.equal(h1, h2);
  });
});

describe("findOverlaps", () => {
  it("finds file-level overlaps between two file sets", () => {
    const pushed = new Set(["src/a.mjs", "src/b.mjs", "scripts/c.mjs"]);
    const other = new Set(["src/b.mjs", "scripts/d.mjs"]);
    const overlaps = findOverlaps(pushed, other);
    assert.deepEqual(overlaps, ["src/b.mjs"]);
  });

  it("returns empty array when no overlaps", () => {
    const pushed = new Set(["src/a.mjs"]);
    const other = new Set(["src/b.mjs"]);
    assert.deepEqual(findOverlaps(pushed, other), []);
  });

  it("returns sorted overlaps", () => {
    const pushed = new Set(["z.mjs", "a.mjs", "m.mjs"]);
    const other = new Set(["m.mjs", "a.mjs", "z.mjs"]);
    const overlaps = findOverlaps(pushed, other);
    assert.deepEqual(overlaps, ["a.mjs", "m.mjs", "z.mjs"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/conflict-detect.test.mjs`
Expected: FAIL — functions not exported

- [ ] **Step 3: Implement the functions**

Add to `scripts/conflict-detect.mjs`:

```javascript
/**
 * Get the top-level directory of a file path.
 * @param {string} filePath
 * @returns {string}
 */
export function topLevelDir(filePath) {
  const parts = filePath.split("/");
  return parts.length > 1 ? parts[0] : ".";
}

/**
 * Classify conflict severity for a shared file.
 * @param {string} _file — the file path (unused, reserved for future use)
 * @param {boolean} linesOverlap — whether the touched line ranges overlap
 * @returns {"warning"|"critical"}
 */
export function classifySeverity(_file, linesOverlap) {
  return linesOverlap ? "critical" : "warning";
}

/**
 * Find directory-level overlaps (same top-level dir, different files).
 * Returns directories shared by both file sets but not at the file level.
 *
 * @param {Set<string>} pushedFiles
 * @param {Set<string>} otherFiles
 * @param {string[]} fileOverlaps — already-detected file-level overlaps
 * @returns {string[]} sorted list of shared top-level directories
 */
export function findDirOverlaps(pushedFiles, otherFiles, fileOverlaps) {
  const pushedDirs = new Set([...pushedFiles].map(topLevelDir));
  const otherDirs = new Set([...otherFiles].map(topLevelDir));
  const fileOverlapDirs = new Set(fileOverlaps.map(topLevelDir));

  const sharedDirs = [];
  for (const dir of pushedDirs) {
    if (dir === ".") continue; // root-level files don't count as dir overlap
    if (otherDirs.has(dir) && !fileOverlapDirs.has(dir)) {
      sharedDirs.push(dir);
    }
  }
  return sharedDirs.sort();
}

/**
 * Generate a deduplication hash for a conflict warning.
 * Based on both branch names + sorted file list.
 * @param {string} branchA
 * @param {string} branchB
 * @param {string[]} files
 * @returns {string} 12-char hex hash
 */
export function conflictHash(branchA, branchB, files) {
  const sorted = [...files].sort();
  const input = `${branchA}::${branchB}::${sorted.join(",")}`;
  return createHash("sha256").update(input).digest("hex").slice(0, 12);
}

/**
 * Find file-level overlaps between two sets of changed files.
 * @param {Set<string>} pushedFiles
 * @param {Set<string>} otherFiles
 * @returns {string[]} sorted list of overlapping file paths
 */
export function findOverlaps(pushedFiles, otherFiles) {
  const overlaps = [];
  for (const file of pushedFiles) {
    if (otherFiles.has(file)) {
      overlaps.push(file);
    }
  }
  return overlaps.sort();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/conflict-detect.test.mjs`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/conflict-detect.mjs tests/conflict-detect.test.mjs
git commit -m "DVA-16: Add severity classification, conflict hash, and overlap detection"
```

---

### Task 4: Branch discovery and staleness filter

**Files:**
- Modify: `scripts/conflict-detect.mjs` (add `discoverBranches`, `filterStaleBranches`)
- Modify: `tests/conflict-detect.test.mjs`

- [ ] **Step 1: Write failing tests**

These functions call git, so they accept a `deps` object. Append to tests:

```javascript
import { discoverBranches, filterStaleBranches } from "../scripts/conflict-detect.mjs";

describe("discoverBranches", () => {
  it("filters to feature/* and fix/* branches, excluding current", () => {
    const fakeGit = (cmd) => {
      if (cmd.includes("branch -r")) {
        return [
          "  origin/feature/DVA-1-foo",
          "  origin/feature/DVA-2-bar",
          "  origin/fix/DVA-3-baz",
          "  origin/main",
          "  origin/claude/test",
        ].join("\n");
      }
      return "";
    };
    const branches = discoverBranches("feature/DVA-1-foo", { runGit: fakeGit });
    assert.deepEqual(branches, [
      "origin/feature/DVA-2-bar",
      "origin/fix/DVA-3-baz",
    ]);
  });

  it("returns empty array when no other active branches", () => {
    const fakeGit = () => "  origin/feature/DVA-1-foo\n  origin/main\n";
    const branches = discoverBranches("feature/DVA-1-foo", { runGit: fakeGit });
    assert.deepEqual(branches, []);
  });
});

describe("filterStaleBranches", () => {
  it("filters out branches older than maxAgeDays", () => {
    const now = new Date("2026-03-14T12:00:00Z");
    const fresh = new Date("2026-03-13T12:00:00Z").toISOString(); // 1 day old
    const stale = new Date("2026-03-01T12:00:00Z").toISOString(); // 13 days old

    const fakeGit = (cmd) => {
      if (cmd.includes("branch-a")) return fresh;
      if (cmd.includes("branch-b")) return stale;
      return "";
    };

    const result = filterStaleBranches(
      ["branch-a", "branch-b"],
      { runGit: fakeGit, maxAgeDays: 7, now },
    );
    assert.deepEqual(result, ["branch-a"]);
  });

  it("keeps all branches when none are stale", () => {
    const now = new Date("2026-03-14T12:00:00Z");
    const recent = new Date("2026-03-13T00:00:00Z").toISOString();
    const fakeGit = () => recent;

    const result = filterStaleBranches(
      ["branch-a", "branch-b"],
      { runGit: fakeGit, maxAgeDays: 7, now },
    );
    assert.deepEqual(result, ["branch-a", "branch-b"]);
  });

  it("returns empty array when all branches are stale", () => {
    const now = new Date("2026-03-14T12:00:00Z");
    const old = new Date("2026-02-01T00:00:00Z").toISOString();
    const fakeGit = () => old;

    const result = filterStaleBranches(
      ["branch-a"],
      { runGit: fakeGit, maxAgeDays: 7, now },
    );
    assert.deepEqual(result, []);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/conflict-detect.test.mjs`
Expected: FAIL — functions not exported

- [ ] **Step 3: Implement the functions**

Add to `scripts/conflict-detect.mjs`:

```javascript
// --- Default git runner ---

/**
 * Run a git command and return stdout trimmed.
 * @param {string} cmd
 * @returns {string}
 */
function defaultRunGit(cmd) {
  return execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

// --- Branch discovery ---

const ACTIVE_BRANCH_RE = /^\s*origin\/((?:feature|fix)\/.+)$/;

/**
 * Discover active feature/fix branches on the remote, excluding the pushed branch.
 *
 * @param {string} currentBranch — the branch that was just pushed (without origin/ prefix)
 * @param {{ runGit: function }} deps
 * @returns {string[]} remote branch refs (e.g., "origin/feature/DVA-1-foo")
 */
export function discoverBranches(currentBranch, deps = {}) {
  const runGit = deps.runGit || defaultRunGit;
  const output = runGit("git branch -r");
  const branches = [];

  for (const line of output.split("\n")) {
    const match = line.match(ACTIVE_BRANCH_RE);
    if (match && match[1] !== currentBranch) {
      branches.push(`origin/${match[1]}`);
    }
  }
  return branches;
}

/**
 * Filter out branches whose last commit is older than maxAgeDays.
 *
 * @param {string[]} branches — remote branch refs
 * @param {{ runGit: function, maxAgeDays?: number, now?: Date }} deps
 * @returns {string[]}
 */
export function filterStaleBranches(branches, deps = {}) {
  const runGit = deps.runGit || defaultRunGit;
  const maxAgeDays = deps.maxAgeDays ?? 7;
  const now = deps.now || new Date();
  const cutoff = new Date(now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000);

  return branches.filter((branch) => {
    try {
      const dateStr = runGit(`git log -1 --format=%ci ${branch}`);
      const commitDate = new Date(dateStr);
      return commitDate >= cutoff;
    } catch {
      // Branch may have been deleted — skip it
      return false;
    }
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/conflict-detect.test.mjs`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/conflict-detect.mjs tests/conflict-detect.test.mjs
git commit -m "DVA-16: Add branch discovery and staleness filter with tests"
```

---

### Task 5: Changed file computation (getChangedFiles)

**Files:**
- Modify: `scripts/conflict-detect.mjs` (add `getChangedFiles`)
- Modify: `tests/conflict-detect.test.mjs`

- [ ] **Step 1: Write failing tests**

```javascript
import { getChangedFiles } from "../scripts/conflict-detect.mjs";

describe("getChangedFiles", () => {
  it("returns merge base and set of changed files", () => {
    const fakeGit = (cmd) => {
      if (cmd.includes("merge-base")) return "abc123";
      if (cmd.includes("diff --name-only")) return "src/a.mjs\nsrc/b.mjs\n";
      return "";
    };
    const result = getChangedFiles("origin/feature/DVA-1-foo", { runGit: fakeGit });
    assert.equal(result.mergeBase, "abc123");
    assert.deepEqual(result.files, new Set(["src/a.mjs", "src/b.mjs"]));
  });

  it("returns empty file set when no files changed", () => {
    const fakeGit = (cmd) => {
      if (cmd.includes("merge-base")) return "abc123";
      return "";
    };
    const result = getChangedFiles("origin/feature/DVA-1-foo", { runGit: fakeGit });
    assert.equal(result.mergeBase, "abc123");
    assert.deepEqual(result.files, new Set());
  });

  it("returns null when merge-base fails", () => {
    const fakeGit = (cmd) => {
      if (cmd.includes("merge-base")) throw new Error("no merge base");
      return "";
    };
    const result = getChangedFiles("origin/feature/DVA-1-foo", { runGit: fakeGit });
    assert.equal(result, null);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/conflict-detect.test.mjs`
Expected: FAIL — function not exported

- [ ] **Step 3: Implement `getChangedFiles`**

Add to `scripts/conflict-detect.mjs`:

```javascript
/**
 * Get the set of files changed on a branch relative to origin/main.
 * Returns the merge base SHA alongside the file set for reuse in per-file diffs.
 * Returns null if the merge base cannot be determined (branch skipped).
 *
 * @param {string} branch — branch ref (e.g., "origin/feature/DVA-1-foo")
 * @param {{ runGit: function }} deps
 * @returns {{ mergeBase: string, files: Set<string> }|null}
 */
export function getChangedFiles(branch, deps = {}) {
  const runGit = deps.runGit || defaultRunGit;
  let mergeBase;
  try {
    mergeBase = runGit(`git merge-base origin/main ${branch}`);
  } catch {
    return null;
  }
  const output = runGit(`git diff --name-only ${mergeBase}..${branch}`);
  const files = output.split("\n").map((f) => f.trim()).filter(Boolean);
  return { mergeBase, files: new Set(files) };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/conflict-detect.test.mjs`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/conflict-detect.mjs tests/conflict-detect.test.mjs
git commit -m "DVA-16: Add changed file computation with tests"
```

---

## Chunk 2: Conflict Detection Pipeline and Output

### Task 6: Main detection pipeline (`detectConflicts`)

**Files:**
- Modify: `scripts/conflict-detect.mjs` (add `detectConflicts`)
- Modify: `tests/conflict-detect.test.mjs`

- [ ] **Step 1: Write failing tests**

```javascript
import { detectConflicts } from "../scripts/conflict-detect.mjs";

describe("detectConflicts", () => {
  it("detects warning-level conflicts (shared files, no line overlap)", () => {
    const deps = {
      runGit: (cmd) => {
        if (cmd.includes("branch -r")) {
          return "  origin/feature/DVA-1-a\n  origin/feature/DVA-2-b\n";
        }
        if (cmd.includes("log -1 --format=%ci")) {
          return new Date().toISOString();
        }
        if (cmd.includes("merge-base")) return "abc123";
        if (cmd.includes("diff --name-only") && cmd.includes("DVA-1")) {
          return "src/shared.mjs\nsrc/only-a.mjs";
        }
        if (cmd.includes("diff --name-only") && cmd.includes("DVA-2")) {
          return "src/shared.mjs\nsrc/only-b.mjs";
        }
        if (cmd.includes("diff --unified=0") && cmd.includes("DVA-1")) {
          return "@@ -1,3 +1,3 @@";
        }
        if (cmd.includes("diff --unified=0") && cmd.includes("DVA-2")) {
          return "@@ -10,3 +10,3 @@";
        }
        return "";
      },
    };

    const result = detectConflicts("feature/DVA-1-a", deps);
    assert.equal(result.length, 1);
    assert.equal(result[0].branch, "origin/feature/DVA-2-b");
    assert.equal(result[0].severity, "warning");
    assert.deepEqual(result[0].files, ["src/shared.mjs"]);
  });

  it("detects critical-level conflicts (overlapping lines)", () => {
    const deps = {
      runGit: (cmd) => {
        if (cmd.includes("branch -r")) {
          return "  origin/feature/DVA-1-a\n  origin/feature/DVA-2-b\n";
        }
        if (cmd.includes("log -1 --format=%ci")) {
          return new Date().toISOString();
        }
        if (cmd.includes("merge-base")) return "abc123";
        if (cmd.includes("diff --name-only")) return "src/shared.mjs";
        if (cmd.includes("diff --unified=0")) return "@@ -5,10 +5,10 @@";
        return "";
      },
    };

    const result = detectConflicts("feature/DVA-1-a", deps);
    assert.equal(result.length, 1);
    assert.equal(result[0].severity, "critical");
  });

  it("returns empty array when no overlaps", () => {
    const deps = {
      runGit: (cmd) => {
        if (cmd.includes("branch -r")) {
          return "  origin/feature/DVA-1-a\n  origin/feature/DVA-2-b\n";
        }
        if (cmd.includes("log -1 --format=%ci")) {
          return new Date().toISOString();
        }
        if (cmd.includes("merge-base")) return "abc123";
        if (cmd.includes("diff --name-only") && cmd.includes("DVA-1")) {
          return "src/a.mjs";
        }
        if (cmd.includes("diff --name-only") && cmd.includes("DVA-2")) {
          return "src/b.mjs";
        }
        return "";
      },
    };

    const result = detectConflicts("feature/DVA-1-a", deps);
    assert.deepEqual(result, []);
  });

  it("returns empty array when no other active branches", () => {
    const deps = {
      runGit: (cmd) => {
        if (cmd.includes("branch -r")) return "  origin/feature/DVA-1-a\n  origin/main\n";
        return "";
      },
    };
    const result = detectConflicts("feature/DVA-1-a", deps);
    assert.deepEqual(result, []);
  });

  it("skips branches with unreachable merge base", () => {
    const deps = {
      runGit: (cmd) => {
        if (cmd.includes("branch -r")) {
          return "  origin/feature/DVA-1-a\n  origin/feature/DVA-2-b\n";
        }
        if (cmd.includes("log -1 --format=%ci")) return new Date().toISOString();
        if (cmd.includes("merge-base")) throw new Error("no merge base");
        return "";
      },
    };
    const result = detectConflicts("feature/DVA-1-a", deps);
    assert.deepEqual(result, []);
  });

  it("includes issueId extracted from branch name", () => {
    const deps = {
      runGit: (cmd) => {
        if (cmd.includes("branch -r")) {
          return "  origin/feature/DVA-1-a\n  origin/feature/DVA-42-thing\n";
        }
        if (cmd.includes("log -1 --format=%ci")) return new Date().toISOString();
        if (cmd.includes("merge-base")) return "abc";
        if (cmd.includes("diff --name-only")) return "shared.mjs";
        if (cmd.includes("diff --unified=0")) return "@@ -1,3 +1,3 @@";
        return "";
      },
    };
    const result = detectConflicts("feature/DVA-1-a", deps);
    assert.equal(result[0].issueId, "DVA-42");
    assert.equal(result[0].pushedIssueId, "DVA-1");
  });

  it("detects info-level conflicts (same directory, different files)", () => {
    const deps = {
      runGit: (cmd) => {
        if (cmd.includes("branch -r")) {
          return "  origin/feature/DVA-1-a\n  origin/feature/DVA-2-b\n";
        }
        if (cmd.includes("log -1 --format=%ci")) return new Date().toISOString();
        if (cmd.includes("merge-base")) return "abc123";
        if (cmd.includes("diff --name-only") && cmd.includes("DVA-1")) {
          return "scripts/a.mjs";
        }
        if (cmd.includes("diff --name-only") && cmd.includes("DVA-2")) {
          return "scripts/b.mjs";
        }
        return "";
      },
    };

    const result = detectConflicts("feature/DVA-1-a", deps);
    assert.equal(result.length, 1);
    assert.equal(result[0].severity, "info");
    assert.deepEqual(result[0].directories, ["scripts"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/conflict-detect.test.mjs`
Expected: FAIL — `detectConflicts` not exported

- [ ] **Step 3: Implement `detectConflicts`**

Add to `scripts/conflict-detect.mjs`:

```javascript
/**
 * Run the full conflict detection pipeline.
 *
 * @param {string} currentBranch — branch name without origin/ prefix
 * @param {{ runGit?: function, maxAgeDays?: number, now?: Date }} deps
 * @returns {Array<{branch: string, issueId: string|null, pushedIssueId: string|null, severity: "warning"|"critical", files: string[], lineRanges: object, hash: string}>}
 */
export function detectConflicts(currentBranch, deps = {}) {
  const runGit = deps.runGit || defaultRunGit;
  const depsWithGit = { ...deps, runGit };

  // Step 1: Discover and filter branches
  const allBranches = discoverBranches(currentBranch, depsWithGit);
  const branches = filterStaleBranches(allBranches, depsWithGit);

  if (branches.length === 0) return [];

  // Step 2: Get changed files for pushed branch
  const currentRef = `origin/${currentBranch}`;
  const pushedResult = getChangedFiles(currentRef, depsWithGit);
  if (!pushedResult || pushedResult.files.size === 0) return [];

  const pushedIssueId = extractIssueId(currentBranch);
  const conflicts = [];

  // Step 3-4: Compare against each active branch
  for (const branch of branches) {
    const otherResult = getChangedFiles(branch, depsWithGit);
    if (!otherResult) continue; // merge base unreachable — skip

    const overlapping = findOverlaps(pushedResult.files, otherResult.files);

    // Check for directory-level overlaps (info severity)
    const dirOverlaps = findDirOverlaps(pushedResult.files, otherResult.files, overlapping);

    if (overlapping.length === 0 && dirOverlaps.length === 0) continue;

    // If only directory overlaps, emit info-level conflict
    if (overlapping.length === 0) {
      const issueId = extractIssueId(branch);
      conflicts.push({
        branch,
        issueId,
        pushedIssueId,
        severity: "info",
        files: [],
        directories: dirOverlaps,
        lineRanges: {},
        hash: conflictHash(currentRef, branch, dirOverlaps),
      });
      continue;
    }

    // Check line-level overlap for each shared file (reuse merge base)
    let maxSeverity = "warning";
    const lineRanges = {};

    for (const file of overlapping) {
      try {
        const pushedDiff = runGit(`git diff --unified=0 ${pushedResult.mergeBase} ${currentRef} -- ${file}`);
        const otherDiff = runGit(`git diff --unified=0 ${otherResult.mergeBase} ${branch} -- ${file}`);

        const pushedHunks = parseHunkHeaders(pushedDiff);
        const otherHunks = parseHunkHeaders(otherDiff);

        if (rangesOverlap(pushedHunks, otherHunks)) {
          maxSeverity = "critical";
          lineRanges[file] = { pushed: pushedHunks, other: otherHunks };
        }
      } catch {
        // If line-level check fails, keep as warning
      }
    }

    const issueId = extractIssueId(branch);
    conflicts.push({
      branch,
      issueId,
      pushedIssueId,
      severity: maxSeverity,
      files: overlapping,
      lineRanges,
      hash: conflictHash(currentRef, branch, overlapping),
    });
  }

  return conflicts;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/conflict-detect.test.mjs`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/conflict-detect.mjs tests/conflict-detect.test.mjs
git commit -m "DVA-16: Add main conflict detection pipeline with tests"
```

---

### Task 7: Output formatting (human-readable and JSON)

**Files:**
- Modify: `scripts/conflict-detect.mjs` (add `formatReport`, `formatLineRanges`)
- Modify: `tests/conflict-detect.test.mjs`

- [ ] **Step 1: Write failing tests**

```javascript
import { formatReport } from "../scripts/conflict-detect.mjs";

describe("formatReport", () => {
  it("formats a warning conflict", () => {
    const report = formatReport("feature/DVA-1-a", 3, 2, [
      {
        branch: "origin/feature/DVA-2-b",
        issueId: "DVA-2",
        severity: "warning",
        files: ["scripts/linear.mjs"],
        lineRanges: {},
        hash: "abc123def456",
      },
    ]);
    assert.ok(report.includes("Conflict Detection Report"));
    assert.ok(report.includes("DVA-2"));
    assert.ok(report.includes("scripts/linear.mjs"));
    assert.ok(report.includes("WARNING"));
    assert.ok(report.includes("1 warning"));
  });

  it("formats a critical conflict with line ranges", () => {
    const report = formatReport("feature/DVA-1-a", 2, 1, [
      {
        branch: "origin/feature/DVA-3-c",
        issueId: "DVA-3",
        severity: "critical",
        files: ["src/auth.mjs"],
        lineRanges: {
          "src/auth.mjs": {
            pushed: [{ newStart: 10, newCount: 5 }],
            other: [{ newStart: 12, newCount: 8 }],
          },
        },
        hash: "abc123",
      },
    ]);
    assert.ok(report.includes("CRITICAL"));
    assert.ok(report.includes("line overlap"));
    assert.ok(report.includes("1 critical"));
  });

  it("formats empty conflicts", () => {
    const report = formatReport("feature/DVA-1-a", 0, 0, []);
    assert.ok(report.includes("No conflicts"));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/conflict-detect.test.mjs`
Expected: FAIL

- [ ] **Step 3: Implement `formatReport`**

Add to `scripts/conflict-detect.mjs`:

```javascript
// --- Output formatting ---

const SEVERITY_ICONS = {
  info: "\u2139",      // ℹ
  warning: "\u26A0",   // ⚠
  critical: "\uD83D\uDD34", // 🔴
};

/**
 * Format a line range summary for display.
 * @param {Array<{newStart: number, newCount: number}>} hunks
 * @returns {string}
 */
function formatLineRange(hunks) {
  return hunks
    .filter((h) => h.newCount > 0)
    .map((h) => {
      const end = h.newStart + h.newCount - 1;
      return h.newCount === 1 ? `${h.newStart}` : `${h.newStart}-${end}`;
    })
    .join(", ");
}

/**
 * Format the conflict detection report for human-readable output.
 *
 * @param {string} pushedBranch
 * @param {number} totalBranches — total active branches before staleness filter
 * @param {number} filteredBranches — active branches after staleness filter
 * @param {Array} conflicts — output from detectConflicts
 * @returns {string}
 */
export function formatReport(pushedBranch, totalBranches, filteredBranches, conflicts) {
  const lines = [];
  lines.push("Conflict Detection Report");
  lines.push("\u2500".repeat(25));
  lines.push(`Pushed branch: ${pushedBranch}`);
  lines.push(`Active branches: ${totalBranches} (${filteredBranches} after staleness filter)`);
  lines.push("");

  if (conflicts.length === 0) {
    lines.push("No conflicts detected.");
    return lines.join("\n");
  }

  for (const c of conflicts) {
    const icon = SEVERITY_ICONS[c.severity] || "?";
    const label = c.severity.toUpperCase();
    const issueStr = c.issueId ? ` (${c.issueId})` : "";
    lines.push(`${icon} ${label} \u2014 ${c.branch}${issueStr}`);

    if (c.severity === "info" && c.directories) {
      lines.push("  Same directory:");
      for (const dir of c.directories) {
        lines.push(`    ${dir}/`);
      }
    } else if (c.severity === "critical" && Object.keys(c.lineRanges).length > 0) {
      lines.push("  Shared files (line overlap):");
      for (const file of c.files) {
        if (c.lineRanges[file]) {
          const pushedRange = formatLineRange(c.lineRanges[file].pushed);
          const otherRange = formatLineRange(c.lineRanges[file].other);
          lines.push(`    ${file} (lines ${pushedRange} vs ${otherRange})`);
        } else {
          lines.push(`    ${file}`);
        }
      }
    } else {
      lines.push("  Shared files:");
      for (const file of c.files) {
        lines.push(`    ${file}`);
      }
    }
    lines.push("");
  }

  // Summary
  const counts = { info: 0, warning: 0, critical: 0 };
  for (const c of conflicts) counts[c.severity]++;
  const parts = [];
  if (counts.info > 0) parts.push(`${counts.info} info`);
  if (counts.warning > 0) parts.push(`${counts.warning} warning`);
  if (counts.critical > 0) parts.push(`${counts.critical} critical`);
  lines.push(`Summary: ${parts.join(", ")}`);

  return lines.join("\n");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/conflict-detect.test.mjs`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/conflict-detect.mjs tests/conflict-detect.test.mjs
git commit -m "DVA-16: Add human-readable and JSON output formatting"
```

---

### Task 8: CLI entrypoint and exit codes

**Files:**
- Modify: `scripts/conflict-detect.mjs` (add CLI parsing and command handlers)
- Modify: `tests/conflict-detect.test.mjs` (add CLI tests)

- [ ] **Step 1: Write failing tests**

```javascript
import { parseArgs, computeExitCode } from "../scripts/conflict-detect.mjs";

describe("parseArgs", () => {
  it("parses scan command", () => {
    const opts = parseArgs(["node", "script", "scan"]);
    assert.equal(opts.command, "scan");
    assert.equal(opts.json, false);
  });

  it("parses scan --json", () => {
    const opts = parseArgs(["node", "script", "scan", "--json"]);
    assert.equal(opts.command, "scan");
    assert.equal(opts.json, true);
  });

  it("parses warn --dry-run", () => {
    const opts = parseArgs(["node", "script", "warn", "--dry-run"]);
    assert.equal(opts.command, "warn");
    assert.equal(opts.dryRun, true);
  });

  it("defaults to help when no command", () => {
    const opts = parseArgs(["node", "script"]);
    assert.equal(opts.command, "");
  });
});

describe("computeExitCode", () => {
  it("returns 0 for no conflicts", () => {
    assert.equal(computeExitCode([]), 0);
  });

  it("returns 1 for warning-only conflicts", () => {
    assert.equal(computeExitCode([{ severity: "warning" }]), 1);
  });

  it("returns 2 for any critical conflict", () => {
    assert.equal(computeExitCode([
      { severity: "warning" },
      { severity: "critical" },
    ]), 2);
  });

  it("returns 0 for info-only conflicts", () => {
    assert.equal(computeExitCode([{ severity: "info" }]), 0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/conflict-detect.test.mjs`
Expected: FAIL

- [ ] **Step 3: Implement CLI**

Add to `scripts/conflict-detect.mjs`:

```javascript
// --- CLI ---

/**
 * Parse CLI arguments.
 * @param {string[]} argv — process.argv
 * @returns {{ command: string, json: boolean, dryRun: boolean, team: string }}
 */
export function parseArgs(argv) {
  const args = argv.slice(2);
  const options = { command: "", json: false, dryRun: false, team: "DVA" };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "scan" || arg === "warn") {
      options.command = arg;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--team" && args[i + 1]) {
      options.team = args[++i];
    } else if (arg === "--help" || arg === "-h") {
      options.command = "help";
    }
  }

  return options;
}

/**
 * Compute exit code from conflicts.
 * 0 = no conflicts or info-only, 1 = warnings, 2 = critical
 * @param {Array<{severity: string}>} conflicts
 * @returns {number}
 */
export function computeExitCode(conflicts) {
  if (conflicts.some((c) => c.severity === "critical")) return 2;
  if (conflicts.some((c) => c.severity === "warning")) return 1;
  return 0;
}

function getCurrentBranch() {
  return defaultRunGit("git rev-parse --abbrev-ref HEAD");
}

function showHelp() {
  console.log(`Usage: node scripts/conflict-detect.mjs <command> [options]

Commands:
  scan    Detect conflicts and print report
  warn    Detect conflicts and post warnings to Linear

Options:
  --json      Output as JSON (scan only)
  --dry-run   Preview Linear comments without posting (warn only)
  --team <k>  Linear team key (default: DVA)
  --help      Show this help message

Examples:
  node scripts/conflict-detect.mjs scan
  node scripts/conflict-detect.mjs scan --json
  node scripts/conflict-detect.mjs warn --dry-run
  node scripts/conflict-detect.mjs warn

Exit Codes (scan):
  0  No conflicts or info-level only
  1  Warnings exist
  2  Critical conflicts found`);
}

// --- Main ---

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const options = parseArgs(process.argv);

  if (options.command === "help" || !options.command) {
    showHelp();
    process.exit(options.command ? 0 : 1);
  }

  try {
    const currentBranch = getCurrentBranch();
    const allBranches = discoverBranches(currentBranch, {});
    const filteredBranches = filterStaleBranches(allBranches, {});
    const conflicts = detectConflicts(currentBranch, {});

    if (options.command === "scan") {
      if (options.json) {
        console.log(JSON.stringify(conflicts, null, 2));
      } else {
        console.log(formatReport(currentBranch, allBranches.length, filteredBranches.length, conflicts));
      }
      process.exit(computeExitCode(conflicts));
    } else if (options.command === "warn") {
      // Warn command — implemented in Task 9
      if (conflicts.length === 0) {
        console.log("No conflicts to warn about.");
      } else {
        console.log(`Found ${conflicts.length} conflict(s). Linear posting not yet implemented.`);
      }
      process.exit(0);
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    // warn command must always exit 0 per spec
    process.exit(options.command === "warn" ? 0 : 1);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/conflict-detect.test.mjs`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/conflict-detect.mjs tests/conflict-detect.test.mjs
git commit -m "DVA-16: Add CLI entrypoint with exit codes"
```

---

## Chunk 3: Linear Integration and GitHub Action

### Task 9: Linear warning posting with deduplication

**Files:**
- Modify: `scripts/conflict-detect.mjs` (add `postWarnings`, `buildWarningComment`, `hasExistingWarning`)
- Modify: `tests/conflict-detect.test.mjs`

- [ ] **Step 1: Write failing tests**

```javascript
import { buildWarningComment, hasExistingWarning } from "../scripts/conflict-detect.mjs";

describe("buildWarningComment", () => {
  it("includes severity, files, branches, and hash", () => {
    const comment = buildWarningComment({
      branch: "origin/feature/DVA-2-bar",
      issueId: "DVA-2",
      pushedIssueId: "DVA-1",
      severity: "warning",
      files: ["scripts/linear.mjs"],
      lineRanges: {},
      hash: "abc123def456",
    }, "feature/DVA-1-foo");

    assert.ok(comment.includes("Conflict Detection"));
    assert.ok(comment.includes("warning"));
    assert.ok(comment.includes("scripts/linear.mjs"));
    assert.ok(comment.includes("DVA-1"));
    assert.ok(comment.includes("`conflict-hash: abc123def456`"));
  });

  it("includes line range info for critical conflicts", () => {
    const comment = buildWarningComment({
      branch: "origin/feature/DVA-3-baz",
      issueId: "DVA-3",
      severity: "critical",
      files: ["src/auth.mjs"],
      lineRanges: {
        "src/auth.mjs": {
          pushed: [{ newStart: 10, newCount: 5 }],
          other: [{ newStart: 12, newCount: 8 }],
        },
      },
      hash: "xyz789",
    }, "feature/DVA-1-foo");

    assert.ok(comment.includes("critical"));
    assert.ok(comment.includes("src/auth.mjs"));
  });
});

describe("hasExistingWarning", () => {
  it("returns true when hash exists in comments", () => {
    const comments = [
      { body: "Some comment" },
      { body: "Conflict warning\n`conflict-hash: abc123def456`" },
    ];
    assert.equal(hasExistingWarning(comments, "abc123def456"), true);
  });

  it("returns false when hash not found", () => {
    const comments = [
      { body: "Some comment" },
      { body: "`conflict-hash: different123`" },
    ];
    assert.equal(hasExistingWarning(comments, "abc123def456"), false);
  });

  it("returns false for empty comments", () => {
    assert.equal(hasExistingWarning([], "abc123def456"), false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/conflict-detect.test.mjs`
Expected: FAIL

- [ ] **Step 3: Implement Linear warning functions**

Add to `scripts/conflict-detect.mjs`:

```javascript
// --- Linear integration ---

/**
 * Build the Markdown comment body for a conflict warning.
 * @param {object} conflict — a conflict from detectConflicts
 * @param {string} pushedBranch — the branch that was pushed
 * @returns {string}
 */
export function buildWarningComment(conflict, pushedBranch) {
  const severity = conflict.severity.toUpperCase();
  const icon = SEVERITY_ICONS[conflict.severity] || "?";
  const lines = [];

  lines.push(`## ${icon} Conflict Detection — ${severity}`);
  lines.push("");
  lines.push(`Branch \`${pushedBranch}\` has overlapping file changes with \`${conflict.branch.replace("origin/", "")}\`.`);
  lines.push("");
  lines.push("**Shared files:**");

  for (const file of conflict.files) {
    if (conflict.severity === "critical" && conflict.lineRanges[file]) {
      const pushed = formatLineRange(conflict.lineRanges[file].pushed);
      const other = formatLineRange(conflict.lineRanges[file].other);
      lines.push(`- \`${file}\` (line overlap: ${pushed} vs ${other})`);
    } else {
      lines.push(`- \`${file}\``);
    }
  }

  lines.push("");
  lines.push(`**Recommendation:** Consider coordinating with ${conflict.issueId || "the other branch"} to avoid merge conflicts.`);
  lines.push("");
  lines.push("---");
  lines.push(`_Auto-detected by \`scripts/conflict-detect.mjs\`_`);
  lines.push(`\`conflict-hash: ${conflict.hash}\``);

  return lines.join("\n");
}

/**
 * Check if a conflict warning with the given hash already exists in comments.
 * @param {Array<{body: string}>} comments
 * @param {string} hash
 * @returns {boolean}
 */
export function hasExistingWarning(comments, hash) {
  return comments.some((c) => c.body && c.body.includes(`\`conflict-hash: ${hash}\``));
}

/**
 * Post conflict warnings to Linear issues.
 * Checks each issue independently for existing warnings (deduplication).
 *
 * @param {Array} conflicts — output from detectConflicts
 * @param {string} pushedBranch — current branch name
 * @param {{ dryRun?: boolean }} options
 */
async function postWarnings(conflicts, pushedBranch, options = {}) {
  const { LinearClient } = await import("@linear/sdk");
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) {
    console.error("LINEAR_API_KEY not set — skipping Linear posting.");
    return;
  }
  const client = new LinearClient({ apiKey });

  for (const conflict of conflicts) {
    const comment = buildWarningComment(conflict, pushedBranch);
    const issuesToNotify = [conflict.pushedIssueId, conflict.issueId].filter(Boolean);

    for (const issueIdentifier of issuesToNotify) {
      try {
        const issue = await client.issue(issueIdentifier);
        const commentsResult = await issue.comments();
        const existingComments = commentsResult.nodes || [];

        if (hasExistingWarning(existingComments, conflict.hash)) {
          console.log(`  ${issueIdentifier}: Skipped (warning already exists)`);
          continue;
        }

        if (options.dryRun) {
          console.log(`  [DRY RUN] Would post to ${issueIdentifier}:`);
          console.log(`    Severity: ${conflict.severity}`);
          console.log(`    Files: ${conflict.files.join(", ")}`);
        } else {
          await client.createComment({ issueId: issue.id, body: comment });
          console.log(`  ${issueIdentifier}: Warning posted (${conflict.severity})`);
        }
      } catch (err) {
        console.error(`  ${issueIdentifier}: Failed — ${err.message}`);
      }
    }
  }
}
```

Then update the `warn` command in the `isMain` block to call `postWarnings`:

Replace the placeholder warn handler:
```javascript
    } else if (options.command === "warn") {
      if (conflicts.length === 0) {
        console.log("No conflicts to warn about.");
      } else {
        console.log(`Posting warnings for ${conflicts.length} conflict(s)...`);
        await postWarnings(conflicts, currentBranch, { dryRun: options.dryRun });
        console.log("Done.");
      }
      process.exit(0);
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/conflict-detect.test.mjs`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/conflict-detect.mjs tests/conflict-detect.test.mjs
git commit -m "DVA-16: Add Linear warning posting with deduplication"
```

---

### Task 10: GitHub Action workflow

**Files:**
- Create: `.github/workflows/conflict-detect.yml`

- [ ] **Step 1: Create the workflow file**

```yaml
name: Conflict Detection

on:
  push:
    branches:
      - 'feature/**'
      - 'fix/**'

jobs:
  detect-conflicts:
    runs-on: ubuntu-latest

    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Fetch all remote branches
        run: git fetch --all

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Install dependencies
        run: npm ci

      - name: Scan for conflicts
        id: scan
        continue-on-error: true
        run: node scripts/conflict-detect.mjs scan > /tmp/scan-report.txt
        env:
          NODE_ENV: production

      - name: Post warnings to Linear
        if: ${{ vars.LINEAR_ENABLED != 'false' }}
        run: node scripts/conflict-detect.mjs warn
        env:
          LINEAR_API_KEY: ${{ secrets.LINEAR_API_KEY }}

      - name: Write summary
        if: always()
        run: |
          echo "## Conflict Detection Results" >> $GITHUB_STEP_SUMMARY
          echo "" >> $GITHUB_STEP_SUMMARY
          if [ -f /tmp/scan-report.txt ]; then
            cat /tmp/scan-report.txt >> $GITHUB_STEP_SUMMARY
          else
            echo "No conflicts detected." >> $GITHUB_STEP_SUMMARY
          fi
```

- [ ] **Step 2: Verify the workflow file is valid YAML**

Run: `node -e "const fs = require('fs'); const yaml = fs.readFileSync('.github/workflows/conflict-detect.yml', 'utf8'); console.log('Valid YAML, length:', yaml.length)"`
Expected: Prints file length without errors

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/conflict-detect.yml
git commit -m "DVA-16: Add GitHub Action for conflict detection"
```

---

### Task 11: Run full test suite and verify

**Files:** None (verification only)

- [ ] **Step 1: Run all conflict-detect tests**

Run: `node --test tests/conflict-detect.test.mjs`
Expected: All tests PASS

- [ ] **Step 2: Run full project test suite**

Run: `npm test`
Expected: All tests PASS (including existing tests)

- [ ] **Step 3: Verify CLI help output**

Run: `node scripts/conflict-detect.mjs --help`
Expected: Help text displayed with commands, options, and exit codes

- [ ] **Step 4: Verify scan runs without errors on current branch**

Run: `node scripts/conflict-detect.mjs scan`
Expected: Report output (may show conflicts or "No conflicts" depending on branch state)

- [ ] **Step 5: Final commit if any fixes were needed**

Only if steps 1-4 required changes:
```bash
git add -A
git commit -m "DVA-16: Fix issues found during verification"
```
