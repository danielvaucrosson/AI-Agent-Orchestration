import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  normalizeIssue,
  buildGraph,
  detectCycles,
  filterResolvedBlockers,
  topologicalSort,
  findNextTask,
  checkBlocked,
  formatGraph,
} from "../scripts/task-ordering.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..");

// --- Test helpers ---

function makeIssue(id, identifier, title, priority = 3, status = "Todo") {
  return {
    id,
    identifier,
    title,
    priority: { value: priority },
    status,
    url: `https://linear.app/test/issue/${identifier}`,
  };
}

function makeRelation(type, sourceId, targetId) {
  return { type, sourceId, targetId };
}

// --- Tests ---

describe("normalizeIssue", () => {
  it("normalizes a standard issue", () => {
    const raw = {
      id: "abc-123",
      identifier: "DVA-1",
      title: "Test issue",
      priority: { value: 2 },
      status: "Todo",
      url: "https://linear.app/test/issue/DVA-1",
    };

    const result = normalizeIssue(raw);
    assert.equal(result.id, "abc-123");
    assert.equal(result.identifier, "DVA-1");
    assert.equal(result.title, "Test issue");
    assert.equal(result.priority, 2);
    assert.equal(result.prioritySort, 2);
    assert.equal(result.status, "Todo");
    assert.equal(result.statusLower, "todo");
  });

  it("handles missing priority (defaults to 0/None)", () => {
    const raw = { id: "a", identifier: "DVA-2", title: "No priority" };
    const result = normalizeIssue(raw);
    assert.equal(result.priority, 0);
    assert.equal(result.prioritySort, 5); // None sorts last
  });

  it("maps priority 0 (None) to sort position 5", () => {
    const raw = { id: "a", identifier: "DVA-3", title: "X", priority: { value: 0 } };
    assert.equal(normalizeIssue(raw).prioritySort, 5);
  });

  it("maps priority 1 (Urgent) to sort position 1", () => {
    const raw = { id: "a", identifier: "DVA-4", title: "X", priority: { value: 1 } };
    assert.equal(normalizeIssue(raw).prioritySort, 1);
  });
});

describe("buildGraph", () => {
  it("builds a graph with no relations", () => {
    const issues = [
      makeIssue("a", "DVA-1", "Task A"),
      makeIssue("b", "DVA-2", "Task B"),
    ];

    const graph = buildGraph(issues);
    assert.equal(graph.nodes.size, 2);
    assert.equal(graph.edges.get("DVA-1").size, 0);
    assert.equal(graph.edges.get("DVA-2").size, 0);
  });

  it("builds edges from blocks relations", () => {
    const issues = [
      makeIssue("a", "DVA-1", "Task A"),
      makeIssue("b", "DVA-2", "Task B"),
    ];
    const relations = [
      makeRelation("blocks", "a", "b"), // DVA-1 blocks DVA-2
    ];

    const graph = buildGraph(issues, relations);
    // DVA-2 is blocked by DVA-1
    assert.ok(graph.edges.get("DVA-2").has("DVA-1"));
    assert.equal(graph.edges.get("DVA-1").size, 0);
  });

  it("builds edges from blockedBy relations", () => {
    const issues = [
      makeIssue("a", "DVA-1", "Task A"),
      makeIssue("b", "DVA-2", "Task B"),
    ];
    const relations = [
      makeRelation("blockedBy", "b", "a"), // DVA-2 is blockedBy DVA-1
    ];

    const graph = buildGraph(issues, relations);
    assert.ok(graph.edges.get("DVA-2").has("DVA-1"));
    assert.equal(graph.edges.get("DVA-1").size, 0);
  });

  it("populates blockedBy and blocks arrays on nodes", () => {
    const issues = [
      makeIssue("a", "DVA-1", "Task A"),
      makeIssue("b", "DVA-2", "Task B"),
      makeIssue("c", "DVA-3", "Task C"),
    ];
    const relations = [
      makeRelation("blocks", "a", "b"),
      makeRelation("blocks", "a", "c"),
    ];

    const graph = buildGraph(issues, relations);
    const nodeA = graph.nodes.get("DVA-1");
    const nodeB = graph.nodes.get("DVA-2");

    assert.deepEqual(nodeA.blocks, ["DVA-2", "DVA-3"]);
    assert.deepEqual(nodeB.blockedBy, ["DVA-1"]);
  });
});

