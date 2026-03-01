/**
 * Tests for scripts/auto-triage.mjs
 *
 * Covers all exported pure functions:
 *   - estimateSize()
 *   - checkClarity()
 *   - suggestPriority()
 *   - analyzeIssue()
 *   - isAlreadyTriaged()
 *   - buildTriageComment()
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  estimateSize,
  checkClarity,
  suggestPriority,
  analyzeIssue,
  isAlreadyTriaged,
  buildTriageComment,
  SIZE_THRESHOLDS,
  SIZE_LABELS,
  NEEDS_CLARIFICATION_LABEL,
} from "../scripts/auto-triage.mjs";

// ─── estimateSize ────────────────────────────────────────────────

describe("estimateSize", () => {
  it("returns small for a trivial issue", () => {
    const result = estimateSize("Fix typo in README", "Change 'teh' to 'the'");
    assert.equal(result.size, "small");
    assert.ok(result.estimatedLOC < SIZE_THRESHOLDS.small);
    assert.ok(result.signals.includes("typo fix (simple)"));
  });

  it("returns medium for a moderate issue", () => {
    const result = estimateSize(
      "Add user settings page",
      `## Summary
Add a settings page where users can update their preferences.

## Requirements
- Create settings form component
- Connect to existing settings API
- Add input validation

## Acceptance Criteria
- [ ] Settings page loads correctly
- [ ] Changes persist after save`,
    );
    assert.equal(result.size, "medium");
    assert.ok(result.estimatedLOC >= SIZE_THRESHOLDS.small);
    assert.ok(result.estimatedLOC <= SIZE_THRESHOLDS.medium);
  });

  it("returns large for a complex issue", () => {
    const result = estimateSize(
      "Rewrite authentication system with database migration",
      `## Summary
Rewrite the entire authentication flow to use JWT tokens instead of sessions.
This requires a database migration and changes across all API endpoints.

## Requirements
- Migrate database schema to support JWT
- Rewrite authentication middleware
- Update every API endpoint to use new auth
- Add integration tests for the new auth flow
- Create database migration script
- Update deployment infrastructure
- Add real-time session invalidation via WebSocket

## Acceptance Criteria
- [ ] JWT tokens issued on login
- [ ] All endpoints accept JWT
- [ ] Database migration runs cleanly
- [ ] Integration tests pass
- [ ] WebSocket invalidation works
- [ ] Backward compatibility for 30 days`,
    );
    assert.equal(result.size, "large");
    assert.ok(result.estimatedLOC > SIZE_THRESHOLDS.medium);
  });

  it("detects complexity signals in text", () => {
    const result = estimateSize(
      "Migrate database to new schema",
      "We need to migrate all user data and update the API integration.",
    );
    assert.ok(result.signals.some((s) => s.includes("migration")));
    assert.ok(result.signals.some((s) => s.includes("API")));
  });

  it("counts bullet points as scope indicators", () => {
    const descWithBullets = `## Tasks
- Task one
- Task two
- Task three
- Task four
- Task five`;
    const descWithout = "Just a single paragraph of text.";

    const withBullets = estimateSize("Some feature", descWithBullets);
    const without = estimateSize("Some feature", descWithout);

    assert.ok(withBullets.estimatedLOC > without.estimatedLOC);
    assert.ok(withBullets.signals.some((s) => s.includes("bullet")));
  });

  it("counts acceptance criteria checkboxes", () => {
    const desc = `## Acceptance Criteria
- [ ] First criterion
- [ ] Second criterion
- [x] Already done criterion`;

    const result = estimateSize("Feature", desc);
    assert.ok(result.signals.some((s) => s.includes("acceptance criteria")));
  });

  it("handles missing description", () => {
    const result = estimateSize("Fix something", "");
    assert.ok(typeof result.size === "string");
    assert.ok(result.estimatedLOC >= 5);
  });

  it("handles null description", () => {
    const result = estimateSize("Fix something", null);
    assert.ok(typeof result.size === "string");
    assert.ok(result.estimatedLOC >= 5);
  });

  it("clamps estimated LOC to at least 5", () => {
    // Multiple simplifying signals should not push below 5
    const result = estimateSize("Fix typo", "docs update rename config change");
    assert.ok(result.estimatedLOC >= 5);
  });
});

// ─── checkClarity ────────────────────────────────────────────────

describe("checkClarity", () => {
  it("flags issues with no description", () => {
    const result = checkClarity("Some task", "");
    assert.equal(result.needsClarification, true);
    assert.ok(result.questions.some((q) => q.includes("no description")));
  });

  it("flags issues with very short description", () => {
    const result = checkClarity("Do the thing", "Fix it");
    assert.equal(result.needsClarification, true);
    assert.ok(result.questions.some((q) => q.includes("brief")));
  });

  it("flags issues with vague titles", () => {
    const result = checkClarity("Fix", "This is a detailed description with enough content to not trigger the short description check. We need to fix the issue.");
    assert.equal(result.needsClarification, true);
    assert.ok(result.questions.some((q) => q.includes("short/vague")));
  });

  it("flags issues without acceptance criteria", () => {
    const result = checkClarity(
      "Add logging feature",
      "We need to add logging to the application. This should cover all the major use cases and work well with our existing infrastructure setup.",
    );
    assert.equal(result.needsClarification, true);
    assert.ok(result.questions.some((q) => q.includes("acceptance criteria")));
  });

  it("passes well-structured issues", () => {
    const result = checkClarity(
      "Add user notification preferences",
      `## Summary
Users should be able to configure their notification preferences.

## Requirements
- Add notification settings page
- Support email and push notifications
- Allow per-channel configuration

## Acceptance Criteria
- [ ] Settings page accessible from profile
- [ ] Changes persist across sessions
- [ ] Default preferences applied for new users`,
    );
    assert.equal(result.needsClarification, false);
    assert.equal(result.questions.length, 0);
  });

  it("accepts issues with bullet points as structured", () => {
    const result = checkClarity(
      "Refactor database connection pooling",
      `Switch from individual connections to a connection pool:
- Use pg-pool for PostgreSQL connections
- Configure max connections from env var
- Add connection health checks
- Implement graceful shutdown`,
    );
    assert.equal(result.needsClarification, false);
  });
});

// ─── suggestPriority ─────────────────────────────────────────────

describe("suggestPriority", () => {
  it("suggests High for bug issues", () => {
    const result = suggestPriority(
      "Fix crash on login",
      "The application crashes when users try to log in with expired tokens.",
      [],
      0, // No priority set
    );
    assert.ok(result !== null);
    assert.equal(result.suggestedPriority, 2); // High
    assert.ok(result.reason.includes("bug"));
  });

  it("suggests Normal for feature issues", () => {
    const result = suggestPriority(
      "Add dark mode support",
      "Implement a dark mode theme that users can toggle.",
      ["Feature"],
      0,
    );
    assert.ok(result !== null);
    assert.equal(result.suggestedPriority, 3); // Normal
    assert.ok(result.reason.includes("feature"));
  });

  it("suggests Low for chore issues", () => {
    const result = suggestPriority(
      "Upgrade dependencies",
      "Update all npm dependencies to their latest versions. Technical debt cleanup.",
      [],
      0,
    );
    assert.ok(result !== null);
    assert.equal(result.suggestedPriority, 4); // Low
    assert.ok(result.reason.includes("chore"));
  });

  it("returns null if priority is already set", () => {
    const result = suggestPriority(
      "Fix critical bug",
      "Server crashes on startup",
      [],
      1, // Already Urgent
    );
    assert.equal(result, null);
  });

  it("returns null if no type detected", () => {
    const result = suggestPriority(
      "Something",
      "Lorem ipsum dolor sit amet",
      [],
      0,
    );
    assert.equal(result, null);
  });

  it("detects type from labels", () => {
    const result = suggestPriority(
      "Some task",
      "Description",
      ["Bug", "critical"],
      0,
    );
    assert.ok(result !== null);
    assert.equal(result.suggestedPriority, 2); // High (bug)
  });
});

// ─── analyzeIssue ────────────────────────────────────────────────

describe("analyzeIssue", () => {
  it("returns complete analysis for a well-defined issue", () => {
    const result = analyzeIssue({
      identifier: "DVA-99",
      title: "Add caching layer for API responses",
      description: `## Summary
Add Redis caching for frequently accessed API endpoints.

## Requirements
- Set up Redis connection
- Add cache middleware
- Configure TTL per endpoint

## Acceptance Criteria
- [ ] Cache hits return in <10ms
- [ ] Cache invalidation works correctly`,
      labels: ["Feature"],
      priority: 0,
    });

    assert.equal(result.identifier, "DVA-99");
    assert.ok(SIZE_LABELS.includes(`size:${result.size.size}`));
    assert.ok(typeof result.clarity.needsClarification === "boolean");
    assert.ok(Array.isArray(result.labelsToAdd));
    assert.ok(result.labelsToAdd.some((l) => l.startsWith("size:")));
  });

  it("adds needs-clarification label for vague issues", () => {
    const result = analyzeIssue({
      identifier: "DVA-100",
      title: "Fix bug",
      description: "",
      labels: [],
      priority: 0,
    });

    assert.ok(result.clarity.needsClarification);
    assert.ok(result.labelsToAdd.includes(NEEDS_CLARIFICATION_LABEL));
  });

  it("does not add needs-clarification for clear issues", () => {
    const result = analyzeIssue({
      identifier: "DVA-101",
      title: "Add user notification preferences page",
      description: `## Requirements
- Add settings UI
- Connect to notification API
- Persist user choices

## Acceptance Criteria
- [ ] Users can toggle email notifications
- [ ] Changes save immediately`,
      labels: [],
      priority: 3,
    });

    assert.ok(!result.labelsToAdd.includes(NEEDS_CLARIFICATION_LABEL));
  });
});

// ─── isAlreadyTriaged ────────────────────────────────────────────

describe("isAlreadyTriaged", () => {
  it("returns true if issue has size:small label", () => {
    assert.equal(isAlreadyTriaged(["size:small", "Feature"]), true);
  });

  it("returns true if issue has size:medium label", () => {
    assert.equal(isAlreadyTriaged(["automation", "size:medium"]), true);
  });

  it("returns true if issue has size:large label", () => {
    assert.equal(isAlreadyTriaged(["size:large"]), true);
  });

  it("returns false if no size labels", () => {
    assert.equal(isAlreadyTriaged(["Feature", "automation"]), false);
  });

  it("returns false for empty labels array", () => {
    assert.equal(isAlreadyTriaged([]), false);
  });
});

// ─── buildTriageComment ──────────────────────────────────────────

describe("buildTriageComment", () => {
  it("includes size estimate in comment", () => {
    const analysis = analyzeIssue({
      identifier: "DVA-42",
      title: "Add feature",
      description: "- Requirement 1\n- Requirement 2",
      labels: [],
      priority: 0,
    });

    const comment = buildTriageComment(analysis);
    assert.ok(comment.includes("Auto-Triage Results"));
    assert.ok(comment.includes(analysis.size.size));
    assert.ok(comment.includes(String(analysis.size.estimatedLOC)));
  });

  it("includes clarification questions when needed", () => {
    const analysis = analyzeIssue({
      identifier: "DVA-43",
      title: "Bug",
      description: "",
      labels: [],
      priority: 0,
    });

    const comment = buildTriageComment(analysis);
    assert.ok(comment.includes("Needs clarification"));
    assert.ok(comment.includes("no description"));
  });

  it("includes priority suggestion when present", () => {
    const analysis = analyzeIssue({
      identifier: "DVA-44",
      title: "Fix crash on startup",
      description: "The server crashes when starting due to a missing config file.\n\n- Fix the config loading\n- Add fallback defaults",
      labels: [],
      priority: 0,
    });

    const comment = buildTriageComment(analysis);
    if (analysis.priority) {
      assert.ok(comment.includes("Priority suggestion"));
    }
  });

  it("includes auto-triage attribution", () => {
    const analysis = analyzeIssue({
      identifier: "DVA-45",
      title: "Add tests",
      description: "- Add unit tests\n- Add integration tests",
      labels: [],
      priority: 0,
    });

    const comment = buildTriageComment(analysis);
    assert.ok(comment.includes("auto-triage.mjs"));
  });
});

// ─── Constants ───────────────────────────────────────────────────

describe("constants", () => {
  it("SIZE_LABELS contains expected labels", () => {
    assert.deepEqual(SIZE_LABELS, ["size:small", "size:medium", "size:large"]);
  });

  it("SIZE_THRESHOLDS has correct boundaries", () => {
    assert.equal(SIZE_THRESHOLDS.small, 50);
    assert.equal(SIZE_THRESHOLDS.medium, 200);
  });

  it("NEEDS_CLARIFICATION_LABEL is correct", () => {
    assert.equal(NEEDS_CLARIFICATION_LABEL, "needs-clarification");
  });
});

// ─── Edge Cases ──────────────────────────────────────────────────

describe("edge cases", () => {
  it("handles issue with all undefined fields", () => {
    const result = analyzeIssue({
      identifier: "DVA-0",
      title: "",
      description: undefined,
      labels: undefined,
      priority: undefined,
    });

    assert.ok(typeof result.size.size === "string");
    assert.ok(result.clarity.needsClarification);
  });

  it("handles very long descriptions without crashing", () => {
    const longDesc = "requirement\n".repeat(500) +
      "- bullet point\n".repeat(200);

    const result = estimateSize("Large project", longDesc);
    assert.equal(result.size, "large");
    assert.ok(result.estimatedLOC > SIZE_THRESHOLDS.medium);
  });

  it("handles special characters in title and description", () => {
    const result = analyzeIssue({
      identifier: "DVA-X",
      title: "Fix <script>alert('xss')</script> in output",
      description: "Handle `code` blocks and **bold** $pecial chars: @#$%^&*()",
      labels: [],
      priority: 0,
    });
    assert.ok(typeof result.size.size === "string");
  });
});
