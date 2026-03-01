/**
 * Auto-triage incoming issues — scans Linear Backlog for issues lacking
 * size/complexity labels and applies size estimates, clarity flags, and
 * priority suggestions.
 *
 * Usage:
 *   node scripts/auto-triage.mjs scan    [--team DVA] [--dry-run] [--json]
 *   node scripts/auto-triage.mjs triage  [--team DVA] [--dry-run]
 *   node scripts/auto-triage.mjs --help
 *
 * Commands:
 *   scan     Analyze Backlog issues and print triage recommendations
 *   triage   Analyze and apply labels + post comments (needs LINEAR_API_KEY)
 *
 * Options:
 *   --team <key>   Linear team key (default: DVA)
 *   --dry-run      Show what would change without applying
 *   --json         Output analysis as JSON
 */

import { pathToFileURL } from "node:url";

// --- Size thresholds ---

/** Lines-of-change thresholds for size labels */
export const SIZE_THRESHOLDS = {
  small: 50,   // < 50 LOC
  medium: 200, // 50-200 LOC
  // > 200 LOC = large
};

export const SIZE_LABELS = ["size:small", "size:medium", "size:large"];
export const NEEDS_CLARIFICATION_LABEL = "needs-clarification";

// --- Complexity signal keywords ---

/**
 * Keywords and their estimated LOC impact.
 * Higher weight = more complex.
 */
const COMPLEXITY_SIGNALS = [
  // Scope amplifiers — suggest broad changes
  { pattern: /\bacross all\b/i, weight: 80, reason: "broad scope (across all)" },
  { pattern: /\bevery (file|component|page|module|service)\b/i, weight: 80, reason: "broad scope (every X)" },
  { pattern: /\brefactor\b/i, weight: 60, reason: "refactoring" },
  { pattern: /\brewrite\b/i, weight: 100, reason: "rewrite" },
  { pattern: /\bmigrat(e|ion)\b/i, weight: 80, reason: "migration" },

  // Architecture — typically medium-large
  { pattern: /\bAPI\s*(endpoint|route|integration)\b/i, weight: 40, reason: "API work" },
  { pattern: /\bdatabase\s*(schema|migration|model)\b/i, weight: 60, reason: "database changes" },
  { pattern: /\bauthentication\b/i, weight: 50, reason: "authentication" },
  { pattern: /\bauthorization\b/i, weight: 40, reason: "authorization" },
  { pattern: /\bCI\s*\/?\s*CD\b/i, weight: 30, reason: "CI/CD pipeline" },
  { pattern: /\binfrastructure\b/i, weight: 50, reason: "infrastructure" },
  { pattern: /\bdeployment\b/i, weight: 30, reason: "deployment" },

  // Testing signals
  { pattern: /\bunit test/i, weight: 20, reason: "unit tests needed" },
  { pattern: /\bintegration test/i, weight: 35, reason: "integration tests needed" },
  { pattern: /\be2e test/i, weight: 50, reason: "end-to-end tests needed" },
  { pattern: /\btest coverage\b/i, weight: 30, reason: "test coverage work" },

  // Feature complexity
  { pattern: /\breal-?time\b/i, weight: 50, reason: "real-time feature" },
  { pattern: /\bwebsocket/i, weight: 50, reason: "WebSocket integration" },
  { pattern: /\bcaching\b/i, weight: 30, reason: "caching layer" },
  { pattern: /\bqueue\b/i, weight: 40, reason: "queue system" },
  { pattern: /\bscheduled?\s*(task|job|cron)\b/i, weight: 30, reason: "scheduled job" },

  // Simple tasks
  { pattern: /\btypo\b/i, weight: -20, reason: "typo fix (simple)" },
  { pattern: /\bREADME\b/i, weight: -10, reason: "documentation (simpler)" },
  { pattern: /\bdocs?\s*(update|change|fix)\b/i, weight: -10, reason: "doc update (simpler)" },
  { pattern: /\brename\b/i, weight: 10, reason: "rename operation" },
  { pattern: /\bconfig(uration)?\s*(change|update)\b/i, weight: 10, reason: "config change (simpler)" },
];

/**
 * Keywords that suggest issue type for priority recommendations.
 */
