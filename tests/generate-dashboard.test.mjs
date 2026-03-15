import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  parseArgs,
  fetchWorkflowRuns,
  fetchRecentPRs,
  fetchLinearStatus,
  enrichWithLinearStatus,
  buildStaticData,
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

// ---------------------------------------------------------------------------
// buildStaticData
// ---------------------------------------------------------------------------

describe("buildStaticData", () => {
  const now = new Date().toISOString();
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();

  it("overrides PR URLs with provided repoUrl", async () => {
    const runs = [
      {
        id: 10,
        status: "completed",
        conclusion: "success",
        created_at: now,
        run_started_at: fiveMinAgo,
        updated_at: now,
        inputs: { issue_id: "DVA-38", issue_title: "Upgrade" },
      },
    ];
    const prs = [
      { number: 18, title: "DVA-38: Upgrade", headRefName: "feature/DVA-38" },
    ];
    const data = await buildStaticData(runs, prs, {
      repoUrl: "https://github.com/myorg/myrepo",
      fetchStatusFn: async () => null,
    });
    assert.equal(
      data.history[0].prUrl,
      "https://github.com/myorg/myrepo/pull/18"
    );
  });

  it("enriches active agents with Linear status", async () => {
    const runs = [
      {
        id: 1,
        status: "in_progress",
        created_at: now,
        run_started_at: fiveMinAgo,
        inputs: { issue_id: "DVA-40", issue_title: "Filter" },
      },
    ];
    const data = await buildStaticData(runs, [], {
      repoUrl: "https://github.com/test/repo",
      fetchStatusFn: async () => "In Review",
    });
    assert.equal(data.activeAgents[0].linearStatus, "In Review");
  });

  it("includes buildTime timestamp", async () => {
    const data = await buildStaticData([], [], {
      repoUrl: "https://github.com/test/repo",
      fetchStatusFn: async () => null,
    });
    assert.ok(data.buildTime);
    assert.ok(new Date(data.buildTime).getTime() > 0);
  });
});
