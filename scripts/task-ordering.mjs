/**
 * Dependency-aware task ordering for Linear issues.
 *
 * Builds a dependency graph from Linear issue relations (blocks/blockedBy),
 * detects circular dependencies, and returns issues in optimal execution
 * order respecting both dependencies and priority.
 *
 * Usage:
 *   node scripts/task-ordering.mjs next    [--team DVA] [--project "..."]
 *   node scripts/task-ordering.mjs order   [--team DVA] [--project "..."]
 *   node scripts/task-ordering.mjs check   <issue-id>
 *   node scripts/task-ordering.mjs graph   [--team DVA] [--project "..."]
 *   node scripts/task-ordering.mjs --help
 *
 * Prefers Linear MCP tools (via stdin JSON), falls back to @linear/sdk.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..");

// --- Priority mapping ---
// Linear priorities: 0=None, 1=Urgent, 2=High, 3=Medium, 4=Low
// Lower number = higher priority (except 0 which means "unset")
// We remap 0 (None) to 5 so it sorts after Low.
const PRIORITY_SORT = { 0: 5, 1: 1, 2: 2, 3: 3, 4: 4 };

// Statuses that mean "work is not yet started"
const ACTIONABLE_STATUSES = ["backlog", "todo"];

// Statuses that mean "this blocker is resolved"
const RESOLVED_STATUSES = ["done", "canceled", "cancelled", "duplicate"];

// --- Graph data structures ---

/**
 * Normalize an issue from Linear API/MCP into a consistent shape.
 *
 * @param {object} raw - Raw issue data from Linear
 * @returns {object} Normalized issue node
 */
export function normalizeIssue(raw) {
  const priority = raw.priority?.value ?? raw.priority ?? 0;
  const statusName = raw.status?.name ?? raw.status ?? raw.state?.name ?? "";
  return {
    id: raw.id,
    identifier: raw.identifier,
    title: raw.title,
    priority: typeof priority === "number" ? priority : 0,
    prioritySort: PRIORITY_SORT[priority] ?? 5,
    status: statusName,
    statusLower: statusName.toLowerCase(),
    blockedBy: [],  // filled by buildGraph
    blocks: [],     // filled by buildGraph
    url: raw.url || "",
  };
}

/**
 * Build a dependency graph from a list of issues with relations.
 *
 * @param {object[]} issues - Array of normalized issues
 * @param {object[]} relations - Array of { type, sourceId, targetId }
 *   where type is "blocks" (sourceId blocks targetId)
 * @returns {{ nodes: Map<string, object>, edges: Map<string, Set<string>> }}
 */
export function buildGraph(issues, relations = []) {
  const nodes = new Map();
  const edges = new Map(); // blockedBy edges: key is blocked issue, value is set of blockers

  // Index issues by both id and identifier for flexible lookup
  const byId = new Map();
  const byIdentifier = new Map();

  for (const issue of issues) {
    const node = normalizeIssue(issue);
    nodes.set(node.identifier, node);
    byId.set(node.id, node);
    byIdentifier.set(node.identifier, node);
    edges.set(node.identifier, new Set());
  }

  // Process relations
  for (const rel of relations) {
    if (rel.type === "blocks") {
      // sourceId blocks targetId => targetId is blockedBy sourceId
      const blocker = byId.get(rel.sourceId) || byIdentifier.get(rel.sourceId);
      const blocked = byId.get(rel.targetId) || byIdentifier.get(rel.targetId);

      if (blocker && blocked) {
        edges.get(blocked.identifier)?.add(blocker.identifier);
        blocked.blockedBy.push(blocker.identifier);
        blocker.blocks.push(blocked.identifier);
      }
    } else if (rel.type === "blockedBy") {
      // sourceId is blockedBy targetId => sourceId is blockedBy targetId
      const blocked = byId.get(rel.sourceId) || byIdentifier.get(rel.sourceId);
      const blocker = byId.get(rel.targetId) || byIdentifier.get(rel.targetId);

      if (blocker && blocked) {
        edges.get(blocked.identifier)?.add(blocker.identifier);
        blocked.blockedBy.push(blocker.identifier);
        blocker.blocks.push(blocked.identifier);
      }
    }
  }

  return { nodes, edges };
}

