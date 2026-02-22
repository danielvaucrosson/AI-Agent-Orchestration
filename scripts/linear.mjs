import { LinearClient } from "@linear/sdk";

const client = new LinearClient({ apiKey: process.env.LINEAR_API_KEY });

// --- Helpers ---

async function getTeam(teamKey) {
  const teams = await client.teams();
  const team = teamKey
    ? teams.nodes.find((t) => t.key === teamKey)
    : teams.nodes[0];
  if (!team) throw new Error(`Team not found${teamKey ? `: ${teamKey}` : ""}`);
  return team;
}

async function getWorkflowState(team, stateName) {
  const states = await team.states();
  const state = states.nodes.find(
    (s) => s.name.toLowerCase() === stateName.toLowerCase()
  );
  if (!state) {
    const available = states.nodes.map((s) => s.name).join(", ");
    throw new Error(
      `State "${stateName}" not found. Available: ${available}`
    );
  }
  return state;
}

async function findIssue(identifier) {
  const issue = await client.issue(identifier);
  if (!issue) throw new Error(`Issue not found: ${identifier}`);
  return issue;
}

// --- Actions ---

async function updateStatus(issueId, stateName, teamKey) {
  const team = await getTeam(teamKey);
  const state = await getWorkflowState(team, stateName);
  const issue = await findIssue(issueId);
  await issue.update({ stateId: state.id });
  console.log(`Updated ${issueId} -> ${stateName}`);
}

async function addComment(issueId, body) {
  const issue = await findIssue(issueId);
  await client.createComment({ issueId: issue.id, body });
  console.log(`Comment added to ${issueId}`);
}

async function linkPR(issueId, prUrl) {
  const issue = await findIssue(issueId);
  await issue.update({});
  await client.createComment({
    issueId: issue.id,
    body: `PR opened: ${prUrl}`,
  });
  await client.attachmentCreate({
    issueId: issue.id,
    title: "Pull Request",
    url: prUrl,
  });
  console.log(`PR linked to ${issueId}: ${prUrl}`);
}

async function listStates(teamKey) {
  const team = await getTeam(teamKey);
  const states = await team.states();
  console.log(`Workflow states for ${team.name} (${team.key}):`);
  for (const s of states.nodes) {
    console.log(`  ${s.name} (${s.type})`);
  }
}

async function testConnection() {
  const me = await client.viewer;
  console.log(`Connected as: ${me.name} (${me.email})`);
  const teams = await client.teams();
  for (const team of teams.nodes) {
    console.log(`\nTeam: ${team.name} (${team.key})`);
    await listStates(team.key);
  }
}

// --- CLI ---

const [command, ...args] = process.argv.slice(2);

const commands = {
  test: () => testConnection(),
  status: () => updateStatus(args[0], args[1], args[2]),
  comment: () => addComment(args[0], args.slice(1).join(" ")),
  "link-pr": () => linkPR(args[0], args[1]),
  states: () => listStates(args[0]),
};

if (!command || !commands[command]) {
  console.log(`Usage: node scripts/linear.mjs <command> [args]

Commands:
  test                          Test API connection and list teams/states
  status  <issue> <state>       Update issue status (e.g., "In Progress")
  comment <issue> <text>        Add a comment to an issue
  link-pr <issue> <pr-url>      Attach a PR link to an issue
  states  [team-key]            List workflow states for a team

Examples:
  node scripts/linear.mjs test
  node scripts/linear.mjs status TES-1 "In Progress"
  node scripts/linear.mjs comment TES-1 "Agent starting work on this task"
  node scripts/linear.mjs link-pr TES-1 https://github.com/user/repo/pull/1
  node scripts/linear.mjs states TES

Environment:
  LINEAR_API_KEY    Your Linear personal API key (required)`);
  process.exit(command ? 1 : 0);
}

try {
  await commands[command]();
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
