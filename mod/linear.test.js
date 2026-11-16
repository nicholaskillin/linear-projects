import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTeamViews, teamViewId, teamKeyOf, teamViewProject, parseIssue, issueGroups, slaStatus, claimInput } from "./linear.js";

test("team views keep entries with a name and a team, with the team key in capitals", () => {
  const raw = [{ name: " Calendar Core ", team: "cal" }, { name: "No team" }, { team: "ENG" }, "junk", { name: "", team: "X" }];
  assert.deepEqual(parseTeamViews(raw), [{ name: "Calendar Core", team: "CAL" }]);
  assert.deepEqual(parseTeamViews(undefined), []);
});

test("a team view ID gives back its team key, and a project ID gives none", () => {
  assert.equal(teamKeyOf(teamViewId("CAL")), "CAL");
  assert.equal(teamKeyOf("3f2a-project-uuid"), null);
  assert.equal(teamKeyOf(null), null);
});

test("a team view project links to the team's issues in Linear", () => {
  const p = teamViewProject({ name: "Calendar Core", team: "CAL" }, "acme");
  assert.equal(p.id, "team:CAL");
  assert.equal(p.url, "https://linear.app/acme/team/CAL/all");
  assert.equal(teamViewProject({ name: "X", team: "CAL" }, null).url, null);
});

test("an issue keeps its team key and project ID", () => {
  const issue = parseIssue({ id: "1", identifier: "CAL-1", title: "T", team: { id: "t", key: "CAL" }, project: null });
  assert.equal(issue.teamKey, "CAL");
  assert.equal(issue.projectId, null);
});

test("issue groups split one status type by status name, in Linear's order", () => {
  const at = (identifier, stateType, state, statePosition) => ({ identifier, stateType, state, statePosition });
  const issues = [
    at("CAL-1", "started", "In Review", 1002), at("CAL-2", "started", "In Progress", 2),
    at("CAL-3", "unstarted", "To Do", 1), at("ENG-4", "started", "In Review", 923), at("CAL-5", "completed", "Done", 3),
  ];
  const groups = issueGroups(issues);
  assert.deepEqual(groups.map((g) => [g.key, g.items.map((i) => i.identifier)]), [
    ["started:In Progress", ["CAL-2"]],
    ["started:In Review", ["CAL-1", "ENG-4"]],
    ["unstarted:To Do", ["CAL-3"]],
  ]);
});

test("an SLA shows its risk level and the time left, or how long ago it breached", () => {
  const hour = 3600000, now = Date.parse("2026-11-16T12:00:00Z");
  const at = (h) => new Date(now + h * hour).toISOString();
  const sla = (medium, high, breach) => ({ mediumRiskAt: at(medium), highRiskAt: at(high), breachesAt: at(breach) });
  assert.equal(slaStatus(null, now), null);
  assert.deepEqual(slaStatus(sla(24, 48, 72), now), { level: "low", label: "SLA 3d left" });
  assert.deepEqual(slaStatus(sla(-1, 20, 30), now), { level: "medium", label: "SLA 1d left" });
  assert.deepEqual(slaStatus(sla(-5, -1, 3), now), { level: "high", label: "SLA 3h left" });
  assert.deepEqual(slaStatus(sla(-50, -26, -2), now), { level: "breached", label: "SLA breached 2h ago" });
});

test("claiming an issue assigns it to me and moves it to the team's first started status", () => {
  const states = [{ id: "todo", type: "unstarted" }, { id: "doing", type: "started" }, { id: "review", type: "started" }];
  assert.deepEqual(claimInput({ assigneeId: null, stateType: "unstarted" }, "me", states), { assigneeId: "me", stateId: "doing" });
  assert.deepEqual(claimInput({ assigneeId: "me", stateType: "backlog" }, "me", states), { stateId: "doing" });
  assert.deepEqual(claimInput({ assigneeId: "ann", stateType: "started" }, "me", states), { assigneeId: "me" });
  assert.equal(claimInput({ assigneeId: "me", stateType: "started" }, "me", states), null);
  assert.throws(() => claimInput({ assigneeId: "me", stateType: "unstarted" }, "me", [states[0]]));
});