const TYPE_SIGNALS = {
  bug: [
    /\bbug\b/i, /\bfix\b/i, /\bbroken\b/i, /\bcrash(es|ing)?\b/i,
    /\berror\b/i, /\bfail(s|ing|ure)?\b/i, /\bregression\b/i,
    /\bnot working\b/i, /\bdoesn'?t work\b/i,
  ],
  feature: [
    /\bfeature\b/i, /\badd(ing)?\b/i, /\bimplement/i, /\bbuild\b/i,
    /\bcreate\b/i, /\bnew\b/i, /\bintroduce\b/i, /\bsupport\s+for\b/i,
  ],
  chore: [
    /\bchore\b/i, /\bcleanup\b/i, /\brefactor\b/i, /\bmaintenance\b/i,
    /\bupgrade\b/i, /\bdependenc(y|ies)\b/i, /\btechnical debt\b/i,
  ],
};

// --- Pure Analysis Functions ---

/**
 * Estimate the size/complexity of an issue from its text content.
 * Returns a size label and the reasoning.
 *
 * @param {string} title - Issue title
 * @param {string} description - Issue description (Markdown)
 * @returns {{ size: "small"|"medium"|"large", estimatedLOC: number, signals: string[] }}
 */
export function estimateSize(title, description) {
  const text = `${title}\n${description || ""}`;
  let estimatedLOC = 30; // base estimate for any task
  const signals = [];

  // Check complexity keywords
  for (const signal of COMPLEXITY_SIGNALS) {
    if (signal.pattern.test(text)) {
      estimatedLOC += signal.weight;
      signals.push(signal.reason);
    }
  }

  // Count requirement bullet points as a scope indicator
  const bulletCount = (description || "").split("\n")
    .filter((line) => /^\s*[-*]\s+\S/.test(line) || /^\s*\d+\.\s+\S/.test(line))
    .length;
  if (bulletCount > 0) {
    // Each bullet ≈ 15 LOC of implementation
    const bulletLOC = bulletCount * 15;
    estimatedLOC += bulletLOC;
    signals.push(`${bulletCount} requirement bullet(s)`);
  }

  // Count acceptance criteria checkboxes
  const checkboxCount = (description || "").split("\n")
    .filter((line) => /^\s*-\s*\[[ x]\]/i.test(line))
    .length;
  if (checkboxCount > 0) {
    const checkboxLOC = checkboxCount * 10;
    estimatedLOC += checkboxLOC;
    signals.push(`${checkboxCount} acceptance criteria`);
  }

  // Description length as a minor signal
  const descLength = (description || "").length;
  if (descLength > 1000) {
    estimatedLOC += 20;
    signals.push("long description (>1000 chars)");
  } else if (descLength < 100 && descLength > 0) {
    estimatedLOC -= 10;
    signals.push("short description (<100 chars)");
  }

  // Clamp to minimum of 5
  estimatedLOC = Math.max(5, estimatedLOC);

  // Determine size label
  let size;
  if (estimatedLOC < SIZE_THRESHOLDS.small) {
    size = "small";
  } else if (estimatedLOC <= SIZE_THRESHOLDS.medium) {
    size = "medium";
  } else {
    size = "large";
  }

  return { size, estimatedLOC, signals };
}

/**
 * Check if an issue needs clarification.
 * Returns true if the issue lacks critical information.
 *
 * @param {string} title - Issue title
 * @param {string} description - Issue description
 * @returns {{ needsClarification: boolean, questions: string[] }}
 */