describe("detectCycles", () => {
  it("returns no cycles for a DAG", () => {
    const issues = [
      makeIssue("a", "DVA-1", "A"),
      makeIssue("b", "DVA-2", "B"),
      makeIssue("c", "DVA-3", "C"),
    ];
    const relations = [
      makeRelation("blocks", "a", "b"),
      makeRelation("blocks", "b", "c"),
    ];

    const graph = buildGraph(issues, relations);
    const result = detectCycles(graph);
    assert.equal(result.hasCycles, false);
    assert.equal(result.cycles.length, 0);
  });

  it("detects a simple two-node cycle", () => {
    const issues = [
      makeIssue("a", "DVA-1", "A"),
      makeIssue("b", "DVA-2", "B"),
    ];
    const relations = [
      makeRelation("blocks", "a", "b"),
      makeRelation("blocks", "b", "a"),
    ];

    const graph = buildGraph(issues, relations);
    const result = detectCycles(graph);
    assert.equal(result.hasCycles, true);
    assert.ok(result.cycles.length > 0);
  });

  it("detects a three-node cycle", () => {
    const issues = [
      makeIssue("a", "DVA-1", "A"),
      makeIssue("b", "DVA-2", "B"),
      makeIssue("c", "DVA-3", "C"),
    ];
    const relations = [
      makeRelation("blocks", "a", "b"),
      makeRelation("blocks", "b", "c"),
      makeRelation("blocks", "c", "a"),
    ];

    const graph = buildGraph(issues, relations);
    const result = detectCycles(graph);
    assert.equal(result.hasCycles, true);
  });
});

describe("filterResolvedBlockers", () => {
  it("removes blockers with Done status", () => {
    const issues = [
      makeIssue("a", "DVA-1", "Blocker", 2, "Done"),
      makeIssue("b", "DVA-2", "Blocked Task", 3, "Todo"),
    ];
    const relations = [makeRelation("blocks", "a", "b")];

    const graph = buildGraph(issues, relations);
    const filtered = filterResolvedBlockers(graph);

    assert.equal(filtered.edges.get("DVA-2").size, 0);
  });

  it("removes blockers with Canceled status", () => {
    const issues = [
      makeIssue("a", "DVA-1", "Blocker", 2, "Canceled"),
      makeIssue("b", "DVA-2", "Blocked Task", 3, "Todo"),
    ];
    const relations = [makeRelation("blocks", "a", "b")];

    const graph = buildGraph(issues, relations);
    const filtered = filterResolvedBlockers(graph);

    assert.equal(filtered.edges.get("DVA-2").size, 0);
  });

  it("keeps blockers with active statuses", () => {
    const issues = [
      makeIssue("a", "DVA-1", "Blocker", 2, "In Progress"),
      makeIssue("b", "DVA-2", "Blocked Task", 3, "Todo"),
    ];
    const relations = [makeRelation("blocks", "a", "b")];

    const graph = buildGraph(issues, relations);
    const filtered = filterResolvedBlockers(graph);

    assert.equal(filtered.edges.get("DVA-2").size, 1);
    assert.ok(filtered.edges.get("DVA-2").has("DVA-1"));
  });
});

