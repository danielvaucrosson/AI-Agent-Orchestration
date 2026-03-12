import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseGitLog,
  parsePrJson,
  loadAuditTrails,
  mergeMetrics,
  computeSummary,
  renderHtml,
} from "../scripts/dashboard.mjs";

// ---------------------------------------------------------------------------
// parseGitLog
// ---------------------------------------------------------------------------

describe("parseGitLog", () => {
  it("returns empty array for null/empty input", () => {
    assert.deepStrictEqual(parseGitLog(null), []);
    assert.deepStrictEqual(parseGitLog(""), []);
  });

  it("extracts commit counts per issue", () => {
    const raw = [
      "COMMIT|abc123|2026-01-01T10:00:00+00:00|DVA-9: Add handoff protocol",
      "5\t2\tsrc/handoff.mjs",
      "COMMIT|def456|2026-01-02T12:00:00+00:00|DVA-9: Fix typo",
      "1\t1\tsrc/handoff.mjs",
      "COMMIT|ghi789|2026-01-03T08:00:00+00:00|DVA-10: Add auto-issue",
      "20\t0\tsrc/auto-issue.mjs",
    ].join("\n");

    const result = parseGitLog(raw);
    assert.equal(result.length, 2);

    const dva9 = result.find((r) => r.id === "DVA-9");
    assert.equal(dva9.commits, 2);
    assert.equal(dva9.linesAdded, 6);
    assert.equal(dva9.linesRemoved, 3);

    const dva10 = result.find((r) => r.id === "DVA-10");
    assert.equal(dva10.commits, 1);
    assert.equal(dva10.linesAdded, 20);
    assert.equal(dva10.linesRemoved, 0);
  });

  it("tracks first and last commit timestamps", () => {
    const raw = [
      "COMMIT|a|2026-01-05T10:00:00+00:00|DVA-11: First commit",
      "1\t0\tfile.mjs",
      "COMMIT|b|2026-01-01T08:00:00+00:00|DVA-11: Earlier commit",
      "2\t0\tfile.mjs",
    ].join("\n");

    const result = parseGitLog(raw);
    const dva11 = result.find((r) => r.id === "DVA-11");
    assert.equal(dva11.firstCommitAt, "2026-01-01T08:00:00+00:00");
    assert.equal(dva11.lastCommitAt, "2026-01-05T10:00:00+00:00");
  });

  it("handles pipe characters in commit subjects", () => {
    const raw = [
      "COMMIT|abc|2026-01-01T10:00:00+00:00|DVA-9: Add feature | fix edge case",
      "5\t2\tsrc/feature.mjs",
    ].join("\n");

    const result = parseGitLog(raw);
    assert.equal(result.length, 1);
    assert.equal(result[0].id, "DVA-9");
    assert.equal(result[0].commits, 1);
  });

  it("ignores commits without issue IDs", () => {
    const raw = [
      "COMMIT|abc|2026-01-01T10:00:00+00:00|Initial commit",
      "10\t0\tREADME.md",
      "COMMIT|def|2026-01-02T10:00:00+00:00|DVA-9: Add feature",
      "5\t0\tsrc/feature.mjs",
    ].join("\n");

    const result = parseGitLog(raw);
    assert.equal(result.length, 1);
    assert.equal(result[0].id, "DVA-9");
  });
});

// ---------------------------------------------------------------------------
// parsePrJson
// ---------------------------------------------------------------------------

