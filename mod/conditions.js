// A queue's filter as a list of conditions that the panel can edit: { field, negate, values }. All
// conditions must match, and a condition matches any of its values. No Herdr imports, so `node --test`
// can load this file.

// Values that are not IDs: NONE means the field is empty, ME means you, and BLOCKED is the one value of
// the Blocked condition.
export const NONE = "none";
export const ME = "me";
export const BLOCKED = "blocked";

// `none`: the label for NONE, for a field that can be empty. `fixed`: the field has one value, so only
// "is" or "is not" changes.
export const FIELDS = [
  { key: "project", label: "Project", none: "No project" },
  { key: "team", label: "Team" },
  { key: "label", label: "Label" },
  { key: "assignee", label: "Assignee", none: "No one" },
  { key: "status", label: "Status" },
  { key: "priority", label: "Priority" },
  { key: "milestone", label: "Milestone", none: "No milestone" },
  { key: "blocked", label: "Blocked", fixed: "by an open issue" },
];

export const PRIORITIES = [[1, "Urgent"], [2, "High"], [3, "Medium"], [4, "Low"], [0, "No priority"]];
// New queues start with these, so a poll starts only To Do issues that are unassigned or yours and not
// blocked. Each is a normal condition that you can change or remove. `todoNames` are the names of your
// teams' Todo-type statuses, for example ["To Do"]; with none, the Status condition is left out.
export function defaultConditions(todoNames = []) {
  return [
    { field: "assignee", negate: false, values: [NONE, ME] },
    ...(todoNames.length ? [{ field: "status", negate: false, values: todoNames }] : []),
    { field: "blocked", negate: true, values: [BLOCKED] },
  ];
}

// Each field: the IssueFilter key, and the key inside it that the values compare with.
const PATHS = {
  project: ["project", "id"], team: ["team", "key"], assignee: ["assignee", "id"], status: ["state", "name"], priority: ["priority"], milestone: ["projectMilestone", "id"],
};

const isObject = (v) => v != null && typeof v === "object" && !Array.isArray(v);
const only = (o) => (isObject(o) && Object.keys(o).length === 1 ? Object.entries(o)[0] : null);
const fieldDef = (key) => FIELDS.find((f) => f.key === key);

// { in | nin | eq | neq } -> { negate, values }; null for another comparator.
function comparison(c) {
  const [op, v] = only(c) ?? [];
  if ((op === "in" || op === "nin") && Array.isArray(v) && v.length) return { negate: op === "nin", values: v };
  if (op === "eq" || op === "neq") return { negate: op === "neq", values: [v] };
  return null;
}

// One filter item with one kind of value, for example { assignee: { null: true } }.
function parsePart(item) {
  const [key, value] = only(item) ?? [];
  if (key === "hasBlockedByRelations") {
    const cmp = comparison(value);
    return cmp && typeof cmp.values[0] === "boolean" ? { field: "blocked", negate: cmp.values[0] === cmp.negate, values: [BLOCKED] } : null;
  }
  if (key === "labels") {
    const [quantifier, inner] = only(value) ?? [];
    const [idKey, c] = only(inner) ?? [];
    const cmp = idKey === "id" ? comparison(c) : null;
    if (quantifier === "some" && cmp && !cmp.negate) return { field: "label", negate: false, values: cmp.values };
    if (quantifier === "every" && cmp?.negate) return { field: "label", negate: true, values: cmp.values };
    return null;
  }
  const fields = Object.keys(PATHS).filter((f) => PATHS[f][0] === key);
  if (!fields.length) return null;
  if (!PATHS[fields[0]][1]) {
    const cmp = comparison(value);
    return cmp ? { field: fields[0], ...cmp } : null;
  }
  const [subKey, c] = only(value) ?? [];
  if (subKey === "null") {
    const field = fields.find((f) => fieldDef(f).none);
    return field && typeof c === "boolean" ? { field, negate: !c, values: [NONE] } : null;
  }
  if (subKey === "isMe") {
    const [op, me] = only(c) ?? [];
    return key === "assignee" && op === "eq" && typeof me === "boolean" ? { field: "assignee", negate: !me, values: [ME] } : null;
  }
  const field = fields.find((f) => PATHS[f][1] === subKey), cmp = field ? comparison(c) : null;
  return cmp ? { field, ...cmp } : null;
}