describe("topologicalSort", () => {
  it("sorts independent issues by priority", () => {
    const issues = [
      makeIssue("a", "DVA-1", "Low priority", 4, "Todo"),
      makeIssue("b", "DVA-2", "Urgent", 1, "Todo"),
      makeIssue("c", "DVA-3", "Medium", 3, "Todo"),
    ];

    const graph = buildGraph(issues);
    const { ordered } = topologicalSort(graph);

    assert.equal(ordered[0].identifier, "DVA-2"); // Urgent first
    assert.equal(ordered[1].identifier, "DVA-3"); // Then Medium
    assert.equal(ordered[2].identifier, "DVA-1"); // Then Low
  });

  it("respects dependencies over priority", () => {
    const issues = [
      makeIssue("a", "DVA-1", "Low priority blocker", 4, "Todo"),
      makeIssue("b", "DVA-2", "Urgent blocked", 1, "Todo"),
    ];
    const relations = [makeRelation("blocks", "a", "b")];

    const graph = buildGraph(issues, relations);
    const { ordered } = topologicalSort(graph);

    // DVA-1 must come first because DVA-2 depends on it
    assert.equal(ordered[0].identifier, "DVA-1");
    assert.equal(ordered[1].identifier, "DVA-2");
  });

  it("handles a chain of dependencies", () => {
    const issues = [
      makeIssue("c", "DVA-3", "Third", 3, "Todo"),
      makeIssue("a", "DVA-1", "First", 3, "Todo"),
      makeIssue("b", "DVA-2", "Second", 3, "Todo"),
    ];
    const relations = [
      makeRelation("blocks", "a", "b"),
      makeRelation("blocks", "b", "c"),
    ];

    const graph = buildGraph(issues, relations);
    const { ordered } = topologicalSort(graph);

    assert.equal(ordered[0].identifier, "DVA-1");
    assert.equal(ordered[1].identifier, "DVA-2");
    assert.equal(ordered[2].identifier, "DVA-3");
  });

  it("identifies circular nodes as blocked", () => {
    const issues = [
      makeIssue("a", "DVA-1", "A", 3, "Todo"),
      makeIssue("b", "DVA-2", "B", 3, "Todo"),
      makeIssue("c", "DVA-3", "Independent", 3, "Todo"),
    ];
    const relations = [
      makeRelation("blocks", "a", "b"),
      makeRelation("blocks", "b", "a"),
    ];

    const graph = buildGraph(issues, relations);
    const { ordered, blocked } = topologicalSort(graph);

    // DVA-3 is orderable, DVA-1 and DVA-2 are in a cycle
    assert.equal(ordered.length, 1);
    assert.equal(ordered[0].identifier, "DVA-3");
    assert.equal(blocked.length, 2);
  });
});

describe("findNextTask", () => {
  it("returns highest priority unblocked task", () => {
    const issues = [
      makeIssue("a", "DVA-1", "Low", 4, "Todo"),
      makeIssue("b", "DVA-2", "High", 2, "Todo"),
      makeIssue("c", "DVA-3", "Medium", 3, "Todo"),
    ];

    const graph = buildGraph(issues);
    const { task } = findNextTask(graph);

    assert.equal(task.identifier, "DVA-2"); // High priority
  });

  it("skips blocked tasks", () => {
    const issues = [
      makeIssue("a", "DVA-1", "Blocker (low)", 4, "Todo"),
      makeIssue("b", "DVA-2", "Blocked (high)", 1, "Backlog"),
    ];
    const relations = [makeRelation("blocks", "a", "b")];

    const graph = buildGraph(issues, relations);
    const { task } = findNextTask(graph);

    // DVA-1 is picked because DVA-2 is blocked
    assert.equal(task.identifier, "DVA-1");
  });

  it("returns null when no actionable tasks", () => {
    const issues = [
      makeIssue("a", "DVA-1", "Already in progress", 1, "In Progress"),
      makeIssue("b", "DVA-2", "Already done", 2, "Done"),
    ];

    const graph = buildGraph(issues);
    const { task } = findNextTask(graph);

    assert.equal(task, null);
  });

  it("identifies tasks that would be unblocked", () => {
    const issues = [
      makeIssue("a", "DVA-1", "Blocker", 2, "Todo"),
      makeIssue("b", "DVA-2", "Blocked by 1 only", 1, "Todo"),
    ];
    const relations = [makeRelation("blocks", "a", "b")];

    const graph = buildGraph(issues, relations);
    const { task, blockedTasks } = findNextTask(graph);

    assert.equal(task.identifier, "DVA-1");
    assert.equal(blockedTasks.length, 1);
    assert.equal(blockedTasks[0].identifier, "DVA-2");
  });

  it("treats resolved blockers as non-blocking", () => {
    const issues = [
      makeIssue("a", "DVA-1", "Done blocker", 3, "Done"),
      makeIssue("b", "DVA-2", "Was blocked", 1, "Todo"),
    ];
    const relations = [makeRelation("blocks", "a", "b")];

    const graph = buildGraph(issues, relations);
    const { task } = findNextTask(graph);

    // DVA-2 should be available since DVA-1 is Done
    assert.equal(task.identifier, "DVA-2");
  });
});

