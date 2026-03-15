import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  parseArgs,
  fetchWorkflowRuns,
  fetchRecentPRs,
  fetchLinearStatus,
  enrichWithLinearStatus,
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

// ---------------------------------------------------------------------------
// fetchLinearStatus
// ---------------------------------------------------------------------------

describe("fetchLinearStatus", () => {
  it("returns status string for a valid issue", async () => {
    const mockFetch = async () => ({
      ok: true,
      json: async () => ({
        data: { issues: { nodes: [{ state: { name: "In Progress" } }] } },
      }),
    });
    const status = await fetchLinearStatus("DVA-40", mockFetch);
    assert.equal(status, "In Progress");
  });

  it("returns null on API failure", async () => {
    const mockFetch = async () => ({ ok: false });
    const status = await fetchLinearStatus("DVA-40", mockFetch);
    assert.equal(status, null);
  });

  it("returns null when issue not found", async () => {
    const mockFetch = async () => ({
      ok: true,
      json: async () => ({ data: { issues: { nodes: [] } } }),
    });
    const status = await fetchLinearStatus("DVA-999", mockFetch);
    assert.equal(status, null);
  });

  it("returns null for unparseable identifier", async () => {
    const mockFetch = async () => {
      throw new Error("should not be called");
    };
    const status = await fetchLinearStatus("invalid", mockFetch);
    assert.equal(status, null);
  });
});

// ---------------------------------------------------------------------------
// enrichWithLinearStatus
// ---------------------------------------------------------------------------

describe("enrichWithLinearStatus", () => {
  it("adds linearStatus to each agent", async () => {
    const agents = [
      { issueId: "DVA-40", issueTitle: "Test", status: "In Progress" },
      { issueId: "DVA-41", issueTitle: "Other", status: "Queued" },
    ];
    const mockFetchStatus = async (id) =>
      id === "DVA-40" ? "In Progress" : "Todo";
    const result = await enrichWithLinearStatus(agents, mockFetchStatus);
    assert.equal(result[0].linearStatus, "In Progress");
    assert.equal(result[1].linearStatus, "Todo");
  });

  it("sets linearStatus to null when fetch fails", async () => {
    const agents = [
      { issueId: "DVA-40", issueTitle: "Test", status: "In Progress" },
    ];
    const mockFetchStatus = async () => null;
    const result = await enrichWithLinearStatus(agents, mockFetchStatus);
    assert.equal(result[0].linearStatus, null);
  });
});