describe("parsePrJson", () => {
  it("returns empty map for null/empty input", () => {
    assert.equal(parsePrJson(null).size, 0);
    assert.equal(parsePrJson("").size, 0);
  });

  it("returns empty map for invalid JSON", () => {
    assert.equal(parsePrJson("not json").size, 0);
  });

  it("maps PRs to issue IDs from branch name", () => {
    const json = JSON.stringify([
      {
        number: 4,
        title: "DVA-9: Add handoff",
        headRefName: "feature/DVA-9-handoff",
        createdAt: "2026-01-01T00:00:00Z",
        mergedAt: "2026-01-03T00:00:00Z",
        reviews: [],
      },
      {
        number: 5,
        title: "DVA-10: Auto-issue",
        headRefName: "feature/DVA-10-auto-issue",
        createdAt: "2026-01-04T00:00:00Z",
        mergedAt: null,
        reviews: [{ id: 1 }, { id: 2 }],
      },
    ]);

    const result = parsePrJson(json);
    assert.equal(result.size, 2);
    assert.equal(result.get("DVA-9").prNumber, 4);
    assert.equal(result.get("DVA-9").prMergedAt, "2026-01-03T00:00:00Z");
    assert.equal(result.get("DVA-10").prNumber, 5);
    assert.equal(result.get("DVA-10").reviewCount, 2);
  });
});

// ---------------------------------------------------------------------------
// loadAuditTrails
// ---------------------------------------------------------------------------

describe("loadAuditTrails", () => {
  it("returns empty array for nonexistent directory", () => {
    const result = loadAuditTrails("/nonexistent/path/audits");
    assert.deepStrictEqual(result, []);
  });
});

// ---------------------------------------------------------------------------
// mergeMetrics
// ---------------------------------------------------------------------------

describe("mergeMetrics", () => {
  it("computes cycle time from Linear timestamps", () => {
    const linear = {
      title: "Test Issue",
      status: "Done",
      createdAt: "2026-01-01T00:00:00Z",
      completedAt: "2026-01-03T12:00:00Z",
    };
    const result = mergeMetrics("DVA-9", null, null, linear, []);
    assert.equal(result.cycleTimeDays, 2.5);
    assert.equal(result.title, "Test Issue");
    assert.equal(result.status, "Done");
  });

  it("returns null cycle time when timestamps missing", () => {
    const result = mergeMetrics("DVA-9", null, null, null, []);
    assert.equal(result.cycleTimeDays, null);
    assert.equal(result.status, "Unknown");
  });

  it("merges git and PR data", () => {
    const git = {
      id: "DVA-9",
      commits: 3,
      linesAdded: 100,
      linesRemoved: 20,
      firstCommitAt: "2026-01-01T00:00:00Z",
      lastCommitAt: "2026-01-02T00:00:00Z",
    };
    const pr = {
      prNumber: 4,
      prMergedAt: "2026-01-03T00:00:00Z",
      reviewCount: 1,
    };
    const result = mergeMetrics("DVA-9", git, pr, null, []);
    assert.equal(result.commits, 3);
    assert.equal(result.linesAdded, 100);
    assert.equal(result.prNumber, 4);
    assert.equal(result.reviewCount, 1);
  });

  it("counts matching audit entries", () => {
    const audits = [
      { issueId: "DVA-9", actions: 10 },
      { issueId: "DVA-10", actions: 5 },
      { issueId: "DVA-9", actions: 8 },
    ];
    const result = mergeMetrics("DVA-9", null, null, null, audits);
    assert.equal(result.auditEvents, 2);
  });
});

// ---------------------------------------------------------------------------
// computeSummary
// ---------------------------------------------------------------------------

