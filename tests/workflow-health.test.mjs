/**
 * Tests for scripts/workflow-health.mjs
 *
 * All tests use dependency injection to mock `exec` (gh CLI) and `readDir`
 * (filesystem) — no real network or gh calls are made.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  checkWorkflowHealth,
  checkAllWorkflows,
  listWorkflowFiles,
  formatHealthSummary,
  parseArgs,
} from "../scripts/workflow-health.mjs";

// ---------------------------------------------------------------------------
// checkWorkflowHealth
// ---------------------------------------------------------------------------

describe("checkWorkflowHealth", () => {
  it("returns healthy=true when all recent runs succeeded", () => {
    const exec = () =>
      JSON.stringify([
        { status: "completed", conclusion: "success" },
        { status: "completed", conclusion: "success" },
        { status: "completed", conclusion: "success" },
      ]);

    const result = checkWorkflowHealth("linear-sync.yml", { exec });
    assert.equal(result.workflow, "linear-sync.yml");
    assert.equal(result.healthy, true);
    assert.equal(result.runs.length, 3);
  });

  it("returns healthy=false when any run has failed", () => {
    const exec = () =>
      JSON.stringify([
        { status: "completed", conclusion: "success" },
        { status: "completed", conclusion: "failure" },
        { status: "completed", conclusion: "success" },
      ]);

    const result = checkWorkflowHealth("linear-sync.yml", { exec });
    assert.equal(result.healthy, false);
    assert.equal(result.runs.length, 3);
  });

  it("returns healthy=false when a run was cancelled", () => {
    const exec = () =>
      JSON.stringify([
        { status: "completed", conclusion: "cancelled" },
      ]);

    const result = checkWorkflowHealth("pr-feedback.yml", { exec });
    assert.equal(result.healthy, false);
  });

  it("returns healthy=true with skipped=true when no runs exist", () => {
    const exec = () => "[]";

    const result = checkWorkflowHealth("new-workflow.yml", { exec });
    assert.equal(result.healthy, true);
    assert.equal(result.skipped, true);
    assert.equal(result.runs.length, 0);
  });

  it("returns healthy=true with skipped=true when gh command fails", () => {
    const exec = () => { throw new Error("gh: command not found"); };

    const result = checkWorkflowHealth("linear-sync.yml", { exec });
    assert.equal(result.healthy, true);
    assert.equal(result.skipped, true);
  });

  it("returns healthy=true with in-progress runs (not a failure)", () => {
    const exec = () =>
      JSON.stringify([
        { status: "in_progress", conclusion: null },
        { status: "completed", conclusion: "success" },
      ]);

    const result = checkWorkflowHealth("conflict-detect.yml", { exec });
    assert.equal(result.healthy, true);
    assert.equal(result.runs.length, 2);
  });

  it("passes correct workflow name to gh CLI", () => {
    let capturedCmd = "";
    const exec = (cmd) => {
      capturedCmd = cmd;
      return "[]";
    };

    checkWorkflowHealth("rollback.yml", { exec });
    assert.ok(capturedCmd.includes("rollback.yml"), `Expected cmd to contain 'rollback.yml'; got: ${capturedCmd}`);
    assert.ok(capturedCmd.includes("gh run list"), `Expected gh run list command; got: ${capturedCmd}`);
    assert.ok(capturedCmd.includes("--limit 5"), `Expected --limit 5; got: ${capturedCmd}`);
    assert.ok(capturedCmd.includes("--json status,conclusion"), `Expected JSON fields; got: ${capturedCmd}`);
  });

  it("handles partial success — mixed success and in_progress is healthy", () => {
    const exec = () =>
      JSON.stringify([
        { status: "in_progress", conclusion: null },
        { status: "completed", conclusion: "success" },
        { status: "completed", conclusion: "success" },
      ]);

    const result = checkWorkflowHealth("pulse-check.yml", { exec });
    assert.equal(result.healthy, true);
  });
});

// ---------------------------------------------------------------------------
// listWorkflowFiles
// ---------------------------------------------------------------------------

describe("listWorkflowFiles", () => {
  it("returns only .yml and .yaml files", () => {
    const readDir = () => [
      "linear-sync.yml",
      "pr-feedback.yml",
      "README.md",
      "conflict-detect.yaml",
      ".gitkeep",
    ];

    const files = listWorkflowFiles({ readDir });
    assert.deepEqual(files, ["linear-sync.yml", "pr-feedback.yml", "conflict-detect.yaml"]);
  });

  it("returns empty array when directory read fails", () => {
    const readDir = () => { throw new Error("ENOENT"); };
    const files = listWorkflowFiles({ readDir });
    assert.deepEqual(files, []);
  });

  it("returns empty array when directory is empty", () => {
    const readDir = () => [];
    const files = listWorkflowFiles({ readDir });
    assert.deepEqual(files, []);
  });
});

// ---------------------------------------------------------------------------
// checkAllWorkflows
// ---------------------------------------------------------------------------

describe("checkAllWorkflows", () => {
  it("returns healthy=true when all workflows are healthy", () => {
    const readDir = () => ["a.yml", "b.yml"];
    const exec = () =>
      JSON.stringify([{ status: "completed", conclusion: "success" }]);

    const summary = checkAllWorkflows({ readDir, exec });
    assert.equal(summary.healthy, true);
    assert.equal(summary.results.length, 2);
    assert.ok(summary.results.every((r) => r.healthy));
  });

  it("returns healthy=false when any workflow has failures", () => {
    const readDir = () => ["good.yml", "bad.yml"];
    const exec = (cmd) => {
      if (cmd.includes("bad.yml")) {
        return JSON.stringify([{ status: "completed", conclusion: "failure" }]);
      }
      return JSON.stringify([{ status: "completed", conclusion: "success" }]);
    };

    const summary = checkAllWorkflows({ readDir, exec });
    assert.equal(summary.healthy, false);
    assert.equal(summary.results.find((r) => r.workflow === "bad.yml").healthy, false);
    assert.equal(summary.results.find((r) => r.workflow === "good.yml").healthy, true);
  });

  it("returns healthy=true when no workflow files exist", () => {
    const readDir = () => [];
    const exec = () => "[]";

    const summary = checkAllWorkflows({ readDir, exec });
    assert.equal(summary.healthy, true);
    assert.equal(summary.results.length, 0);
  });

  it("treats skipped workflows as healthy in overall result", () => {
    const readDir = () => ["no-runs.yml", "good.yml"];
    const exec = (cmd) => {
      if (cmd.includes("no-runs.yml")) return "[]";
      return JSON.stringify([{ status: "completed", conclusion: "success" }]);
    };

    const summary = checkAllWorkflows({ readDir, exec });
    assert.equal(summary.healthy, true);
    assert.ok(summary.results.find((r) => r.workflow === "no-runs.yml").skipped);
  });
});

// ---------------------------------------------------------------------------
// formatHealthSummary
// ---------------------------------------------------------------------------

describe("formatHealthSummary", () => {
  it("includes PASS label for healthy workflows", () => {
    const summary = {
      healthy: true,
      results: [
        { workflow: "linear-sync.yml", healthy: true, runs: [{ status: "completed", conclusion: "success" }] },
      ],
    };
    const output = formatHealthSummary(summary);
    assert.ok(output.includes("[PASS]"), "Expected PASS label");
    assert.ok(output.includes("linear-sync.yml"));
    assert.ok(output.includes("healthy"));
  });

  it("includes FAIL label for unhealthy workflows", () => {
    const summary = {
      healthy: false,
      results: [
        {
          workflow: "pr-feedback.yml",
          healthy: false,
          runs: [
            { status: "completed", conclusion: "failure" },
            { status: "completed", conclusion: "success" },
          ],
        },
      ],
    };
    const output = formatHealthSummary(summary);
    assert.ok(output.includes("[FAIL]"), "Expected FAIL label");
    assert.ok(output.includes("pr-feedback.yml"));
    assert.ok(output.includes("failure"));
    assert.ok(output.includes("failures"), "Should report failure count");
  });

  it("notes 'no runs' for skipped workflows", () => {
    const summary = {
      healthy: true,
      results: [
        { workflow: "new.yml", healthy: true, runs: [], skipped: true },
      ],
    };
    const output = formatHealthSummary(summary);
    assert.ok(output.includes("no runs"), "Should indicate no runs for skipped workflows");
  });

  it("includes header", () => {
    const summary = { healthy: true, results: [] };
    const output = formatHealthSummary(summary);
    assert.ok(output.includes("Workflow Health Check"), "Should include header");
  });

  it("shows correct totals for mixed results", () => {
    const summary = {
      healthy: false,
      results: [
        { workflow: "a.yml", healthy: true, runs: [{ status: "completed", conclusion: "success" }] },
        { workflow: "b.yml", healthy: false, runs: [{ status: "completed", conclusion: "failure" }] },
        { workflow: "c.yml", healthy: true, runs: [], skipped: true },
      ],
    };
    const output = formatHealthSummary(summary);
    assert.ok(output.includes("1 of 3"), "Should show 1 of 3 failures");
  });
});

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

describe("parseArgs", () => {
  it("defaults to no workflow filter, no json, no help", () => {
    const opts = parseArgs(["node", "workflow-health.mjs"]);
    assert.equal(opts.workflow, null);
    assert.equal(opts.json, false);
    assert.equal(opts.help, false);
  });

  it("parses --workflow flag", () => {
    const opts = parseArgs(["node", "workflow-health.mjs", "--workflow", "linear-sync.yml"]);
    assert.equal(opts.workflow, "linear-sync.yml");
  });

  it("parses --json flag", () => {
    const opts = parseArgs(["node", "workflow-health.mjs", "--json"]);
    assert.equal(opts.json, true);
  });

  it("parses --help flag", () => {
    const opts = parseArgs(["node", "workflow-health.mjs", "--help"]);
    assert.equal(opts.help, true);
  });

  it("parses -h as alias for --help", () => {
    const opts = parseArgs(["node", "workflow-health.mjs", "-h"]);
    assert.equal(opts.help, true);
  });

  it("parses combined --workflow and --json flags", () => {
    const opts = parseArgs(["node", "workflow-health.mjs", "--workflow", "rollback.yml", "--json"]);
    assert.equal(opts.workflow, "rollback.yml");
    assert.equal(opts.json, true);
  });
});
