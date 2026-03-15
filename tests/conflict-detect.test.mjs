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
  detectConflicts,
  formatReport,
  parseArgs,
  computeExitCode,
  buildWarningComment,
  hasExistingWarning,
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

describe("detectConflicts", () => {
  it("detects warning-level conflicts (shared files, no line overlap)", () => {
    const deps = {
      runGit: (cmd) => {
        if (cmd.includes("branch -r")) return "  origin/feature/DVA-1-a\n  origin/feature/DVA-2-b\n";
        if (cmd.includes("log -1 --format=%ci")) return new Date().toISOString();
        if (cmd.includes("merge-base")) return "abc123";
        if (cmd.includes("diff --name-only") && cmd.includes("DVA-1")) return "src/shared.mjs\nsrc/only-a.mjs";
        if (cmd.includes("diff --name-only") && cmd.includes("DVA-2")) return "src/shared.mjs\nsrc/only-b.mjs";
        if (cmd.includes("diff --unified=0") && cmd.includes("DVA-1")) return "@@ -1,3 +1,3 @@";
        if (cmd.includes("diff --unified=0") && cmd.includes("DVA-2")) return "@@ -10,3 +10,3 @@";
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
        if (cmd.includes("branch -r")) return "  origin/feature/DVA-1-a\n  origin/feature/DVA-2-b\n";
        if (cmd.includes("log -1 --format=%ci")) return new Date().toISOString();
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
        if (cmd.includes("branch -r")) return "  origin/feature/DVA-1-a\n  origin/feature/DVA-2-b\n";
        if (cmd.includes("log -1 --format=%ci")) return new Date().toISOString();
        if (cmd.includes("merge-base")) return "abc123";
        if (cmd.includes("diff --name-only") && cmd.includes("DVA-1")) return "alpha/a.mjs";
        if (cmd.includes("diff --name-only") && cmd.includes("DVA-2")) return "beta/b.mjs";
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
    assert.deepEqual(detectConflicts("feature/DVA-1-a", deps), []);
  });

  it("skips branches with unreachable merge base", () => {
    const deps = {
      runGit: (cmd) => {
        if (cmd.includes("branch -r")) return "  origin/feature/DVA-1-a\n  origin/feature/DVA-2-b\n";
        if (cmd.includes("log -1 --format=%ci")) return new Date().toISOString();
        if (cmd.includes("merge-base")) throw new Error("no merge base");
        return "";
      },
    };
    assert.deepEqual(detectConflicts("feature/DVA-1-a", deps), []);
  });

  it("includes issueId extracted from branch name", () => {
    const deps = {
      runGit: (cmd) => {
        if (cmd.includes("branch -r")) return "  origin/feature/DVA-1-a\n  origin/feature/DVA-42-thing\n";
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
        if (cmd.includes("branch -r")) return "  origin/feature/DVA-1-a\n  origin/feature/DVA-2-b\n";
        if (cmd.includes("log -1 --format=%ci")) return new Date().toISOString();
        if (cmd.includes("merge-base")) return "abc123";
        if (cmd.includes("diff --name-only") && cmd.includes("DVA-1")) return "scripts/a.mjs";
        if (cmd.includes("diff --name-only") && cmd.includes("DVA-2")) return "scripts/b.mjs";
        return "";
      },
    };
    const result = detectConflicts("feature/DVA-1-a", deps);
    assert.equal(result.length, 1);
    assert.equal(result[0].severity, "info");
    assert.deepEqual(result[0].directories, ["scripts"]);
  });
});

describe("formatReport", () => {
  it("formats a warning conflict", () => {
    const report = formatReport("feature/DVA-1-a", 3, 2, [
      { branch: "origin/feature/DVA-2-b", issueId: "DVA-2", severity: "warning", files: ["scripts/linear.mjs"], lineRanges: {}, hash: "abc123def456" },
    ]);
    assert.ok(report.includes("Conflict Detection Report"));
    assert.ok(report.includes("DVA-2"));
    assert.ok(report.includes("scripts/linear.mjs"));
    assert.ok(report.includes("WARNING"));
    assert.ok(report.includes("1 warning"));
  });

  it("formats a critical conflict with line ranges", () => {
    const report = formatReport("feature/DVA-1-a", 2, 1, [
      { branch: "origin/feature/DVA-3-c", issueId: "DVA-3", severity: "critical", files: ["src/auth.mjs"],
        lineRanges: { "src/auth.mjs": { pushed: [{ newStart: 10, newCount: 5 }], other: [{ newStart: 12, newCount: 8 }] } }, hash: "abc123" },
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

  it("defaults to empty command when no command", () => {
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
    assert.equal(computeExitCode([{ severity: "warning" }, { severity: "critical" }]), 2);
  });

  it("returns 0 for info-only conflicts", () => {
    assert.equal(computeExitCode([{ severity: "info" }]), 0);
  });
});

describe("buildWarningComment", () => {
  it("includes severity, files, branches, and hash", () => {
    const comment = buildWarningComment({
      branch: "origin/feature/DVA-2-bar", issueId: "DVA-2", pushedIssueId: "DVA-1",
      severity: "warning", files: ["scripts/linear.mjs"], lineRanges: {}, hash: "abc123def456",
    }, "feature/DVA-1-foo");
    assert.ok(comment.includes("Conflict Detection"));
    assert.ok(comment.includes("WARNING"));
    assert.ok(comment.includes("scripts/linear.mjs"));
    assert.ok(comment.includes("DVA-1"));
    assert.ok(comment.includes("`conflict-hash: abc123def456`"));
  });

  it("includes line range info for critical conflicts", () => {
    const comment = buildWarningComment({
      branch: "origin/feature/DVA-3-baz", issueId: "DVA-3", severity: "critical",
      files: ["src/auth.mjs"],
      lineRanges: { "src/auth.mjs": { pushed: [{ newStart: 10, newCount: 5 }], other: [{ newStart: 12, newCount: 8 }] } },
      hash: "xyz789",
    }, "feature/DVA-1-foo");
    assert.ok(comment.includes("CRITICAL"));
    assert.ok(comment.includes("src/auth.mjs"));
  });
});

describe("hasExistingWarning", () => {
  it("returns true when hash exists in comments", () => {
    const comments = [{ body: "Some comment" }, { body: "Conflict warning\n`conflict-hash: abc123def456`" }];
    assert.equal(hasExistingWarning(comments, "abc123def456"), true);
  });

  it("returns false when hash not found", () => {
    const comments = [{ body: "Some comment" }, { body: "`conflict-hash: different123`" }];
    assert.equal(hasExistingWarning(comments, "abc123def456"), false);
  });

  it("returns false for empty comments", () => {
    assert.equal(hasExistingWarning([], "abc123def456"), false);
  });
});
