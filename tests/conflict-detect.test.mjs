import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseHunkHeaders,
  rangesOverlap,
  classifySeverity,
  conflictHash,
  findOverlaps,
  topLevelDir,
  findDirOverlaps,
  discoverBranches,
  filterStaleBranches,
  getChangedFiles,
} from "../scripts/conflict-detect.mjs";

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

describe("rangesOverlap", () => {
  it("detects overlapping ranges", () => {
    assert.equal(rangesOverlap(
      [{ newStart: 10, newCount: 11 }],
      [{ newStart: 15, newCount: 11 }],
    ), true);
  });

  it("detects non-overlapping ranges", () => {
    assert.equal(rangesOverlap(
      [{ newStart: 10, newCount: 6 }],
      [{ newStart: 20, newCount: 6 }],
    ), false);
  });

  it("detects adjacent ranges as non-overlapping", () => {
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
    assert.equal(rangesOverlap(
      [{ newStart: 10, newCount: 0 }],
      [{ newStart: 10, newCount: 5 }],
    ), false);
  });
});

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
    const fileOverlaps = [];
    const dirs = findDirOverlaps(pushed, other, fileOverlaps);
    assert.deepEqual(dirs, ["scripts"]);
  });

  it("excludes directories already covered by file overlaps", () => {
    const pushed = new Set(["scripts/a.mjs", "scripts/b.mjs"]);
    const other = new Set(["scripts/a.mjs", "scripts/c.mjs"]);
    const fileOverlaps = ["scripts/a.mjs"];
    const dirs = findDirOverlaps(pushed, other, fileOverlaps);
    assert.deepEqual(dirs, []);
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
    const fresh = new Date("2026-03-13T12:00:00Z").toISOString();
    const stale = new Date("2026-03-01T12:00:00Z").toISOString();

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
