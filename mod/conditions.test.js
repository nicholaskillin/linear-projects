import { test } from "node:test";
import assert from "node:assert/strict";
import { NONE, ME, BLOCKED, defaultConditions, toConditions, toFilter, toggleValue, withDefaultConditions, DEFAULT_PROJECT_FILTERS, projectMatches } from "./conditions.js";

const TODO = ["To Do"], DEFAULTS = defaultConditions(TODO);
import { projectQueue, teamQueue } from "./queues.js";

test("a new project queue or team queue has the default conditions", () => {
  assert.deepEqual(toConditions(projectQueue({ id: "p1", name: "A" }, new Set(), TODO).filter), [{ field: "project", negate: false, values: ["p1"] }, ...DEFAULTS]);
  assert.deepEqual(toConditions(teamQueue({ name: "Core", team: "CAL" }, TODO).filter), [
    { field: "team", negate: false, values: ["CAL"] },
    { field: "project", negate: false, values: [NONE] },
    ...DEFAULTS,
  ]);
  assert.equal(defaultConditions([]).some((c) => c.field === "status"), false, "no status names: no Status condition");
});

test("the default conditions as Linear filters", () => {
  assert.deepEqual(toFilter(DEFAULTS), { and: [
    { or: [{ assignee: { null: true } }, { assignee: { isMe: { eq: true } } }] },
    { state: { name: { in: ["To Do"] } } },
    { hasBlockedByRelations: { eq: false } },
  ] });
});

test("a field can mix none, me and IDs, and is not mixes them too", () => {
  const is = { field: "assignee", negate: false, values: [NONE, ME, "u1"] };
  assert.deepEqual(toFilter([is]), { or: [{ assignee: { null: true } }, { assignee: { isMe: { eq: true } } }, { assignee: { id: { in: ["u1"] } } }] });
  const isNot = { field: "project", negate: true, values: [NONE, "p1"] };
  assert.deepEqual(toFilter([isNot]), { and: [{ project: { null: false } }, { project: { id: { nin: ["p1"] } } }] });
  assert.deepEqual(toConditions(toFilter([is, isNot])), [is, isNot]);
  const blocked = { field: "blocked", negate: false, values: [BLOCKED] };
  assert.deepEqual(toConditions(toFilter([blocked])), [blocked]);
});

test("a filter gets each default condition whose field it lacks", () => {
  const mine = { and: [{ project: { id: { in: ["p1"] } } }, { assignee: { null: true } }] };
  assert.deepEqual(toConditions(withDefaultConditions(mine, TODO)).map((c) => [c.field, c.values]), [
    ["project", ["p1"]], ["assignee", [NONE]], ["status", TODO], ["blocked", [BLOCKED]],
  ], "an assignee condition stays as it was");
});

test("each field reads back the filter it writes", () => {
  const conditions = [
    { field: "project", negate: true, values: ["p1", "p2"] },
    { field: "team", negate: false, values: ["CAL"] },
    { field: "label", negate: false, values: ["l1"] },
    { field: "assignee", negate: true, values: [NONE] },
    { field: "status", negate: false, values: ["Todo", "In Progress"] },
    { field: "priority", negate: true, values: [0, 4] },
    { field: "milestone", negate: false, values: ["m1"] },
  ];
  const filter = toFilter(conditions);
  assert.deepEqual(filter.and[2], { labels: { some: { id: { in: ["l1"] } } } });
  assert.deepEqual(filter.and[3], { assignee: { null: false } });
  assert.deepEqual(filter.and[5], { priority: { nin: [0, 4] } });
  assert.deepEqual(toConditions(filter), conditions);
  const without = { field: "label", negate: true, values: ["l1"] };
  assert.deepEqual(toFilter([without]), { labels: { every: { id: { nin: ["l1"] } } } });
  assert.deepEqual(toConditions(toFilter([without])), [without]);
});

test("conditions with no values are left out, and none at all gives an empty filter", () => {
  assert.deepEqual(toFilter([{ field: "team", negate: false, values: [] }, { field: "priority", negate: false, values: [1] }]), { priority: { in: [1] } });
  assert.deepEqual(toFilter([]), {});
  assert.deepEqual(toConditions({}), []);
});

test("a filter that conditions cannot show reads as null", () => {
  assert.equal(toConditions({ or: [{ project: { null: true } }] }), null);
  assert.equal(toConditions({ estimate: { gte: 3 } }), null);
  assert.equal(toConditions({ and: [{ team: { key: { in: ["A"] } } }, { team: { key: { in: ["B"] } } }] }), null, "one condition per field");
  assert.equal(toConditions({ labels: { some: { name: { eq: "Bug" } } } }), null);
  assert.equal(toConditions({ team: { name: { eq: "Calendar" } } }), null);
});

test("a click adds or removes one value", () => {
  assert.deepEqual(toggleValue([NONE], ME), [NONE, ME]);
  assert.deepEqual(toggleValue(["p1", "p2"], "p1"), ["p2"]);
});

test("project filters: lead, status and team, with is and is not", () => {
  const p = (leadId, statusType, teamKeys) => ({ leadId, statusType, teamKeys });
  const mine = p("me-id", "started", ["CAL"]), noLead = p(null, "planned", ["ENG"]), done = p("ann", "completed", ["CAL", "ENG"]);
  const match = (filters) => [mine, noLead, done].map((x) => projectMatches(x, filters, "me-id"));
  assert.deepEqual(match(DEFAULT_PROJECT_FILTERS), [true, false, false]);
  assert.deepEqual(match([{ field: "lead", negate: false, values: [ME, NONE] }]), [true, true, false]);
  assert.deepEqual(match([{ field: "projectStatus", negate: true, values: ["completed"] }]), [true, true, false]);
  assert.deepEqual(match([{ field: "team", negate: false, values: ["ENG"] }]), [false, true, true]);
  assert.deepEqual(match([{ field: "lead", negate: false, values: [] }]), [true, true, true], "a filter with no values matches all");
});