/**
 * Detect circular dependencies using DFS three-color marking.
 *
 * @param {{ nodes: Map, edges: Map }} graph
 * @returns {{ hasCycles: boolean, cycles: string[][] }}
 */
export function detectCycles(graph) {
  const { nodes, edges } = graph;
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map();
  const parent = new Map();
  const cycles = [];

  for (const id of nodes.keys()) {
    color.set(id, WHITE);
  }

  function dfs(nodeId) {
    color.set(nodeId, GRAY);

    const blockers = edges.get(nodeId) || new Set();
    for (const blockerId of blockers) {
      if (!nodes.has(blockerId)) continue;

      if (color.get(blockerId) === GRAY) {
        // Found a cycle — trace it back
        const cycle = [blockerId, nodeId];
        let curr = nodeId;
        while (curr !== blockerId && parent.has(curr)) {
          curr = parent.get(curr);
          if (curr !== blockerId) cycle.push(curr);
        }
        cycles.push(cycle.reverse());
      } else if (color.get(blockerId) === WHITE) {
        parent.set(blockerId, nodeId);
        dfs(blockerId);
      }
    }

    color.set(nodeId, BLACK);
  }

  for (const nodeId of nodes.keys()) {
    if (color.get(nodeId) === WHITE) {
      dfs(nodeId);
    }
  }

  return { hasCycles: cycles.length > 0, cycles };
}

/**
 * Filter out resolved blockers from edges.
 * A blocker is "resolved" if its status is Done, Canceled, etc.
 *
 * @param {{ nodes: Map, edges: Map }} graph
 * @returns {{ nodes: Map, edges: Map }} New graph with resolved blockers removed
 */
export function filterResolvedBlockers(graph) {
  const { nodes, edges } = graph;
  const newEdges = new Map();

  for (const [nodeId, blockerSet] of edges) {
    const filtered = new Set();
    for (const blockerId of blockerSet) {
      const blocker = nodes.get(blockerId);
      if (blocker && !RESOLVED_STATUSES.includes(blocker.statusLower)) {
        filtered.add(blockerId);
      }
    }
    newEdges.set(nodeId, filtered);
  }

  // Update blockedBy on nodes to match filtered edges
  const newNodes = new Map();
  for (const [id, node] of nodes) {
    const filteredBlockers = [...(newEdges.get(id) || [])];
    newNodes.set(id, {
      ...node,
      blockedBy: filteredBlockers,
    });
  }

  return { nodes: newNodes, edges: newEdges };
}

/**
 * Topological sort using Kahn's algorithm with priority ordering.
 * Returns issues in optimal execution order: dependencies first,
 * ties broken by priority (urgent > high > medium > low > none).
 *
 * @param {{ nodes: Map, edges: Map }} graph
 * @returns {{ ordered: object[], blocked: object[], circular: string[][] }}
 */
