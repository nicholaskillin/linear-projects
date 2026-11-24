import { test } from "node:test";
import assert from "node:assert/strict";
import { ME, toConditions } from "./conditions.js";
import { projectQueue, teamQueue, scratchQueue, parseQueues, serializeQueues, openIssuesFilter, migrateQueues, stepPoll, pollLabel } from "./queues.js";

test("a project queue finds the project's issues, and a second one gets its own ID", () => {
  const project = { id: "p1", name: "Canceled Events" };
  const first = projectQueue(project);
  assert.deepEqual({ ...first, filter: undefined }, { id: "p1", name: "Canceled Events", projectId: "p1", filter: undefined,
    maxAgents: 3, pollMinutes: 0, paused: false, repo: null, host: null });
  assert.deepEqual(first.filter.and[0], { project: { id: { in: ["p1"] } } });
  assert.equal(projectQueue(project, new Set(["p1", "p1#2"])).id, "p1#3");
});

test("a queue from scratch has a name, an ID from its name, and only the default conditions", () => {
  const c = scratchQueue(" Urgent bugs! ", new Set(["queue-urgent-bugs"]), ["To Do"]);
  assert.equal(c.name, "Urgent bugs!");
  assert.equal(c.id, "queue-urgent-bugs-2");
  assert.equal(c.filter.and.length, 3);
  assert.equal(c.pollMinutes, 0, "it does not poll until you turn polling on");
});

test("a team queue finds the team's issues in no project", () => {
  const c = teamQueue({ name: "Calendar Core", team: "CAL" });
  assert.equal(c.id, "team:CAL");
  assert.deepEqual(c.filter.and.slice(0, 2), [{ team: { key: { in: ["CAL"] } } }, { project: { null: true } }]);
});

test("parsing keeps good queues, skips bad ones, and fixes bad settings", () => {
  const good = projectQueue({ id: "p1", name: "A" });
  const text = serializeQueues([
    { ...good, maxAgents: 40, pollMinutes: 7, host: "moon", repo: " calendar " },
    { id: "p1", name: "Same ID", filter: {} },
    { id: "x", name: "No filter" },
    { name: "", filter: {} },
  ]);
  const { queues, skipped } = parseQueues(text);
  assert.deepEqual(queues, [{ ...good, maxAgents: 10, pollMinutes: 0, host: null, repo: "calendar" }]);
  assert.deepEqual(skipped, ["Same ID", "No filter", "entry 4"]);
  assert.deepEqual(parseQueues(serializeQueues(queues)).queues, queues, "a saved file reads back the same");
  assert.deepEqual(parseQueues(JSON.stringify({ contexts: [good] })).queues, [good], "a file from before the rename still reads");
  assert.throws(() => parseQueues("{"), /not valid JSON/);
  assert.throws(() => parseQueues("{}"), /"queues" list/);
});

test("the poll asks only for issues that are not closed", () => {
  assert.deepEqual(openIssuesFilter({ project: { id: { eq: "p1" } } }), {
    and: [{ project: { id: { eq: "p1" } } }, { state: { type: { nin: ["completed", "canceled", "duplicate"] } } }],
  });
});

test("old project settings, links, issue spaces and team views become queues with the same IDs", () => {
  const queues = migrateQueues({
    settings: { p1: { maxAgents: 2, pollMinutes: 30, host: "cloud" }, "team:CAL": { maxAgents: 1 }, gone: { maxAgents: 5 } },
    links: { sp1: "p2" },
    issueProjects: { "CAL-1": "p1", "CAL-2": "team:ENG" },
    teamViews: [{ name: "Calendar Core", team: "CAL" }],
    names: { p1: "Canceled Events", p2: "iCal Feeds" },
  });
  assert.deepEqual(queues.map((c) => [c.id, c.name, c.maxAgents, c.pollMinutes, c.host]), [
    ["team:CAL", "Calendar Core", 1, 0, null],
    ["p1", "Canceled Events", 2, 30, "cloud"],
    ["p2", "iCal Feeds", 3, 0, null],
    ["team:ENG", "ENG issues in no project", 3, 0, null],
  ], "a project with no known name is left out");
  const assignee = (q) => toConditions(q.filter).find((c) => c.field === "assignee");
  assert.ok(queues.every((q) => assignee(q).values.length === 1 && assignee(q).values[0] === ME && !assignee(q).negate),
    "a moved queue starts only your issues, as the old version did");
});

test("poll steps and labels", () => {
  assert.equal(stepPoll(0, -1), 0);
  assert.equal(stepPoll(30, 1), 60);
  assert.equal(stepPoll(120, 1), 120);
  assert.deepEqual([0, 5, 60, 90].map(pollLabel), ["Off", "5m", "1h", "1h 30m"]);
});