// A condition with several kinds of value is an `or` of parts ("is"), or an `and` of parts ("is not").
function parseItem(item) {
  const [key, value] = only(item) ?? [];
  if ((key === "or" || key === "and") && Array.isArray(value) && value.length > 1) {
    const parts = value.map(parsePart);
    if (parts.some((p) => !p || p.field !== parts[0].field || p.negate !== (key === "and"))) return null;
    return { field: parts[0].field, negate: key === "and", values: parts.flatMap((p) => p.values) };
  }
  return parsePart(item);
}

// The conditions of a filter that the panel made, or a queue made from a project or a team. Null
// for a filter that conditions cannot show, so the panel never changes a hand-written filter.
export function toConditions(filter) {
  if (!isObject(filter)) return null;
  const keys = Object.keys(filter);
  const items = keys.length === 1 && keys[0] === "and" ? filter.and : keys.map((k) => ({ [k]: filter[k] }));
  if (!Array.isArray(items)) return null;
  const conditions = items.map(parseItem);
  if (conditions.some((c) => !c)) return null;
  const fields = conditions.map((c) => c.field);
  return new Set(fields).size === fields.length ? conditions : null;
}

function toItem({ field, negate, values }) {
  if (field === "blocked") return { hasBlockedByRelations: { eq: !negate } };
  if (field === "label") return negate ? { labels: { every: { id: { nin: values } } } } : { labels: { some: { id: { in: values } } } };
  const [key, sub] = PATHS[field];
  const ids = values.filter((v) => v !== NONE && v !== ME), parts = [];
  if (values.includes(NONE)) parts.push({ [key]: { null: !negate } });
  if (values.includes(ME)) parts.push({ [key]: { isMe: { eq: !negate } } });
  if (ids.length) {
    const c = { [negate ? "nin" : "in"]: ids };
    parts.push({ [key]: sub ? { [sub]: c } : c });
  }
  return parts.length === 1 ? parts[0] : { [negate ? "and" : "or"]: parts };
}

// A condition with no values matches nothing yet, so it is left out. No conditions gives {}, which the
// poll refuses: it would find every issue in the workspace.
export function toFilter(conditions) {
  const items = conditions.filter((c) => c.values.length).map(toItem);
  return items.length === 1 ? items[0] : items.length ? { and: items } : {};
}

export function toggleValue(values, value) {
  return values.includes(value) ? values.filter((v) => v !== value) : [...values, value];
}

// Adds each default condition whose field the filter does not have yet.
export function withDefaultConditions(filter, todoNames) {
  const conditions = toConditions(filter) ?? [], defaults = defaultConditions(todoNames);
  return toFilter([...conditions, ...defaults.filter((d) => !conditions.some((c) => c.field === d.field))]);
}

// Filters for the project list in "New queue". They run on the loaded projects, not in Linear.
export const PROJECT_FIELDS = [
  { key: "lead", label: "Lead", none: "No lead" },
  { key: "projectStatus", label: "Status" },
  { key: "team", label: "Team" },
];

export const DEFAULT_PROJECT_FILTERS = [
  { field: "lead", negate: false, values: [ME] },
  { field: "projectStatus", negate: false, values: ["started", "planned", "paused", "backlog"] },
];

// `project` has leadId, statusType and teamKeys. A filter with no values matches every project.
export function projectMatches(project, filters, viewerId) {
  return filters.every(({ field, negate, values }) => {
    if (!values.length) return true;
    let hit = true;
    if (field === "lead") hit = values.some((v) => (v === ME ? viewerId != null && project.leadId === viewerId : v === NONE ? !project.leadId : v === project.leadId));
    else if (field === "projectStatus") hit = values.includes(project.statusType);
    else if (field === "team") hit = (project.teamKeys ?? []).some((k) => values.includes(k));
    return hit !== negate;
  });
}
