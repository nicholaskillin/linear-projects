// Queues: a Linear issue filter, with the agent and poll settings for the issues it finds. They live in
// a JSON file that people and agents can edit by hand. No Herdr imports, so `node --test` can load this file.
import { CLOSED_STATE_TYPES, teamViewId } from "./linear.js";
import { parseHost } from "./cloud.js";
import { ME, withDefaultConditions, toConditions, toFilter } from "./conditions.js";

export const QUEUES_FILE = "linear-queues.json";
export const MAX_AGENTS_LIMIT = 10;
export const POLL_STEPS = [0, 1, 2, 5, 10, 15, 30, 60, 90, 120]; // minutes; 0 is off
const SETTINGS = { maxAgents: 3, pollMinutes: 0, paused: false, repo: null, host: null }; // repo null: the default repo; host null: the default host

// `filter` is a Linear IssueFilter, as the API takes it, with the default conditions added. `projectId`
// is set for a queue made from a project, so "New queue" can tell that the project has one.
// `todoNames`: see defaultConditions.
export function projectQueue(project, taken = new Set(), todoNames = []) {
  let id = project.id;
  for (let n = 2; taken.has(id); n++) id = `${project.id}#${n}`;
  return { id, name: project.name, projectId: project.id, filter: withDefaultConditions({ project: { id: { eq: project.id } } }, todoNames), ...SETTINGS };
}

// A queue with only the default conditions, for you to finish on its page. Its ID comes from its name.
export function scratchQueue(name, taken = new Set(), todoNames = []) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "queue";
  let id = `queue-${slug}`;
  for (let n = 2; taken.has(id); n++) id = `queue-${slug}-${n}`;
  return { id, name: name.trim(), projectId: null, filter: withDefaultConditions({}, todoNames), ...SETTINGS };
}

export function teamQueue({ name, team }, todoNames = []) {
  return { id: teamViewId(team), name, projectId: null, filter: withDefaultConditions({ team: { key: { eq: team } }, project: { null: true } }, todoNames), ...SETTINGS };
}

const isObject = (v) => v != null && typeof v === "object" && !Array.isArray(v);
const nonEmpty = (v) => typeof v === "string" && v.trim() !== "";

// Throws on a file that is not JSON or not { "queues": [...] }. A queue with a bad id, name or filter
// is left out and named in `skipped`. Bad settings fall back to their defaults.
export function parseQueues(text) {
  let raw;
  try { raw = JSON.parse(text); } catch { throw new Error(`${QUEUES_FILE} is not valid JSON`); }
  // A file from before the rename to Linear Queues has a "contexts" list. The next save writes "queues".
  const list = raw?.queues ?? raw?.contexts;
  if (!Array.isArray(list)) throw new Error(`${QUEUES_FILE} needs a "queues" list`);
  const queues = [], skipped = [], ids = new Set();
  list.forEach((c, i) => {
    if (!nonEmpty(c?.id) || !nonEmpty(c?.name) || !isObject(c?.filter) || ids.has(c.id)) {
      skipped.push(nonEmpty(c?.name) ? c.name : `entry ${i + 1}`);
      return;
    }
    ids.add(c.id);
    const step = POLL_STEPS.includes(c.pollMinutes) ? c.pollMinutes : SETTINGS.pollMinutes;
    queues.push({
      id: c.id, name: c.name.trim(), projectId: nonEmpty(c.projectId) ? c.projectId : null, filter: c.filter,
      maxAgents: Number.isInteger(c.maxAgents) ? Math.min(MAX_AGENTS_LIMIT, Math.max(1, c.maxAgents)) : SETTINGS.maxAgents,
      pollMinutes: step, paused: c.paused === true, repo: nonEmpty(c.repo) ? c.repo.trim() : null, host: parseHost(c.host),
    });
  });
  return { queues, skipped };
}

export const serializeQueues = (queues) => `${JSON.stringify({ queues }, null, 2)}\n`;

// The poll needs only the issues that are not closed. A closed issue's space is found through its tab.
export const openIssuesFilter = (filter) => ({ and: [filter, { state: { type: { nin: CLOSED_STATE_TYPES } } }] });

// Before queues, settings were kept for each project ID, or "team:<KEY>" for a team view. Polls then
// started only issues assigned to you, so a moved queue gets "Assignee is Me", not the default
// "No one, Me": an upgrade starts no issue that the old version would not have started. Each one in
// use becomes a queue with the same ID, so issue spaces, links and colors stay with it. A project
// is in use when it has settings, a linked space, or a running issue space.
export function migrateQueues({ settings = {}, links = {}, issueProjects = {}, teamViews = [], names = {}, todoNames = [] }) {
  const teams = new Map(teamViews.map((v) => [teamViewId(v.team), v]));
  const ids = [...new Set([...teams.keys(), ...Object.keys(settings), ...Object.values(links), ...Object.values(issueProjects)])];
  return ids.flatMap((id) => {
    const team = teams.get(id) ?? (id.startsWith("team:") ? { name: `${id.slice(5)} issues in no project`, team: id.slice(5) } : null);
    const base = team ? teamQueue(team, todoNames) : names[id] ? projectQueue({ id, name: names[id] }, new Set(), todoNames) : null;
    if (!base) return [];
    base.filter = toFilter(toConditions(base.filter).map((c) => (c.field === "assignee" ? { ...c, values: [ME] } : c)));
    const old = settings[id] ?? {};
    return [{ ...base, ...Object.fromEntries(Object.keys(SETTINGS).filter((k) => old[k] !== undefined).map((k) => [k, old[k]])) }];
  });
}

export function stepPoll(minutes, direction) {
  const index = Math.max(0, POLL_STEPS.indexOf(minutes));
  return POLL_STEPS[Math.min(POLL_STEPS.length - 1, Math.max(0, index + direction))];
}

export function pollLabel(minutes) {
  if (!minutes) return "Off";
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  if (!hours) return `${rest}m`;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}