describe("computeSummary", () => {
  it("computes averages and totals", () => {
    const entries = [
      { cycleTimeDays: 2, commits: 3, linesAdded: 100, linesRemoved: 20 },
      { cycleTimeDays: 4, commits: 5, linesAdded: 200, linesRemoved: 30 },
    ];
    const summary = computeSummary(entries);
    assert.equal(summary.totalIssues, 2);
    assert.equal(summary.avgCycleTimeDays, 3);
    assert.equal(summary.totalCommits, 8);
    assert.equal(summary.totalLinesChanged, 350);
  });

  it("handles null cycle times in average", () => {
    const entries = [
      { cycleTimeDays: null, commits: 1, linesAdded: 10, linesRemoved: 0 },
      { cycleTimeDays: 6, commits: 2, linesAdded: 20, linesRemoved: 5 },
    ];
    const summary = computeSummary(entries);
    assert.equal(summary.avgCycleTimeDays, 6);
  });

  it("returns null average when all cycle times are null", () => {
    const entries = [
      { cycleTimeDays: null, commits: 1, linesAdded: 0, linesRemoved: 0 },
    ];
    const summary = computeSummary(entries);
    assert.equal(summary.avgCycleTimeDays, null);
  });

  it("excludes NaN and negative cycle times from average", () => {
    const entries = [
      { cycleTimeDays: -1, commits: 1, linesAdded: 0, linesRemoved: 0 },
      { cycleTimeDays: NaN, commits: 1, linesAdded: 0, linesRemoved: 0 },
      { cycleTimeDays: 4, commits: 1, linesAdded: 0, linesRemoved: 0 },
    ];
    const summary = computeSummary(entries);
    assert.equal(summary.avgCycleTimeDays, 4);
  });

  it("handles empty entries array", () => {
    const summary = computeSummary([]);
    assert.equal(summary.totalIssues, 0);
    assert.equal(summary.avgCycleTimeDays, null);
    assert.equal(summary.totalCommits, 0);
    assert.equal(summary.totalLinesChanged, 0);
  });
});

// ---------------------------------------------------------------------------
// renderHtml
// ---------------------------------------------------------------------------

describe("renderHtml", () => {
  const sampleData = {
    generatedAt: "2026-03-11T12:00:00Z",
    issues: [
      {
        id: "DVA-9",
        title: "Agent Handoff Protocol",
        status: "Done",
        cycleTimeDays: 2.5,
        commits: 3,
        linesAdded: 142,
        linesRemoved: 18,
        prNumber: 4,
        prMergedAt: "2026-01-03T00:00:00Z",
        reviewCount: 1,
        auditEvents: 0,
      },
    ],
    summary: {
      totalIssues: 1,
      avgCycleTimeDays: 2.5,
      totalCommits: 3,
      totalLinesChanged: 160,
    },
  };

  it("returns a valid HTML document", () => {
    const html = renderHtml(sampleData);
    assert.ok(html.startsWith("<!DOCTYPE html>"));
    assert.ok(html.includes("</html>"));
  });

  it("includes Chart.js CDN", () => {
    const html = renderHtml(sampleData);
    assert.ok(html.includes("chart.js"));
  });

  it("embeds issue data", () => {
    const html = renderHtml(sampleData);
    assert.ok(html.includes("DVA-9"));
    assert.ok(html.includes("Agent Handoff Protocol"));
  });

  it("displays summary statistics", () => {
    const html = renderHtml(sampleData);
    assert.ok(html.includes("2.5"));
    assert.ok(html.includes("160"));
  });

  it("escapes HTML in titles", () => {
    const data = {
      ...sampleData,
      issues: [
        {
          ...sampleData.issues[0],
          title: '<script>alert("xss")</script>',
        },
      ],
    };
    const html = renderHtml(data);
    assert.ok(!html.includes('<script>alert("xss")</script>'));
    assert.ok(html.includes("&lt;script&gt;"));
  });

  it("handles null values gracefully", () => {
    const data = {
      generatedAt: "2026-03-11T12:00:00Z",
      issues: [
        {
          id: "DVA-99",
          title: null,
          status: null,
          cycleTimeDays: null,
          commits: null,
          linesAdded: null,
          linesRemoved: null,
          prNumber: null,
          reviewCount: 0,
          auditEvents: 0,
        },
      ],
      summary: {
        totalIssues: 1,
        avgCycleTimeDays: null,
        totalCommits: 0,
        totalLinesChanged: 0,
      },
    };
    const html = renderHtml(data);
    assert.ok(html.includes("DVA-99"));
    assert.ok(html.includes("N/A"));
    assert.ok(html.includes("\u2014")); // em-dash for missing data
  });
});
