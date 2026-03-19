import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  extractIssueId,
  parseTestPlan,
  listAgentPRs,
  countReviewRounds,
  runPreMergeValidation,
  buildReviewComment,
  verifyPostMergeItem,
  runPostMergeVerification,
  reviewPR,
  reviewAll,
} from "../scripts/pr-reviewer.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..");

function run(args) {
  return execSync(`node "${join(PROJECT_ROOT, "scripts", "pr-reviewer.mjs")}" ${args}`, {
    encoding: "utf-8",
    cwd: PROJECT_ROOT,
    timeout: 15000,
  });
}

// --- Sample PR body ---
function samplePRBody(overrides = {}) {
  const body = overrides.body || `## Summary
- Added user authentication endpoint
- Integrated with existing middleware

## Test plan
- [x] All tests pass
- [x] Pre-PR review passes
- [ ] Manual smoke test of login flow

## Post-merge verification
- [ ] Verify dashboard updates on next scheduler run
- [ ] Confirm no excessive workflow runs after 1 hour`;

  return body;
}

// --- Tests ---

describe("extractIssueId", () => {
  it("extracts issue ID from PR title", () => {
    assert.equal(extractIssueId("DVA-42: Add user authentication"), "DVA-42");
  });

  it("extracts issue ID from branch name", () => {
    assert.equal(extractIssueId("feature/DVA-18-add-dashboard"), "DVA-18");
  });

  it("returns null for no match", () => {
    assert.equal(extractIssueId("Update README"), null);
  });

  it("returns null for empty input", () => {
    assert.equal(extractIssueId(""), null);
    assert.equal(extractIssueId(null), null);
  });
});

describe("parseTestPlan", () => {
  it("parses pre-merge and post-merge items", () => {
    const body = samplePRBody();
    const result = parseTestPlan(body);

    assert.equal(result.preMerge.length, 3);
    assert.equal(result.postMerge.length, 2);
  });

  it("identifies checked vs unchecked items", () => {
    const body = samplePRBody();
    const result = parseTestPlan(body);

    assert.equal(result.preMerge[0].checked, true);
    assert.equal(result.preMerge[0].text, "All tests pass");
    assert.equal(result.preMerge[1].checked, true);
    assert.equal(result.preMerge[2].checked, false);
    assert.equal(result.preMerge[2].text, "Manual smoke test of login flow");
  });

  it("parses post-merge items correctly", () => {
    const body = samplePRBody();
    const result = parseTestPlan(body);

    assert.equal(result.postMerge[0].checked, false);
    assert.ok(result.postMerge[0].text.includes("dashboard"));
    assert.equal(result.postMerge[1].checked, false);
    assert.ok(result.postMerge[1].text.includes("workflow"));
  });

  it("handles empty body", () => {
    const result = parseTestPlan("");
    assert.equal(result.preMerge.length, 0);
    assert.equal(result.postMerge.length, 0);
  });

  it("handles null body", () => {
    const result = parseTestPlan(null);
    assert.equal(result.preMerge.length, 0);
    assert.equal(result.postMerge.length, 0);
  });

  it("handles body with no test plan section", () => {
    const body = "## Summary\nJust a simple fix.";
    const result = parseTestPlan(body);
    assert.equal(result.preMerge.length, 0);
    assert.equal(result.postMerge.length, 0);
  });

  it("handles body with only pre-merge items", () => {
    const body = `## Test plan
- [x] Tests pass
- [x] Lint clean`;
    const result = parseTestPlan(body);
    assert.equal(result.preMerge.length, 2);
    assert.equal(result.postMerge.length, 0);
  });

  it("handles body with only post-merge items", () => {
    const body = `## Post-merge verification
- [ ] Check metrics after deploy`;
    const result = parseTestPlan(body);
    assert.equal(result.preMerge.length, 0);
    assert.equal(result.postMerge.length, 1);
  });

  it("handles uppercase X in checkboxes", () => {
    const body = `## Test plan
- [X] This was checked with uppercase X`;
    const result = parseTestPlan(body);
    assert.equal(result.preMerge.length, 1);
    assert.equal(result.preMerge[0].checked, true);
  });

  it("stops parsing when a new unrelated section starts", () => {
    const body = `## Test plan
- [x] Tests pass

## Implementation notes
Some notes here.
- Not a checkbox item`;
    const result = parseTestPlan(body);
    assert.equal(result.preMerge.length, 1);
  });
});

