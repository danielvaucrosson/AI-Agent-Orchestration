// tests/rollback.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";
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
