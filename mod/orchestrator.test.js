import { test } from "node:test";
import assert from "node:assert/strict";
import { readyIssues, parseWorktrees, sweepCandidates, worktreeSlug, issueTabs, startTask, colorFor, SPACE_COLORS } from "./orchestrator.js";

const ME = "me";
const issue = (identifier, fields = {}) => ({
  identifier, title: identifier, stateType: "unstarted", assigneeId: ME, blockedBy: [], priority: 0, sortOrder: 0,
  milestone: null, ...fields,
});
const milestone = (name, sortOrder = 0) => ({ id: name, name, sortOrder });

test("ready issues are my Todo issues with no tab and no open blocker", () => {
  const issues = [
    issue("CAL-1"),
    issue("CAL-2", { stateType: "started" }),
    issue("CAL-3", { assigneeId: "someone" }),
    issue("CAL-4", { blockedBy: ["CAL-1"] }),
    issue("CAL-5"),
    issue("CAL-6", { assigneeId: null }),
  ];
  const ready = readyIssues(issues, { assigneeId: ME, tabIdents: new Set(["CAL-5"]) });
  assert.deepEqual(ready.map((i) => i.identifier), ["CAL-1"]);
  assert.deepEqual(readyIssues(issues, { assigneeId: null, tabIdents: new Set() }).map((i) => i.identifier), ["CAL-6"]);
});

test("order: numbered milestones, unnumbered, none; then priority; then Linear order", () => {
  const issues = [
    issue("none"),
    issue("unnumbered", { milestone: milestone("Polish", 1) }),
    issue("m10", { milestone: milestone("10. Later") }),
    issue("m2-low", { milestone: milestone("2. Feed"), priority: 4 }),
    issue("m2-nopriority", { milestone: milestone("2. Feed"), priority: 0 }),
    issue("m2-urgent-second", { milestone: milestone("2. Feed"), priority: 1, sortOrder: 5 }),
    issue("m2-urgent-first", { milestone: milestone("2. Feed"), priority: 1, sortOrder: -5 }),
  ];
  assert.deepEqual(readyIssues(issues, { assigneeId: ME, tabIdents: new Set() }).map((i) => i.identifier),
    ["m2-urgent-first", "m2-urgent-second", "m2-low", "m2-nopriority", "m10", "unnumbered", "none"]);
});

test("parses git worktree list", () => {
  const porcelain = "worktree /code/calendar\nHEAD abc\nbranch refs/heads/main\n\nworktree /w/calendar/x\nHEAD def\nbranch refs/heads/dev/cal-1-x\n\nworktree /w/calendar/home\nHEAD 123\ndetached\n";
  assert.deepEqual(parseWorktrees(porcelain), [
    { path: "/code/calendar", branch: "main" },
    { path: "/w/calendar/x", branch: "dev/cal-1-x" },
    { path: "/w/calendar/home", branch: null },
  ]);
});

test("worktree slug follows Herdr's convention", () => {
  assert.equal(worktreeSlug("dev/cal-123-fix feed!"), "dev-cal-123-fix-feed");
});

test("issue tabs are named tabs that start with an issue ID", () => {
  const space = { tabs: [{ name: "CAL-1 fix", named: true }, { name: "Orchestrator", named: true }, { name: "CAL-2", named: false }] };
  assert.deepEqual(issueTabs(space).map((t) => t.ident), ["CAL-1"]);
});

test("start task carries the issue", () => {
  const text = startTask({ ...issue("CAL-1"), title: "Fix", branchName: "b", description: "Do it",
    comments: [{ author: "Ann", createdAt: "2026-11-01T00:00:00Z", body: "Also this" }], moreComments: 2 });
  assert.match(text, /^\/start-issue CAL-1\n/);
  assert.match(text, /# CAL-1: Fix/);
  assert.match(text, /Ann, 2026-11-01:\nAlso this/);
  assert.match(text, /2 older comments/);
});

test("sweep candidates are unused linked worktrees on a branch under the root", () => {
  const root = "/h/.herdr/worktrees";
  const porcelain = [
    "worktree /code/cal\nHEAD a\nbranch refs/heads/main",
    `worktree ${root}/cal/done\nHEAD b\nbranch refs/heads/done`,
    `worktree ${root}/cal/open-tab\nHEAD c\nbranch refs/heads/open-tab`,
    `worktree ${root}/cal/project\nHEAD d\ndetached`,
    "worktree /elsewhere/cal-x\nHEAD e\nbranch refs/heads/x",
    `worktree ${root}/cal/done-2\nHEAD f\nbranch refs/heads/done-2`,
  ].join("\n\n");
  const openFolders = [`${root}/cal/open-tab/app/models`, `${root}/cal/done-2-other`];
  assert.deepEqual(sweepCandidates(porcelain, { root, openFolders }).map((w) => w.branch), ["done", "done-2"]);
});

test("a project keeps its color, and a new one gets the least used color", () => {
  const active = new Set(["a", "b"]);
  assert.equal(colorFor("a", { a: "ansi4" }, active), "ansi4");
  assert.equal(colorFor("c", { a: SPACE_COLORS[0], b: SPACE_COLORS[1] }, active), SPACE_COLORS[2]);
  assert.equal(colorFor("c", { a: SPACE_COLORS[0], old: SPACE_COLORS[1] }, active), SPACE_COLORS[1], "inactive projects free their color");
  const all = Object.fromEntries(SPACE_COLORS.map((c, i) => [`p${i}`, c]));
  const allActive = new Set(Object.keys(all));
  assert.equal(colorFor("new", { ...all, p0b: SPACE_COLORS[0] }, new Set([...allActive, "p0b"])), SPACE_COLORS[1]);
});