export function checkClarity(title, description) {
  const questions = [];

  // No description at all
  if (!description || description.trim().length === 0) {
    questions.push("This issue has no description. Could you add details about what needs to be done?");
  }

  // Very short description (less than 30 chars)
  if (description && description.trim().length > 0 && description.trim().length < 30) {
    questions.push("The description is very brief. Could you provide more context about the expected behavior or requirements?");
  }

  // No acceptance criteria or requirements section
  if (description && description.length >= 30) {
    const hasAcceptanceCriteria = /acceptance\s*criteria|requirements?|expected\s*behavio/i.test(description);
    const hasBullets = /^\s*[-*]\s+\S/m.test(description) || /^\s*\d+\.\s+\S/m.test(description);
    const hasCheckboxes = /^\s*-\s*\[[ x]\]/im.test(description);

    if (!hasAcceptanceCriteria && !hasBullets && !hasCheckboxes) {
      questions.push("No acceptance criteria or requirements found. Could you add specific criteria for when this task is complete?");
    }
  }

  // Title is too vague (less than 10 chars or generic)
  const vaguePatterns = [
    /^fix\s*$/i, /^update\s*$/i, /^change\s*$/i, /^bug\s*$/i,
    /^todo\s*$/i, /^task\s*$/i, /^issue\s*$/i,
  ];
  if (title.length < 10 || vaguePatterns.some((p) => p.test(title.trim()))) {
    questions.push("The title is quite short/vague. Could you make it more descriptive to clarify what needs to change?");
  }

  return {
    needsClarification: questions.length > 0,
    questions,
  };
}

/**
 * Suggest a priority based on issue type signals.
 * Returns a suggested priority and reasoning, or null if no suggestion.
 *
 * Linear priorities: 0=None, 1=Urgent, 2=High, 3=Normal, 4=Low
 *
 * @param {string} title - Issue title
 * @param {string} description - Issue description
 * @param {string[]} labels - Existing label names
 * @param {number} currentPriority - Current priority value (0-4)
 * @returns {{ suggestedPriority: number, reason: string }|null}
 */
export function suggestPriority(title, description, labels, currentPriority) {
  const text = `${title}\n${description || ""}`;
  const labelText = labels.join(" ").toLowerCase();

  // Detect issue type
  let detectedType = null;
  let typeScore = 0;

  for (const [type, patterns] of Object.entries(TYPE_SIGNALS)) {
    let matches = 0;
    for (const pattern of patterns) {
      if (pattern.test(text) || pattern.test(labelText)) {
        matches++;
      }
    }
    if (matches > typeScore) {
      typeScore = matches;
      detectedType = type;
    }
  }

  if (!detectedType) return null;

  // Map type to suggested priority
  const typePriority = {
    bug: 2,     // High
    feature: 3, // Normal
    chore: 4,   // Low
  };

  const suggestedPriority = typePriority[detectedType];

  // Only suggest if current priority is "None" (unset)
  if (currentPriority !== 0) return null;

  const priorityNames = { 1: "Urgent", 2: "High", 3: "Normal", 4: "Low" };
  return {
    suggestedPriority,
    reason: `Detected as ${detectedType} (${typeScore} signal${typeScore > 1 ? "s" : ""}). Suggesting ${priorityNames[suggestedPriority]} priority.`,
  };
}

/**
 * Run full triage analysis on a single issue.
 *
 * @param {object} issue - { identifier, title, description, labels, priority }
 * @returns {object} Triage result with size, clarity, and priority suggestions
 */
export function analyzeIssue(issue) {
  const sizeResult = estimateSize(issue.title, issue.description);
  const clarityResult = checkClarity(issue.title, issue.description);
  const priorityResult = suggestPriority(
    issue.title,
    issue.description,
    issue.labels || [],
    issue.priority ?? 0,
  );

  return {
    identifier: issue.identifier,
    title: issue.title,
    size: sizeResult,
    clarity: clarityResult,
    priority: priorityResult,
    labelsToAdd: [
      `size:${sizeResult.size}`,
      ...(clarityResult.needsClarification ? [NEEDS_CLARIFICATION_LABEL] : []),
    ],
  };
}

/**
 * Check if an issue has already been triaged (has any size label).
 *
 * @param {string[]} labels - Array of label names on the issue
 * @returns {boolean}
 */
export function isAlreadyTriaged(labels) {
  return labels.some((l) => SIZE_LABELS.includes(l));
}

/**
 * Build the triage comment body for an issue.
 *
 * @param {object} analysis - Result from analyzeIssue()
 * @returns {string} Markdown comment body
 */
