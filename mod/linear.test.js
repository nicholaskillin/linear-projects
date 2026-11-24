import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTeamViews, parseIssue, claimInput } from "./linear.js";

test("team views keep entries with a name and a team, with the team key in capitals", () => {
  const raw = [{ name: " Calendar Core ", team: "cal" }, { name: "No team" }, { team: "ENG" }, "junk", { name: "", team: "X" }];
  assert.deepEqual(parseTeamViews(raw), [{ name: "Calendar Core", team: "CAL" }]);
  assert.deepEqual(parseTeamViews(undefined), []);
});

test("an issue keeps its team key and project ID", () => {
  const issue = parseIssue({ id: "1", identifier: "CAL-1", title: "T", team: { id: "t", key: "CAL" }, project: null });
  assert.equal(issue.teamKey, "CAL");
  assert.equal(issue.projectId, null);
});

test("claiming an issue assigns it to me and moves it to the team's first started status", () => {
  const states = [{ id: "todo", type: "unstarted" }, { id: "doing", type: "started" }, { id: "review", type: "started" }];
  assert.deepEqual(claimInput({ assigneeId: null, stateType: "unstarted" }, "me", states), { assigneeId: "me", stateId: "doing" });
  assert.deepEqual(claimInput({ assigneeId: "me", stateType: "backlog" }, "me", states), { stateId: "doing" });
  assert.deepEqual(claimInput({ assigneeId: "ann", stateType: "started" }, "me", states), { assigneeId: "me" });
  assert.equal(claimInput({ assigneeId: "me", stateType: "started" }, "me", states), null);
  assert.throws(() => claimInput({ assigneeId: "me", stateType: "unstarted" }, "me", [states[0]]));
});
