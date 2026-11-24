// Pure helpers: GraphQL queries, response parsing and grouping.
// No Herdr imports, so `node --test` can load this file.

export const API_URL = "https://api.linear.app/graphql";
const PAGE_SIZE = 100;
export const MAX_PAGES = 10;

export const VIEWER_QUERY = `{ viewer { id teams(first: 100) { nodes { id key name } } organization { urlKey } } }`;

export const TEAM_PROJECTS_QUERY = `query($team: String!, $after: String) {
  team(id: $team) {
    projects(first: ${PAGE_SIZE}, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { id name url progress targetDate status { name type color } lead { id name displayName } }
    }
  }
}`;

const ISSUE_FIELDS = `id identifier title url priority priorityLabel branchName sortOrder
  state { name type color position } team { id key } assignee { id name } labels { nodes { name color } }
  project { id } projectMilestone { id name sortOrder }`;

const BLOCKERS = `inverseRelations(first: 20) { nodes { type issue { identifier state { type } } } }`;

// `filter` is a Linear IssueFilter: a queue's filter, with closed issues left out (see queues.js).
export const QUEUE_ISSUES_QUERY = `query($filter: IssueFilter, $after: String) {
  issues(first: ${PAGE_SIZE}, after: $after, filter: $filter) {
    pageInfo { hasNextPage endCursor }
    nodes { ${ISSUE_FIELDS} ${BLOCKERS} }
  }
}`;

// Before queues, a team view listed a team's open issues that are in no project. Its settings were
// kept under this ID, which its queue keeps.
const TEAM_VIEW_PREFIX = "team:";
export const teamViewId = (teamKey) => `${TEAM_VIEW_PREFIX}${teamKey}`;

// `teamViews` in linear-queues-settings.json, from before queues: [{ "name": "Calendar Core", "team": "CAL" }]. Bad entries are skipped.
export function parseTeamViews(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((v) => typeof v?.name === "string" && v.name.trim() && typeof v?.team === "string" && v.team.trim())
    .map((v) => ({ name: v.name.trim(), team: v.team.trim().toUpperCase() }));
}

// Linear's comment order is not documented as newest-first, so the page sorts them itself.
export const ISSUE_QUERY = `query($id: String!) {
  issue(id: $id) {
    ${ISSUE_FIELDS} ${BLOCKERS} description project { id name }
    comments(first: 100) { nodes { id body createdAt user { name } } }
  }
}`;

export const ISSUE_STATE_QUERY = `query($id: String!) { issue(id: $id) { identifier branchName state { type } } }`;
export const BRANCH_ISSUE_QUERY = `query($branch: String!) { issueVcsBranchSearch(branchName: $branch) { identifier state { type } } }`;

// For the condition pickers. The workspace has more labels than a picker can show, so labels come only
// from the workspace and the given teams.
export const LABELS_QUERY = `query($filter: IssueLabelFilter, $after: String) {
  issueLabels(first: ${PAGE_SIZE}, after: $after, filter: $filter) {
    pageInfo { hasNextPage endCursor }
    nodes { id name color isGroup team { key } parent { name } }
  }
}`;
export const USERS_QUERY = `query($after: String) {
  users(first: ${PAGE_SIZE}, after: $after, filter: { active: { eq: true } }) {
    pageInfo { hasNextPage endCursor }
    nodes { id name displayName }
  }
}`;
export const MILESTONES_QUERY = `query($id: String!) { project(id: $id) { name projectMilestones(first: 100) { nodes { id name sortOrder } } } }`;

export const TEAM_STATES_QUERY = `query($id: String!) { team(id: $id) { states(first: 50) { nodes { id name type color position } } } }`;
export const UPDATE_ISSUE = `mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`;

export const PROJECT_GROUPS = [
  ["started", "In Progress"], ["planned", "Planned"], ["paused", "Paused"], ["backlog", "Backlog"],
  ["completed", "Completed"], ["canceled", "Canceled"],
];
export const ACTIVE_PROJECT_TYPES = ["started", "planned", "paused", "backlog"];