export function buildTriageComment(analysis) {
  const lines = [];
  lines.push(`## Auto-Triage Results`);
  lines.push(``);
  lines.push(`**Size estimate:** \`${analysis.size.size}\` (~${analysis.size.estimatedLOC} lines of change)`);

  if (analysis.size.signals.length > 0) {
    lines.push(``);
    lines.push(`**Complexity signals detected:**`);
    for (const signal of analysis.size.signals) {
      lines.push(`- ${signal}`);
    }
  }

  if (analysis.priority) {
    lines.push(``);
    lines.push(`**Priority suggestion:** ${analysis.priority.reason}`);
  }

  if (analysis.clarity.needsClarification) {
    lines.push(``);
    lines.push(`**Needs clarification:**`);
    for (const q of analysis.clarity.questions) {
      lines.push(`- ${q}`);
    }
  }

  lines.push(``);
  lines.push(`---`);
  lines.push(`_Auto-triaged by \`scripts/auto-triage.mjs\`_`);

  return lines.join("\n");
}

// --- Linear Integration ---

/**
 * Fetch Backlog issues from Linear that haven't been triaged yet.
 * Uses the @linear/sdk for direct API access.
 *
 * @param {string} teamKey - Team key (e.g., "DVA")
 * @returns {Promise<{ issues: object[], labelMap: Map<string, string> }>}
 */
async function fetchBacklogIssues(teamKey) {
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) {
    throw new Error(
      "LINEAR_API_KEY not set. Set the env var to use auto-triage.",
    );
  }

  const { LinearClient } = await import("@linear/sdk");
  const client = new LinearClient({ apiKey });

  // Find team
  const teams = await client.teams();
  const team = teams.nodes.find((t) => t.key === teamKey);
  if (!team) throw new Error(`Team ${teamKey} not found`);

  // Get backlog state
  const states = await team.states();
  const backlog = states.nodes.find(
    (s) => s.name.toLowerCase() === "backlog",
  );
  if (!backlog) throw new Error("No Backlog state found");

  // Fetch backlog issues
  const issuesResult = await client.issues({
    filter: {
      team: { id: { eq: team.id } },
      state: { id: { eq: backlog.id } },
    },
    first: 100,
  });

  // Build label lookup
  const allLabels = await client.issueLabels();
  const labelMap = new Map();
  for (const label of allLabels.nodes) {
    labelMap.set(label.name, label.id);
  }

  // Normalize issues
  const issues = [];
  for (const issue of issuesResult.nodes) {
    const labels = await issue.labels();
    const labelNames = labels.nodes.map((l) => l.name);

    issues.push({
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description || "",
      labels: labelNames,
      priority: issue.priority ?? 0,
    });
  }

  return { issues, labelMap, client };
}

/**
 * Check if a triage comment already exists on the issue.
 */
async function hasTriageComment(client, issueId) {
  const issue = await client.issue(issueId);
  const comments = await issue.comments();
  return comments.nodes.some(
    (c) => c.body && c.body.includes("Auto-Triage Results"),
  );
}

/**
 * Apply triage results to an issue in Linear.
 */
async function applyTriage(client, issueId, analysis, labelMap) {
  const actions = [];

  // Add labels that don't already exist on the issue
  const labelIdsToAdd = [];
  for (const labelName of analysis.labelsToAdd) {
    const labelId = labelMap.get(labelName);
    if (labelId) {
      labelIdsToAdd.push(labelId);
    }
  }

  if (labelIdsToAdd.length > 0) {
    // Get current labels first to preserve them
    const issue = await client.issue(issueId);
    const currentLabels = await issue.labels();
    const currentLabelIds = currentLabels.nodes.map((l) => l.id);
    const mergedIds = [...new Set([...currentLabelIds, ...labelIdsToAdd])];

    await issue.update({ labelIds: mergedIds });
    actions.push(`Added labels: ${analysis.labelsToAdd.join(", ")}`);
  }

  // Post triage comment if one doesn't already exist
  const alreadyCommented = await hasTriageComment(client, issueId);
  if (!alreadyCommented) {
    const commentBody = buildTriageComment(analysis);
    await client.createComment({ issueId, body: commentBody });
    actions.push("Posted triage comment");
  } else {
    actions.push("Skipped comment (already exists)");
  }

  return actions;
}

// --- CLI ---