describe("listAgentPRs", () => {
  it("filters for agent branch PRs", () => {
    const mockExec = () => JSON.stringify([
      { number: 10, title: "DVA-42: Add auth", headRefName: "feature/DVA-42-add-auth", url: "https://github.com/user/repo/pull/10" },
      { number: 11, title: "Update docs", headRefName: "docs/update-readme", url: "https://github.com/user/repo/pull/11" },
      { number: 12, title: "DVA-18: Fix bug", headRefName: "fix/DVA-18-fix-scheduler", url: "https://github.com/user/repo/pull/12" },
    ]);

    const prs = listAgentPRs(mockExec);
    assert.equal(prs.length, 2);
    assert.equal(prs[0].number, 10);
    assert.equal(prs[0].issueId, "DVA-42");
    assert.equal(prs[1].number, 12);
    assert.equal(prs[1].issueId, "DVA-18");
  });

  it("returns empty array when no agent PRs exist", () => {
    const mockExec = () => JSON.stringify([
      { number: 1, title: "Human PR", headRefName: "main-update", url: "https://github.com/user/repo/pull/1" },
    ]);

    const prs = listAgentPRs(mockExec);
    assert.equal(prs.length, 0);
  });

  it("handles empty PR list", () => {
    const mockExec = () => "[]";
    const prs = listAgentPRs(mockExec);
    assert.equal(prs.length, 0);
  });
});

describe("countReviewRounds", () => {
  it("counts comments with reviewer signature", () => {
    const mockExec = () => JSON.stringify([
      { body: "## PR Reviewer Agent\nAll checks passed." },
      { body: "## PR Reviewer Agent\nRequesting changes." },
    ]);

    const count = countReviewRounds(42, mockExec);
    assert.equal(count, 2);
  });

  it("returns 0 when no reviewer comments exist", () => {
    const mockExec = () => "[]";
    const count = countReviewRounds(42, mockExec);
    assert.equal(count, 0);
  });
});

describe("runPreMergeValidation", () => {
  it("passes when gates pass and all items checked", () => {
    const deps = {
      exec: (cmd) => {
        if (cmd.includes("pr view")) {
          return JSON.stringify({
            title: "DVA-42: Add auth",
            headRefName: "feature/DVA-42-add-auth",
            body: `## Test plan\n- [x] All tests pass\n- [x] Pre-PR review passes`,
          });
        }
        return "{}";
      },
      runGates: () => JSON.stringify({
        overall: "pass",
        gates: [
          { name: "Tests", status: "pass", details: ["All passed"] },
        ],
      }),
    };

    const result = runPreMergeValidation(42, deps);
    assert.equal(result.passed, true);
    assert.equal(result.uncheckedItems.length, 0);
  });

  it("fails when gates fail", () => {
    const deps = {
      exec: (cmd) => {
        if (cmd.includes("pr view")) {
          return JSON.stringify({
            title: "DVA-42: Add auth",
            headRefName: "feature/DVA-42-add-auth",
            body: `## Test plan\n- [x] All tests pass`,
          });
        }
        return "{}";
      },
      runGates: () => JSON.stringify({
        overall: "fail",
        gates: [
          { name: "Tests", status: "fail", details: ["2 tests failed"] },
        ],
      }),
    };

    const result = runPreMergeValidation(42, deps);
    assert.equal(result.passed, false);
  });

  it("fails when pre-merge items are unchecked", () => {
    const deps = {
      exec: (cmd) => {
        if (cmd.includes("pr view")) {
          return JSON.stringify({
            title: "DVA-42: Add auth",
            headRefName: "feature/DVA-42-add-auth",
            body: `## Test plan\n- [x] All tests pass\n- [ ] Manual review needed`,
          });
        }
        return "{}";
      },
      runGates: () => JSON.stringify({
        overall: "pass",
        gates: [{ name: "Tests", status: "pass", details: ["All passed"] }],
      }),
    };

    const result = runPreMergeValidation(42, deps);
    assert.equal(result.passed, false);
    assert.equal(result.uncheckedItems.length, 1);
    assert.ok(result.uncheckedItems[0].text.includes("Manual review"));
  });

  it("passes when no test plan section exists", () => {
    const deps = {
      exec: (cmd) => {
        if (cmd.includes("pr view")) {
          return JSON.stringify({
            title: "DVA-42: Quick fix",
            headRefName: "fix/DVA-42-quick-fix",
            body: "## Summary\nJust a quick fix.",
          });
        }
        return "{}";
      },
      runGates: () => JSON.stringify({
        overall: "pass",
        gates: [{ name: "Tests", status: "pass", details: ["All passed"] }],
      }),
    };

    const result = runPreMergeValidation(42, deps);
    assert.equal(result.passed, true);
  });
});