export function topologicalSort(graph) {
  const { nodes, edges } = graph;

  // Compute in-degree for each node
  const inDegree = new Map();
  for (const id of nodes.keys()) {
    inDegree.set(id, 0);
  }
  for (const [, blockerSet] of edges) {
    // Each blocker adds an in-degree to the blocked node — wait,
    // edges maps blocked -> Set<blockers>, so the blocked node
    // has in-degree = number of blockers
    // Actually, for Kahn's algorithm on a DAG:
    // Edge direction: blocker -> blocked (blocker must come first)
    // In-degree of a node = number of blockers it has
  }
  for (const [nodeId, blockerSet] of edges) {
    inDegree.set(nodeId, blockerSet.size);
  }

  // Start with nodes that have no blockers (in-degree 0)
  // Use a sorted array as a simple priority queue
  let ready = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) {
      ready.push(nodes.get(id));
    }
  }

  // Sort by priority (lower prioritySort = higher priority)
  ready.sort((a, b) => a.prioritySort - b.prioritySort);

  const ordered = [];

  // Also build a reverse adjacency: blocker -> Set<blocked>
  const reverseEdges = new Map();
  for (const id of nodes.keys()) {
    reverseEdges.set(id, new Set());
  }
  for (const [blockedId, blockerSet] of edges) {
    for (const blockerId of blockerSet) {
      reverseEdges.get(blockerId)?.add(blockedId);
    }
  }

  while (ready.length > 0) {
    // Take the highest priority ready node
    const node = ready.shift();
    ordered.push(node);

    // "Remove" this node — reduce in-degree of nodes it blocks
    const unblocks = reverseEdges.get(node.identifier) || new Set();
    for (const unblockedId of unblocks) {
      const deg = inDegree.get(unblockedId) - 1;
      inDegree.set(unblockedId, deg);
      if (deg === 0) {
        ready.push(nodes.get(unblockedId));
      }
    }

    // Re-sort ready list by priority
    ready.sort((a, b) => a.prioritySort - b.prioritySort);
  }

  // Any nodes not in ordered are part of cycles
  const blocked = [];
  for (const [id, node] of nodes) {
    if (!ordered.find((o) => o.identifier === id)) {
      blocked.push(node);
    }
  }

  // Detect cycles in remaining nodes
  const cycleResult = detectCycles(graph);

  return { ordered, blocked, circular: cycleResult.cycles };
}

/**
 * Find the next task to work on: the highest-priority unblocked actionable issue.
 *
 * @param {{ nodes: Map, edges: Map }} graph
 * @returns {{ task: object|null, reason: string, blockedTasks: object[] }}
 */
export function findNextTask(graph) {
  const filtered = filterResolvedBlockers(graph);
  const { ordered } = topologicalSort(filtered);

  // Filter to actionable statuses (backlog, todo)
  const actionable = ordered.filter((node) =>
    ACTIONABLE_STATUSES.includes(node.statusLower)
  );

  if (actionable.length === 0) {
    return {
      task: null,
      reason: "No actionable tasks found (all tasks are in progress, done, or blocked)",
      blockedTasks: [],
    };
  }

  const task = actionable[0];

  // Find blocked tasks that would become unblocked after this one
  const blockedTasks = [];
  for (const [id, node] of filtered.nodes) {
    const blockers = filtered.edges.get(id) || new Set();
    if (blockers.has(task.identifier) && blockers.size === 1) {
      blockedTasks.push(node);
    }
  }

  return {
    task,
    reason: `Highest priority unblocked task`,
    blockedTasks,
  };
}

/**
 * Check if a specific issue is blocked and explain why.
 *
 * @param {{ nodes: Map, edges: Map }} graph
 * @param {string} identifier - Issue identifier (e.g., "DVA-14")
 * @returns {{ isBlocked: boolean, blockers: object[], transitive: object[], reason: string }}
 */
export function checkBlocked(graph, identifier) {
  const filtered = filterResolvedBlockers(graph);
  const node = filtered.nodes.get(identifier);

  if (!node) {
    return {
      isBlocked: false,
      blockers: [],
      transitive: [],
      reason: `Issue ${identifier} not found in the graph`,
    };
  }

  const directBlockers = [...(filtered.edges.get(identifier) || [])]
    .map((id) => filtered.nodes.get(id))
    .filter(Boolean);

  if (directBlockers.length === 0) {
    return {
      isBlocked: false,
      blockers: [],
      transitive: [],
      reason: `${identifier} is not blocked — ready to work on`,
    };
  }

  // Find transitive blockers (blockers of blockers)
  const visited = new Set();
  const transitive = [];

  function findTransitive(id) {
    if (visited.has(id)) return;
    visited.add(id);
    const blockers = filtered.edges.get(id) || new Set();
    for (const blockerId of blockers) {
      if (blockerId !== identifier && !directBlockers.find((b) => b.identifier === blockerId)) {
        const blocker = filtered.nodes.get(blockerId);
        if (blocker) transitive.push(blocker);
      }
      findTransitive(blockerId);
    }
  }

  for (const blocker of directBlockers) {
    findTransitive(blocker.identifier);
  }

  const blockerNames = directBlockers.map((b) => `${b.identifier} (${b.title})`).join(", ");
  return {
    isBlocked: true,
    blockers: directBlockers,
    transitive,
    reason: `${identifier} is blocked by: ${blockerNames}`,
  };
}