describe("checkBlocked", () => {
  it("reports an unblocked issue", () => {
    const issues = [makeIssue("a", "DVA-1", "Free task", 3, "Todo")];
    const graph = buildGraph(issues);
    const result = checkBlocked(graph, "DVA-1");

    assert.equal(result.isBlocked, false);
    assert.ok(result.reason.includes("not blocked"));
  });

  it("reports a blocked issue with its blockers", () => {
    const issues = [
      makeIssue("a", "DVA-1", "Blocker", 2, "Todo"),
      makeIssue("b", "DVA-2", "Blocked", 1, "Todo"),
    ];
    const relations = [makeRelation("blocks", "a", "b")];

    const graph = buildGraph(issues, relations);
    const result = checkBlocked(graph, "DVA-2");

    assert.equal(result.isBlocked, true);
    assert.equal(result.blockers.length, 1);
    assert.equal(result.blockers[0].identifier, "DVA-1");
  });

  it("reports transitive blockers", () => {
    const issues = [
      makeIssue("a", "DVA-1", "Root blocker", 2, "Todo"),
      makeIssue("b", "DVA-2", "Middle", 3, "Todo"),
      makeIssue("c", "DVA-3", "End", 3, "Todo"),
    ];
    const relations = [
      makeRelation("blocks", "a", "b"),
      makeRelation("blocks", "b", "c"),
    ];

    const graph = buildGraph(issues, relations);
    const result = checkBlocked(graph, "DVA-3");

    assert.equal(result.isBlocked, true);
    assert.equal(result.blockers.length, 1); // Direct: DVA-2
    assert.equal(result.blockers[0].identifier, "DVA-2");
    assert.equal(result.transitive.length, 1); // Transitive: DVA-1
    assert.equal(result.transitive[0].identifier, "DVA-1");
  });

  it("handles non-existent issue", () => {
    const issues = [makeIssue("a", "DVA-1", "A", 3, "Todo")];
    const graph = buildGraph(issues);
    const result = checkBlocked(graph, "DVA-99");

    assert.equal(result.isBlocked, false);
    assert.ok(result.reason.includes("not found"));
  });
});

describe("formatGraph", () => {
  it("generates Markdown output", () => {
    const issues = [
      makeIssue("a", "DVA-1", "First", 2, "Todo"),
      makeIssue("b", "DVA-2", "Second", 3, "Todo"),
    ];
    const relations = [makeRelation("blocks", "a", "b")];

    const graph = buildGraph(issues, relations);
    const output = formatGraph(graph);

    assert.ok(output.includes("## Dependency Graph"));
    assert.ok(output.includes("Execution Order"));
    assert.ok(output.includes("DVA-1"));
    assert.ok(output.includes("DVA-2"));
  });

  it("shows circular dependency warnings", () => {
    const issues = [
      makeIssue("a", "DVA-1", "A", 3, "Todo"),
      makeIssue("b", "DVA-2", "B", 3, "Todo"),
    ];
    const relations = [
      makeRelation("blocks", "a", "b"),
      makeRelation("blocks", "b", "a"),
    ];

    const graph = buildGraph(issues, relations);
    const output = formatGraph(graph);

    assert.ok(output.includes("Circular Dependencies"));
    assert.ok(output.includes("Blocked"));
  });
});

describe("CLI", () => {
  function run(args) {
    return execSync(
      `node "${join(PROJECT_ROOT, "scripts", "task-ordering.mjs")}" ${args}`,
      { encoding: "utf-8", cwd: PROJECT_ROOT, timeout: 10000 }
    );
  }

  it("shows help with --help", () => {
    const out = run("--help");
    assert.ok(out.includes("Usage:"));
    assert.ok(out.includes("next"));
    assert.ok(out.includes("order"));
    assert.ok(out.includes("check"));
    assert.ok(out.includes("graph"));
  });

  it("exits with error for unknown command", () => {
    try {
      run("nonexistent");
      assert.fail("Should have thrown");
    } catch (err) {
      assert.ok(err.status !== 0);
    }
  });
});