describe("buildReviewComment", () => {
  it("builds approve comment", () => {
    const validation = {
      gateResults: {
        overall: "pass",
        gates: [{ name: "Tests", status: "pass", details: ["All passed"] }],
      },
      uncheckedItems: [],
    };

    const comment = buildReviewComment(validation, "approve");
    assert.ok(comment.includes("PR Reviewer Agent"));
    assert.ok(comment.includes("All pre-merge checks passed"));
    assert.ok(comment.includes("Tests"));
    assert.ok(comment.includes("pass"));
  });

  it("builds request-changes comment with failures", () => {
    const validation = {
      gateResults: {
        overall: "fail",
        gates: [
          { name: "Tests", status: "fail", details: ["2 tests failed"] },
          { name: "Security", status: "pass", details: ["Clean"] },
        ],
      },
      uncheckedItems: [{ text: "Manual smoke test" }],
    };

    const comment = buildReviewComment(validation, "request-changes");
    assert.ok(comment.includes("Pre-merge checks did not pass"));
    assert.ok(comment.includes("Unchecked Pre-merge Items"));
    assert.ok(comment.includes("Manual smoke test"));
    assert.ok(comment.includes("Failed Gate Details"));
    assert.ok(comment.includes("2 tests failed"));
  });

  it("builds escalation comment", () => {
    const validation = {
      gateResults: null,
      uncheckedItems: [],
    };

    const comment = buildReviewComment(validation, "escalate");
    assert.ok(comment.includes("Escalating to human review"));
  });
});

describe("verifyPostMergeItem", () => {
  it("verifies test-related items by running tests", () => {
    const deps = {
      runTests: () => "All tests passed",
    };

    const result = verifyPostMergeItem("All tests pass", deps);
    assert.equal(result.verified, true);
    assert.ok(result.details.includes("Tests passed"));
  });

  it("fails test-related items when tests fail", () => {
    const deps = {
      runTests: () => { throw new Error("test failure"); },
    };

    const result = verifyPostMergeItem("Ensure all tests pass", deps);
    assert.equal(result.verified, false);
    assert.ok(result.details.includes("Tests failed"));
  });

  it("verifies dashboard items via workflow run check", () => {
    const deps = {
      checkWorkflowRuns: () => JSON.stringify({ conclusion: "success", createdAt: "2026-03-19T00:00:00Z" }),
    };
    const result = verifyPostMergeItem("Verify dashboard updates on next scheduler run", deps);
    assert.equal(result.verified, true);
    assert.ok(result.details.includes("deployed successfully"));
  });

  it("fails dashboard items when latest run failed", () => {
    const deps = {
      checkWorkflowRuns: () => JSON.stringify({ conclusion: "failure", createdAt: "2026-03-19T00:00:00Z" }),
    };
    const result = verifyPostMergeItem("Verify dashboard updates", deps);
    assert.equal(result.verified, false);
    assert.ok(result.details.includes("failure"));
  });

  it("verifies workflow items via scheduler run check", () => {
    const deps = {
      checkWorkflowRuns: () => JSON.stringify({ conclusion: "success", createdAt: "2026-03-19T00:00:00Z" }),
    };
    const result = verifyPostMergeItem("Confirm no excessive workflow runs after 1 hour", deps);
    assert.equal(result.verified, true);
    assert.ok(result.details.includes("Scheduler ran successfully"));
  });

  it("skips unknown items that cannot be auto-verified (does not fail)", () => {
    const deps = {};
    const result = verifyPostMergeItem("Check something unusual", deps);
    assert.equal(result.verified, true);
    assert.equal(result.skipped, true);
    assert.ok(result.details.includes("Cannot auto-verify"));
  });
});