/**
 * Format the dependency graph as a visual string.
 *
 * @param {{ nodes: Map, edges: Map }} graph
 * @returns {string}
 */
export function formatGraph(graph) {
  const filtered = filterResolvedBlockers(graph);
  const { ordered, blocked, circular } = topologicalSort(filtered);
  const lines = [];

  lines.push("## Dependency Graph\n");

  if (circular.length > 0) {
    lines.push("### ⚠️ Circular Dependencies Detected\n");
    for (const cycle of circular) {
      lines.push(`  ${cycle.join(" → ")} → ${cycle[0]}`);
    }
    lines.push("");
  }

  lines.push("### Execution Order\n");
  lines.push("| # | Issue | Title | Priority | Status | Blocked By |");
  lines.push("|---|-------|-------|----------|--------|------------|");

  for (let i = 0; i < ordered.length; i++) {
    const node = ordered[i];
    const blockers = [...(filtered.edges.get(node.identifier) || [])].join(", ") || "—";
    const priorityLabel = ["None", "Urgent", "High", "Medium", "Low"][node.priority] || "None";
    lines.push(
      `| ${i + 1} | ${node.identifier} | ${node.title} | ${priorityLabel} | ${node.status} | ${blockers} |`
    );
  }

  if (blocked.length > 0) {
    lines.push("\n### ❌ Blocked (circular or unresolvable)\n");
    for (const node of blocked) {
      lines.push(`- ${node.identifier}: ${node.title}`);
    }
  }

  lines.push(`\n**Total:** ${ordered.length} orderable, ${blocked.length} blocked`);

  return lines.join("\n");
}

// --- Linear Data Fetching ---

/**
 * Fetch issues and their relations from Linear using the @linear/sdk.
 * Falls back gracefully if LINEAR_API_KEY is not set.
 *
 * @param {object} options - { team, project, label, includeInProgress }
 * @returns {{ issues: object[], relations: object[] }}
 */
export async function fetchFromLinear(options = {}) {
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) {
    throw new Error(
      "LINEAR_API_KEY not set. Use MCP tools or set the env var."
    );
  }

  // Dynamic import to avoid crash when @linear/sdk isn't installed
  const { LinearClient } = await import("@linear/sdk");
  const client = new LinearClient({ apiKey });

  // Build filter
  const filter = {};
  if (options.team) {
    const teams = await client.teams();
    const team = teams.nodes.find(
      (t) => t.key === options.team || t.name === options.team
    );
    if (team) filter.team = { id: { eq: team.id } };
  }
  if (options.project) {
    const projects = await client.projects();
    const project = projects.nodes.find(
      (p) => p.name === options.project || p.slugId === options.project
    );
    if (project) filter.project = { id: { eq: project.id } };
  }

  // Fetch issues
  const issuesResult = await client.issues({ filter, first: 100 });
  const issues = [];
  const relations = [];

  for (const issue of issuesResult.nodes) {
    const state = await issue.state;
    const priority = issue.priority ?? 0;

    issues.push({
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      priority: { value: priority },
      status: state?.name || "Unknown",
      url: issue.url,
    });

    // Fetch relations for this issue
    const issueRelations = await issue.relations();
    for (const rel of issueRelations.nodes) {
      const relatedIssue = await rel.relatedIssue;
      if (rel.type === "blocks") {
        relations.push({
          type: "blocks",
          sourceId: issue.id,
          targetId: relatedIssue.id,
        });
      } else if (rel.type === "blockedBy") {
        relations.push({
          type: "blockedBy",
          sourceId: issue.id,
          targetId: relatedIssue.id,
        });
      }
    }
  }

  return { issues, relations };
}

// --- CLI ---

function parseFlags(argv) {
  const flags = { command: "", args: [] };
  let i = 0;

  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--team") {
      flags.team = argv[++i];
    } else if (arg === "--project") {
      flags.project = argv[++i];
    } else if (arg === "--label") {
      flags.label = argv[++i];
    } else if (arg === "--json") {
      flags.json = true;
    } else if (arg === "--help" || arg === "-h") {
      flags.help = true;
    } else if (!flags.command) {
      flags.command = arg;
    } else {
      flags.args.push(arg);
    }
    i++;
  }

  return flags;
}