function parseFlags(argv) {
  const flags = { command: "", team: "DVA", dryRun: false, json: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--team" && argv[i + 1]) {
      flags.team = argv[++i];
    } else if (arg === "--dry-run") {
      flags.dryRun = true;
    } else if (arg === "--json") {
      flags.json = true;
    } else if (arg === "--help" || arg === "-h") {
      flags.command = "help";
    } else if (!flags.command || flags.command === "") {
      flags.command = arg;
    }
  }

  return flags;
}

function printHelp() {
  console.log(`Usage: node scripts/auto-triage.mjs <command> [options]

Commands:
  scan     Analyze Backlog issues and print triage recommendations
  triage   Analyze and apply labels + post comments to Linear

Options:
  --team <key>   Linear team key (default: DVA)
  --dry-run      Show what would change without applying
  --json         Output analysis as JSON (scan only)
  --help         Show this help message

Examples:
  node scripts/auto-triage.mjs scan                    # Preview triage results
  node scripts/auto-triage.mjs scan --json             # JSON output
  node scripts/auto-triage.mjs triage --dry-run        # Preview changes
  node scripts/auto-triage.mjs triage                  # Apply triage labels + comments

Size Labels:
  size:small     < 50 estimated lines of change
  size:medium    50-200 estimated lines of change
  size:large     > 200 estimated lines of change

Environment:
  LINEAR_API_KEY    Required for fetching issues from Linear`);
}

function printAnalysis(results) {
  if (results.length === 0) {
    console.log("No untriaged Backlog issues found.");
    return;
  }

  console.log(`Found ${results.length} issue(s) to triage:\n`);

  for (const r of results) {
    const sizeIcon = { small: "\u{1F7E2}", medium: "\u{1F7E1}", large: "\u{1F534}" }[r.size.size];
    console.log(`${sizeIcon} ${r.identifier}: ${r.title}`);
    console.log(`  Size: ${r.size.size} (~${r.size.estimatedLOC} LOC)`);

    if (r.size.signals.length > 0) {
      console.log(`  Signals: ${r.size.signals.join(", ")}`);
    }

    if (r.priority) {
      console.log(`  Priority: ${r.priority.reason}`);
    }

    if (r.clarity.needsClarification) {
      console.log(`  Needs clarification:`);
      for (const q of r.clarity.questions) {
        console.log(`    - ${q}`);
      }
    }

    console.log(`  Labels to add: ${r.labelsToAdd.join(", ")}`);
    console.log();
  }
}

// --- Main ---

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const flags = parseFlags(process.argv.slice(2));

  if (flags.command === "help" || !flags.command) {
    printHelp();
    process.exit(flags.command ? 0 : 1);
  }

  const validCommands = ["scan", "triage"];
  if (!validCommands.includes(flags.command)) {
    console.error(`Unknown command: ${flags.command}`);
    printHelp();
    process.exit(1);
  }

  try {
    const { issues, labelMap, client } = await fetchBacklogIssues(flags.team);

    // Filter to untriaged issues only
    const untriaged = issues.filter((issue) => !isAlreadyTriaged(issue.labels));

    if (untriaged.length === 0) {
      console.log("All Backlog issues already have size labels. Nothing to triage.");
      process.exit(0);
    }

    // Analyze all untriaged issues
    const results = untriaged.map((issue) => analyzeIssue(issue));

    if (flags.command === "scan") {
      if (flags.json) {
        console.log(JSON.stringify(results, null, 2));
      } else {
        printAnalysis(results);
      }
    } else if (flags.command === "triage") {
      if (flags.dryRun) {
        console.log("[DRY RUN] Would apply the following changes:\n");
        printAnalysis(results);
        console.log("Run without --dry-run to apply these changes.");
      } else {
        console.log(`Triaging ${results.length} issue(s)...\n`);
        for (const analysis of results) {
          const issueObj = untriaged.find(
            (i) => i.identifier === analysis.identifier,
          );
          try {
            const actions = await applyTriage(
              client,
              issueObj.id,
              analysis,
              labelMap,
            );
            console.log(`  ${analysis.identifier}: ${actions.join("; ")}`);
          } catch (err) {
            console.error(
              `  ${analysis.identifier}: Error — ${err.message}`,
            );
          }
        }
        console.log("\nTriage complete.");
      }
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}