export const CLOSED_STATE_TYPES = ["completed", "canceled", "duplicate"];

const STATE_ORDER = ["triage", "backlog", "unstarted", "started", "completed", "canceled"];
export function sortStates(nodes) {
  const rank = (s) => STATE_ORDER.indexOf(s.type);
  return (nodes ?? []).filter((s) => STATE_ORDER.includes(s.type)).sort((a, b) => rank(a) - rank(b) || a.position - b.position);
}

export function parseProject(n) {
  return {
    id: n.id, name: n.name, url: n.url, progress: n.progress ?? 0, targetDate: n.targetDate ?? null,
    status: n.status?.name ?? "", statusType: n.status?.type ?? "", statusColor: n.status?.color ?? null,
    leadId: n.lead?.id ?? null, leadName: n.lead?.displayName || n.lead?.name || null,
  };
}

export function parseIssue(n) {
  const comments = (n.comments?.nodes ?? [])
    .map((c) => ({ id: c.id, body: c.body ?? "", createdAt: c.createdAt, author: c.user?.name ?? "Someone" }))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return {
    id: n.id, identifier: n.identifier, title: n.title, url: n.url,
    priority: n.priority ?? 0, priorityLabel: n.priorityLabel ?? "", branchName: n.branchName ?? null, sortOrder: n.sortOrder ?? 0,
    blockedBy: (n.inverseRelations?.nodes ?? [])
      .filter((r) => r.type === "blocks" && !CLOSED_STATE_TYPES.includes(r.issue?.state?.type))
      .map((r) => r.issue.identifier),
    state: n.state?.name ?? "", stateType: n.state?.type ?? "", stateColor: n.state?.color ?? null, statePosition: n.state?.position ?? 0,
    teamId: n.team?.id ?? null, teamKey: n.team?.key ?? null, assigneeId: n.assignee?.id ?? null, assigneeName: n.assignee?.name ?? null,
    labels: (n.labels?.nodes ?? []).map((l) => ({ name: l.name, color: l.color })),
    description: n.description ?? null, projectId: n.project?.id ?? null,
    milestone: n.projectMilestone
      ? { id: n.projectMilestone.id, name: n.projectMilestone.name, sortOrder: n.projectMilestone.sortOrder ?? 0 }
      : null,
    comments, // newest first; the first message shows as many as the settings say
  };
}

export function groupBy(items, groups, typeOf) {
  return groups.map(([type, label]) => ({ type, label, items: items.filter((i) => typeOf(i) === type) }))
    .filter((g) => g.items.length);
}

// The issueUpdate input that makes an issue yours and in progress: the team's first "started" status,
// for example "In Progress". Null when it already is both.
export function claimInput(issue, viewerId, sortedStates) {
  const input = {};
  if (issue.assigneeId !== viewerId) input.assigneeId = viewerId;
  if (issue.stateType !== "started") {
    const inProgress = sortedStates.find((s) => s.type === "started");
    if (!inProgress) throw new Error("the team has no started status");
    input.stateId = inProgress.id;
  }
  return Object.keys(input).length ? input : null;
}

export const milestoneNumber = (name) => {
  const match = name.match(/^\s*(\d+(?:\.\d+)?)[.):\s-]/);
  return match ? Number(match[1]) : null;
};

export const byName =(a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });

const ISSUE_IDENTIFIER = /^([A-Z][A-Z0-9]*-\d+)(?:\s|$)/;
export const identifierOf = (tab) => (tab?.named ? tab.name.match(ISSUE_IDENTIFIER)?.[1] ?? null : null);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function shortDate(isoDate) {
  const [, month, day] = (isoDate ?? "").split("-").map(Number);
  return month && day ? `${MONTHS[month - 1]} ${day}` : "";
}

function shortDuration(ms) {
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
}

export const ago = (iso, now = Date.now()) => shortDuration(now - Date.parse(iso));