function printHelp() {
  console.log(`Usage: node scripts/task-ordering.mjs <command> [options]

Commands:
  next                Pick the next task to work on (highest priority, unblocked)
  order               Show all issues in recommended execution order
  check <issue-id>    Check if a specific issue is blocked and why
  graph               Display the full dependency graph

Options:
  --team <key>        Filter by team key (e.g., DVA)
  --project <name>    Filter by project name
  --label <name>      Filter by label
  --json              Output results as JSON
  --help              Show this help message

Examples:
  node scripts/task-ordering.mjs next --team DVA
  node scripts/task-ordering.mjs check DVA-18
  node scripts/task-ordering.mjs order --project "Agent Orchestration"
  node scripts/task-ordering.mjs graph --team DVA

Environment:
  LINEAR_API_KEY      Required for fetching issues from Linear (not needed for MCP tools)

The tool queries Linear for issues and their blocking relations, builds a
dependency graph, and recommends the optimal task execution order respecting
both dependencies and priority levels.`);
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const flags = parseFlags(process.argv.slice(2));

  if (flags.help) {
    printHelp();
    process.exit(0);
  }

  if (!flags.command) {
    printHelp();
    process.exit(1);
  }

  const validCommands = ["next", "order", "check", "graph"];
  if (!validCommands.includes(flags.command)) {
    console.error(`Unknown command: ${flags.command}`);
    printHelp();
    process.exit(1);
  }

  try {
    const { issues, relations } = await fetchFromLinear({
      team: flags.team,
      project: flags.project,
      label: flags.label,
    });

    const graph = buildGraph(issues, relations);

    switch (flags.command) {
      case "next": {
        const result = findNextTask(graph);
        if (flags.json) {
          console.log(JSON.stringify(result, null, 2));
        } else if (result.task) {
          console.log(`Next task: ${result.task.identifier} — ${result.task.title}`);
          console.log(`Priority: ${["None", "Urgent", "High", "Medium", "Low"][result.task.priority] || "None"}`);
          console.log(`Status: ${result.task.status}`);
          if (result.task.url) console.log(`URL: ${result.task.url}`);
          if (result.blockedTasks.length > 0) {
            console.log(`\nCompleting this will unblock:`);
            for (const t of result.blockedTasks) {
              console.log(`  ${t.identifier} — ${t.title}`);
            }
          }
        } else {
          console.log(result.reason);
        }
        break;
      }

      case "order": {
        const filtered = filterResolvedBlockers(graph);
        const { ordered, blocked, circular } = topologicalSort(filtered);
        if (flags.json) {
          console.log(JSON.stringify({ ordered, blocked, circular }, null, 2));
        } else {
          console.log(formatGraph(graph));
        }
        break;
      }

      case "check": {
        const issueId = flags.args[0];
        if (!issueId) {
          console.error("Error: Please specify an issue ID (e.g., DVA-14)");
          process.exit(1);
        }
        const result = checkBlocked(graph, issueId.toUpperCase());
        if (flags.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(result.reason);
          if (result.transitive.length > 0) {
            console.log(`\nTransitive blockers:`);
            for (const t of result.transitive) {
              console.log(`  ${t.identifier} — ${t.title} (${t.status})`);
            }
          }
        }
        break;
      }

      case "graph": {
        if (flags.json) {
          const filtered = filterResolvedBlockers(graph);
          const { ordered, blocked, circular } = topologicalSort(filtered);
          console.log(JSON.stringify({
            nodes: [...graph.nodes.values()],
            edges: Object.fromEntries(
              [...graph.edges].map(([k, v]) => [k, [...v]])
            ),
            ordered: ordered.map((n) => n.identifier),
            blocked: blocked.map((n) => n.identifier),
            circular,
          }, null, 2));
        } else {
          console.log(formatGraph(graph));
        }
        break;
      }

      default:
        // Unreachable due to validation above, but kept for safety
        break;
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}
