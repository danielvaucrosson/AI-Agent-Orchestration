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
