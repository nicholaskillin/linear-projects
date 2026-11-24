import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PROMPTS, parsePrompts, promptsToConfig, parseCommand, startTask } from "./prompts.js";

const issue = {
  identifier: "CAL-1", title: "Fix", branchName: "b", url: "https://linear.app/x/CAL-1", description: "Do it", milestone: null,
  comments: [1, 2, 3].map((n) => ({ author: `A${n}`, createdAt: `2026-11-0${n}T00:00:00Z`, body: `Comment ${n}` })),
};
const defaults = DEFAULT_PROMPTS;

test("the default first message runs the skill and carries the issue", () => {
  const text = startTask(issue, defaults);
  assert.match(text, /^\/start-issue CAL-1\n\nThe mod already made your worktree/);
  assert.match(text, /# CAL-1: Fix\nBranch: b\n\nDo it/);
  assert.match(text, /A1, 2026-11-01:\nComment 1/);
  assert.doesNotMatch(text, /older comments/);
});

test("a cloud start uses the cloud note", () => {
  const text = startTask(issue, defaults, { cloud: true });
  assert.match(text, /Do not make a worktree/);
  assert.match(text, /every repo is checked out in ~\/Code/);
  assert.doesNotMatch(text, /made your worktree/);
});

test("settings change the skill, the comments, the template and the notes", () => {
  const prompts = parsePrompts({ skill: "", comments: 1, firstMessage: { template: "{{location}}\n\n{{skill}}\n\nWork on {{id}} ({{url}}).\n\n{{issue}}\n\nAdd a regression test.", localNote: "Local." } });
  const text = startTask(issue, prompts);
  assert.equal(text.split("\n\n")[0], "Local.", "no skill leaves no blank line");
  assert.match(text, /Work on CAL-1 \(https:\/\/linear.app\/x\/CAL-1\)\./);
  assert.match(text, /Comment 1/);
  assert.doesNotMatch(text, /Comment 2/);
  assert.match(text, /2 older comments are in Linear/);
  assert.match(text, /Add a regression test\.$/);
});

test("after a move, the first message says where the work was", () => {
  const text = startTask(issue, defaults, { from: "a cloud instance, in calendar" });
  assert.match(text, /Another agent already worked on this issue, on a cloud instance, in calendar\./);
  assert.ok(text.indexOf("Another agent") < text.indexOf("# CAL-1"), "the note comes before the issue");
  assert.doesNotMatch(startTask(issue, defaults), /Another agent/);
  const custom = parsePrompts({ firstMessage: { template: "{{issue}}" } });
  assert.match(startTask(issue, custom, { from: "this computer" }), /Comment 3\n\nAnother agent[^\n]*continue the work\.$/, "a template with no {{handoff}} gets it at the end");
});

test("bad settings fall back to the defaults, and a saved config reads back the same", () => {
  const p = parsePrompts({ agentCommand: "  ", skill: "../etc", comments: 500, cloudSetup: { trustFolder: false, other: 1 } });
  assert.equal(p.command, "claude");
  assert.equal(p.skill, "start-issue");
  assert.equal(p.comments, 50);
  assert.deepEqual(p.cloudSetup, { approveMcpServers: true, skipOnboarding: true, trustFolder: false });
  assert.deepEqual(parsePrompts(promptsToConfig(p)), p);
});

test("a command line splits into words, with quotes", () => {
  assert.deepEqual(parseCommand("claude --model opus"), ["claude", "--model", "opus"]);
  assert.deepEqual(parseCommand(`claude --append-system-prompt "be brief" ''`), ["claude", "--append-system-prompt", "be brief", ""]);
  assert.throws(() => parseCommand("   "), /empty/);
  assert.throws(() => parseCommand(`claude "open`), /open " quote/);
});
