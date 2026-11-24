// What an agent starts with: the command, the skill, and the first message. The settings live in
// linear-queues-settings.json. No Herdr imports, so `node --test` can load this file.

const LOCAL_NOTE = "The mod already made your worktree, and this terminal starts in it. The repo is the queue's guess. If the work belongs in another repo, make a worktree for the issue's branch in that repo and work there.";
// The start-issue skill sets up worktrees with box, which the instance does not need.
const CLOUD_NOTE = "You run on a cloud agent instance that holds only this issue. The mod checked out the issue's branch in the repo's main checkout, and this terminal starts in it. Do not make a worktree, and do not run `box worktree setup` or `box worktree server`: this checkout is already set up. The repo is the queue's guess. If the work belongs in another repo, every repo is checked out in ~/Code on this instance: check out the issue's branch in that repo's folder and work there.";

// After a move to another host or repo, the new agent gets this. {{from}} says where the work was.
const HANDOFF_NOTE = "Another agent already worked on this issue, on {{from}}. Its work is pushed on the issue's branch. Before you change anything, read the branch's commits and any pull request for it, then continue the work.";

export const PLACEHOLDERS = [
  ["{{skill}}", "the skill's command, for example /start-issue CAL-123; empty with no skill"],
  ["{{location}}", "the local note or the cloud note"],
  ["{{handoff}}", "after a move: the handoff note; empty otherwise"],
  ["{{issue}}", "the ID, title, branch, milestone, description and comments"],
  ["{{id}}", "the issue ID"], ["{{title}}", "the title"], ["{{branch}}", "the branch name"], ["{{url}}", "the link to the issue"],
];

export const DEFAULT_PROMPTS = {
  command: "claude",
  skill: "start-issue",
  comments: 10,
  template: "{{skill}}\n\n{{location}} The issue is below, so do not get it from Linear.\n\n{{handoff}}\n\n{{issue}}",
  localNote: LOCAL_NOTE,
  cloudNote: CLOUD_NOTE,
  handoffNote: HANDOFF_NOTE,
  // Any prompt on a new instance stops the agent and loses its first message. Onboarding asks about
  // trust even for a trusted folder.
  cloudSetup: { approveMcpServers: true, skipOnboarding: true, trustFolder: true },
};

export const MAX_COMMENTS = 50;

// A skill is a folder under ~/.claude/skills, so its name must be safe as one path part.
export const isSkillName = (name) => typeof name === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name);

const text = (v, fallback) => (typeof v === "string" && v.trim() ? v : fallback);

// The prompt settings in linear-queues-settings.json, with defaults for what is missing or bad. "skill": ""
// means no skill.
export function parsePrompts(raw = {}) {
  const setup = raw.cloudSetup ?? {};
  return {
    command: text(raw.agentCommand, DEFAULT_PROMPTS.command).trim(),
    skill: raw.skill === "" ? "" : isSkillName(raw.skill) ? raw.skill : DEFAULT_PROMPTS.skill,
    comments: Number.isInteger(raw.comments) ? Math.min(MAX_COMMENTS, Math.max(0, raw.comments)) : DEFAULT_PROMPTS.comments,
    template: text(raw.firstMessage?.template, DEFAULT_PROMPTS.template),
    localNote: text(raw.firstMessage?.localNote, DEFAULT_PROMPTS.localNote),
    cloudNote: text(raw.firstMessage?.cloudNote, DEFAULT_PROMPTS.cloudNote),
    handoffNote: text(raw.firstMessage?.handoffNote, DEFAULT_PROMPTS.handoffNote),
    cloudSetup: Object.fromEntries(Object.entries(DEFAULT_PROMPTS.cloudSetup).map(([k, d]) => [k, typeof setup[k] === "boolean" ? setup[k] : d])),
  };
}

// The same settings as linear-queues-settings.json keys, to merge into the file.
export function promptsToConfig(p) {
  return {
    agentCommand: p.command, skill: p.skill, comments: p.comments,
    firstMessage: { template: p.template, localNote: p.localNote, cloudNote: p.cloudNote, handoffNote: p.handoffNote }, cloudSetup: { ...p.cloudSetup },
  };
}

// Splits a command line into words. Quotes keep spaces in a word; there is no other shell syntax.
export function parseCommand(line) {
  const words = [];
  let word = null, quote = null;
  for (const ch of String(line ?? "")) {
    if (quote) { if (ch === quote) quote = null; else word += ch; }
    else if (ch === '"' || ch === "'") { quote = ch; word ??= ""; }
    else if (/\s/.test(ch)) { if (word !== null) words.push(word); word = null; }
    else word = (word ?? "") + ch;
  }
  if (quote) throw new Error(`the command has an open ${quote} quote`);
  if (word !== null) words.push(word);
  if (!words.length) throw new Error("the agent command is empty");
  return words;
}

function issueBlock(issue, comments) {
  const all = issue.comments ?? [], shown = all.slice(0, comments), more = all.length - shown.length;
  const lines = [`# ${issue.identifier}: ${issue.title}`, `Branch: ${issue.branchName ?? "none"}`];
  if (issue.milestone) lines.push(`Milestone: ${issue.milestone.name}`);
  lines.push("", issue.description?.trim() || "No description.");
  if (shown.length) {
    lines.push("", "## Comments, newest first");
    for (const c of shown) lines.push("", `${c.author}, ${c.createdAt.slice(0, 10)}:`, c.body.trim());
  }
  if (more > 0) lines.push("", `${more} older comments are in Linear. Read them only if you need them.`);
  return lines.join("\n");
}

// The agent's first message. An empty placeholder can leave blank lines, so runs of them become one.
// `from` is set after a move, for example "a cloud instance, in calendar". A template with no
// {{handoff}} gets the note at its end.
export function startTask(issue, prompts = DEFAULT_PROMPTS, { cloud = false, from = null } = {}) {
  const handoff = from ? prompts.handoffNote.replaceAll("{{from}}", from) : "";
  const template = handoff && !prompts.template.includes("{{handoff}}") ? `${prompts.template}\n\n{{handoff}}` : prompts.template;
  const values = {
    "{{handoff}}": handoff,
    "{{skill}}": prompts.skill ? `/${prompts.skill} ${issue.identifier}` : "",
    "{{location}}": cloud ? prompts.cloudNote : prompts.localNote,
    "{{issue}}": issueBlock(issue, prompts.comments),
    "{{id}}": issue.identifier, "{{title}}": issue.title, "{{branch}}": issue.branchName ?? "", "{{url}}": issue.url ?? "",
  };
  return template.replace(/\{\{[a-z]+\}\}/g, (m) => (m in values ? values[m] : m))
    .replace(/\n{3,}/g, "\n\n").trim();
}
