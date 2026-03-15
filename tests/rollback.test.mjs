// tests/rollback.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractIssueId,
  runTestsWithRetry,
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
