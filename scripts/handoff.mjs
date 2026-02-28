/**
 * Handoff document utility for agent session continuity.
 *
 * Manages handoff documents that capture session state when an agent
 * cannot complete a task, enabling the next agent to resume seamlessly.
 *
 * Usage:
 *   node scripts/handoff.mjs read  <issue-id>            Read existing handoff
 *   node scripts/handoff.mjs write <issue-id> <file>      Store a handoff from file
 *   node scripts/handoff.mjs check <issue-id>             Check if a handoff exists
 *   node scripts/handoff.mjs list                         List all handoffs
 *   node scripts/handoff.mjs clean <issue-id>             Remove handoff after completion
 *   node scripts/handoff.mjs template                     Print the handoff template
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..");
const HANDOFFS_DIR = join(PROJECT_ROOT, ".claude", "handoffs");
const TEMPLATE_PATH = join(PROJECT_ROOT, ".claude", "handoff-template.md");

// --- Helpers ---

function ensureHandoffsDir() {
  mkdirSync(HANDOFFS_DIR, { recursive: true });
}

function handoffPath(issueId) {
  // Normalize: "DVA-9" -> "DVA-9.md"
  const normalized = issueId.toUpperCase().replace(/[^A-Z0-9-]/g, "");
  return join(HANDOFFS_DIR, `${normalized}.md`);
}

function handoffExists(issueId) {
  return existsSync(handoffPath(issueId));
}

// --- Commands ---

function readHandoff(issueId) {
  const path = handoffPath(issueId);
  if (!existsSync(path)) {
    console.log(`No handoff found for ${issueId.toUpperCase()}`);
    process.exit(0);
  }
  const content = readFileSync(path, "utf-8");
  console.log(content);
}

function writeHandoff(issueId, sourcePath) {
  ensureHandoffsDir();
  const content = readFileSync(sourcePath, "utf-8");
  const dest = handoffPath(issueId);
  writeFileSync(dest, content, "utf-8");
  console.log(`Handoff written: ${dest}`);
}

function checkHandoff(issueId) {
  if (handoffExists(issueId)) {
    console.log(`HANDOFF_EXISTS: ${handoffPath(issueId)}`);
    process.exit(0);
  } else {
    console.log(`NO_HANDOFF: ${issueId.toUpperCase()}`);
    process.exit(0);
  }
}

function listHandoffs() {
  ensureHandoffsDir();
  const files = readdirSync(HANDOFFS_DIR).filter((f) => f.endsWith(".md"));
  if (files.length === 0) {
    console.log("No handoffs found.");
    return;
  }
  console.log("Active handoffs:");
  for (const file of files) {
    const issueId = file.replace(".md", "");
    console.log(`  ${issueId} -> .claude/handoffs/${file}`);
  }
}

function cleanHandoff(issueId) {
  const path = handoffPath(issueId);
  if (!existsSync(path)) {
    console.log(`No handoff to clean for ${issueId.toUpperCase()}`);
    return;
  }
  unlinkSync(path);
  console.log(`Handoff removed: ${issueId.toUpperCase()}`);
}

function printTemplate() {
  if (!existsSync(TEMPLATE_PATH)) {
    console.error("Template not found at .claude/handoff-template.md");
    process.exit(1);
  }
  const content = readFileSync(TEMPLATE_PATH, "utf-8");
  console.log(content);
}

// --- CLI ---

const [command, ...args] = process.argv.slice(2);

const commands = {
  read: () => readHandoff(args[0]),
  write: () => writeHandoff(args[0], args[1]),
  check: () => checkHandoff(args[0]),
  list: () => listHandoffs(),
  clean: () => cleanHandoff(args[0]),
  template: () => printTemplate(),
};

if (!command || !commands[command]) {
  console.log(`Usage: node scripts/handoff.mjs <command> [args]

Commands:
  read  <issue-id>          Read an existing handoff document
  write <issue-id> <file>   Store a handoff from a file
  check <issue-id>          Check if a handoff exists for an issue
  list                      List all active handoffs
  clean <issue-id>          Remove a handoff after task completion
  template                  Print the handoff template

Examples:
  node scripts/handoff.mjs check DVA-9
  node scripts/handoff.mjs read DVA-9
  node scripts/handoff.mjs list
  node scripts/handoff.mjs clean DVA-9
  node scripts/handoff.mjs template

Handoff files are stored in .claude/handoffs/<ISSUE-ID>.md`);
  process.exit(command ? 1 : 0);
}

try {
  commands[command]();
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