describe("runPostMergeVerification", () => {
  it("passes when all items verify", () => {
    const deps = {
      exec: (cmd) => {
        if (cmd.includes("pr view")) {
          return JSON.stringify({
            title: "DVA-42: Add auth",
            body: `## Post-merge verification\n- [ ] Verify dashboard updates`,
            mergeCommit: { oid: "abc123" },
          });
        }
        return "{}";
      },
      checkWorkflowRuns: () => JSON.stringify({ conclusion: "success", createdAt: "2026-03-19T00:00:00Z" }),
    };

    const result = runPostMergeVerification(42, deps);
    assert.equal(result.passed, true);
    assert.equal(result.results.length, 1);
  });

  it("passes with no post-merge items", () => {
    const deps = {
      exec: (cmd) => {
        if (cmd.includes("pr view")) {
          return JSON.stringify({
            title: "DVA-42: Add auth",
            body: `## Test plan\n- [x] Tests pass`,
            mergeCommit: { oid: "abc123" },
          });
        }
        return "{}";
      },
    };

    const result = runPostMergeVerification(42, deps);
    assert.equal(result.passed, true);
    assert.equal(result.results.length, 0);
    assert.ok(result.message.includes("No post-merge items"));
  });

  it("fails when test verification fails", () => {
    const deps = {
      exec: (cmd) => {
        if (cmd.includes("pr view")) {
          return JSON.stringify({
            title: "DVA-42: Add auth",
            body: `## Post-merge verification\n- [ ] All tests pass on main`,
            mergeCommit: { oid: "abc123" },
          });
        }
        return "{}";
      },
      runTests: () => { throw new Error("test failure"); },
    };

    const result = runPostMergeVerification(42, deps);
    assert.equal(result.passed, false);
    assert.equal(result.results[0].verified, false);
  });
});

describe("reviewPR", () => {
  it("merges PR when all checks pass", () => {
    const actions = [];
    const deps = {
      exec: (cmd) => {
        actions.push(cmd);
        if (cmd.includes("pr view")) {
          return JSON.stringify({
            title: "DVA-42: Add auth",
            headRefName: "feature/DVA-42-add-auth",
            body: `## Test plan\n- [x] All tests pass\n- [x] Pre-PR review passes`,
            url: "https://github.com/user/repo/pull/42",
          });
        }
        if (cmd.includes("issues/42/comments")) {
          return "[]";
        }
        return "{}";
      },
      runGates: () => JSON.stringify({
        overall: "pass",
        gates: [{ name: "Tests", status: "pass", details: ["All passed"] }],
      }),
      countRounds: () => 0,
    };

    const result = reviewPR(42, deps);
    assert.equal(result.action, "merged");
    assert.equal(result.issueId, "DVA-42");
    assert.ok(actions.some((a) => a.includes("pr review 42 --approve")));
    assert.ok(actions.some((a) => a.includes("pr merge 42 --squash")));
  });

  it("requests changes when checks fail", () => {
    const actions = [];
    const deps = {
      exec: (cmd) => {
        actions.push(cmd);
        if (cmd.includes("pr view")) {
          return JSON.stringify({
            title: "DVA-42: Add auth",
            headRefName: "feature/DVA-42-add-auth",
            body: `## Test plan\n- [ ] All tests pass`,
            url: "https://github.com/user/repo/pull/42",
          });
        }
        if (cmd.includes("issues/42/comments")) {
          return "[]";
        }
        return "{}";
      },
      runGates: () => JSON.stringify({
        overall: "fail",
        gates: [{ name: "Tests", status: "fail", details: ["2 tests failed"] }],
      }),
      countRounds: () => 0,
    };

    const result = reviewPR(42, deps);
    assert.equal(result.action, "changes-requested");
    assert.ok(actions.some((a) => a.includes("pr comment 42")));
    assert.ok(actions.some((a) => a.includes("agent-actionable")));
  });

  it("escalates after max review rounds", () => {
    const actions = [];
    const deps = {
      exec: (cmd) => {
        actions.push(cmd);
        if (cmd.includes("pr view")) {
          return JSON.stringify({
            title: "DVA-42: Add auth",
            headRefName: "feature/DVA-42-add-auth",
            body: `## Test plan\n- [ ] All tests pass`,
            url: "https://github.com/user/repo/pull/42",
          });
        }
        return "{}";
      },
      countRounds: () => 2, // Already at max
    };

    const result = reviewPR(42, deps);
    assert.equal(result.action, "escalated");
    assert.ok(actions.some((a) => a.includes("needs-human-review")));
    assert.ok(actions.some((a) => a.includes("danielvaucrosson")));
  });
});

