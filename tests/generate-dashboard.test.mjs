import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  parseArgs,
  fetchWorkflowRuns,
  fetchRecentPRs,
} from "../scripts/generate-dashboard.mjs";

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

describe("parseArgs", () => {
  it("parses --out flag", () => {
    const args = parseArgs(["--out", "_site/dashboard/index.html"]);
    assert.equal(args.out, "_site/dashboard/index.html");
  });

  it("defaults to _site/dashboard/index.html", () => {
    const args = parseArgs([]);
    assert.equal(args.out, "_site/dashboard/index.html");
  });
});

// ---------------------------------------------------------------------------
// fetchWorkflowRuns
// ---------------------------------------------------------------------------

describe("fetchWorkflowRuns", () => {
  it("returns workflow_runs array from API response", async () => {
    const mockFetch = async () => ({
      ok: true,
      json: async () => ({ workflow_runs: [{ id: 1, status: "completed" }] }),
    });
    const runs = await fetchWorkflowRuns("owner/repo", mockFetch);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].id, 1);
  });

  it("returns empty array on API failure", async () => {
    const mockFetch = async () => ({ ok: false, status: 500 });
    const runs = await fetchWorkflowRuns("owner/repo", mockFetch);
    assert.deepEqual(runs, []);
  });
});

// ---------------------------------------------------------------------------
// fetchRecentPRs
// ---------------------------------------------------------------------------

describe("fetchRecentPRs", () => {
  it("returns PR array from API response", async () => {
    const mockFetch = async () => ({
      ok: true,
      json: async () => [
        {
          number: 18,
          title: "DVA-38: Upgrade",
          head: { ref: "feature/DVA-38" },
        },
      ],
    });
    const prs = await fetchRecentPRs("owner/repo", mockFetch);
    assert.equal(prs.length, 1);
    assert.equal(prs[0].number, 18);
    assert.equal(prs[0].headRefName, "feature/DVA-38");
  });

  it("returns empty array on failure", async () => {
    const mockFetch = async () => ({ ok: false });
    const prs = await fetchRecentPRs("owner/repo", mockFetch);
    assert.deepEqual(prs, []);
  });
});