describe("reviewAll", () => {
  it("reviews all open agent PRs", () => {
    const reviewed = [];
    const deps = {
      listPRs: () => [
        { number: 10, issueId: "DVA-42", title: "DVA-42: Add auth", branch: "feature/DVA-42-add-auth" },
        { number: 12, issueId: "DVA-18", title: "DVA-18: Fix bug", branch: "fix/DVA-18-fix-bug" },
      ],
      exec: (cmd) => {
        if (cmd.includes("pr view")) {
          const prNum = cmd.match(/pr view (\d+)/)?.[1] || "0";
          reviewed.push(prNum);
          return JSON.stringify({
            title: `DVA-XX: Test`,
            headRefName: "feature/DVA-XX-test",
            body: `## Test plan\n- [x] Tests pass`,
            url: `https://github.com/user/repo/pull/${prNum}`,
          });
        }
        if (cmd.includes("issues/")) return "[]";
        return "{}";
      },
      runGates: () => JSON.stringify({
        overall: "pass",
        gates: [{ name: "Tests", status: "pass", details: ["All passed"] }],
      }),
      countRounds: () => 0,
    };

    const results = reviewAll(deps);
    assert.equal(results.length, 2);
  });

  it("returns empty array when no agent PRs exist", () => {
    const deps = {
      listPRs: () => [],
      exec: () => "{}",
    };

    const results = reviewAll(deps);
    assert.equal(results.length, 0);
  });

  it("handles errors in individual PR reviews", () => {
    let callCount = 0;
    const deps = {
      listPRs: () => [
        { number: 10, issueId: "DVA-42" },
        { number: 12, issueId: "DVA-18" },
      ],
      exec: (cmd) => {
        callCount++;
        if (cmd.includes("pr view 10")) {
          throw new Error("API error");
        }
        if (cmd.includes("pr view")) {
          return JSON.stringify({
            title: "DVA-18: Fix bug",
            headRefName: "fix/DVA-18-fix-bug",
            body: `## Test plan\n- [x] Tests pass`,
            url: "https://github.com/user/repo/pull/12",
          });
        }
        if (cmd.includes("issues/")) return "[]";
        return "{}";
      },
      runGates: () => JSON.stringify({
        overall: "pass",
        gates: [{ name: "Tests", status: "pass", details: ["All passed"] }],
      }),
      countRounds: () => 0,
    };

    const results = reviewAll(deps);
    assert.equal(results.length, 2);
    assert.equal(results[0].action, "error");
    assert.equal(results[0].prNumber, 10);
  });
});

describe("CLI", () => {
  it("shows help with --help", () => {
    const out = run("--help");
    assert.ok(out.includes("Usage:"));
    assert.ok(out.includes("review"));
    assert.ok(out.includes("review-all"));
    assert.ok(out.includes("post-merge"));
  });

  it("shows help with no arguments", () => {
    const out = run("");
    assert.ok(out.includes("Usage:"));
  });

  it("errors when review is called without --pr", () => {
    assert.throws(() => run("review"), /Error/);
  });

  it("errors on unknown command", () => {
    assert.throws(() => run("unknown-command"), /Unknown command/);
  });
});
