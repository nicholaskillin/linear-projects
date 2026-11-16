// Pure helpers: GraphQL queries, response parsing, grouping and matching.
// No Herdr imports, so `node --test` can load this file.

export const API_URL = "https://api.linear.app/graphql";
const PAGE_SIZE = 100;
export const MAX_PAGES = 10;
export const COMMENTS_SHOWN = 10;

export const VIEWER_QUERY = `{ viewer { id teams(first: 100) { nodes { id key } } organization { urlKey } } }`;

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
  project { id } projectMilestone { id name sortOrder } slaMediumRiskAt slaHighRiskAt slaBreachesAt`;

const BLOCKERS = `inverseRelations(first: 20) { nodes { type issue { identifier state { type } } } }`;

export const PROJECT_ISSUES_QUERY = `query($id: String!, $after: String) {
  project(id: $id) {
    issues(first: ${PAGE_SIZE}, after: $after, filter: { state: { type: { nin: ["completed", "canceled", "duplicate"] } } }) {
      pageInfo { hasNextPage endCursor }
      nodes { ${ISSUE_FIELDS} ${BLOCKERS} }
    }
  }
}`;

export const TEAM_NO_PROJECT_ISSUES_QUERY = `query($team: String!, $after: String) {
  issues(first: ${PAGE_SIZE}, after: $after, filter: {
    team: { key: { eq: $team } }, project: { null: true }, state: { type: { nin: ["completed", "canceled", "duplicate"] } }
  }) {
    pageInfo { hasNextPage endCursor }
    nodes { ${ISSUE_FIELDS} ${BLOCKERS} }
  }
}`;

// A team view lists a team's open issues that are in no project. It acts as a project everywhere in the
// mod (settings, space, polls), so its ID lives in the same place as project IDs.
const TEAM_VIEW_PREFIX = "team:";
export const teamViewId = (teamKey) => `${TEAM_VIEW_PREFIX}${teamKey}`;
export const teamKeyOf = (projectId) => (projectId?.startsWith(TEAM_VIEW_PREFIX) ? projectId.slice(TEAM_VIEW_PREFIX.length) : null);

// `teamViews` in linear-projects.json: [{ "name": "Calendar Core", "team": "CAL" }]. Bad entries are skipped.
export function parseTeamViews(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((v) => typeof v?.name === "string" && v.name.trim() && typeof v?.team === "string" && v.team.trim())
    .map((v) => ({ name: v.name.trim(), team: v.team.trim().toUpperCase() }));
}

export function teamViewProject({ name, team }, orgUrlKey) {
  return {
    id: teamViewId(team), name, teamKey: team, url: orgUrlKey ? `https://linear.app/${orgUrlKey}/team/${team}/all` : null,
    progress: 0, targetDate: null, status: "", statusType: "", statusColor: null, leadId: null, leadName: null,
  };
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

export const TEAM_STATES_QUERY = `query($id: String!) { team(id: $id) { states(first: 50) { nodes { id name type color position } } } }`;
export const ASSIGN = `mutation($id: String!, $assigneeId: String!) { issueUpdate(id: $id, input: { assigneeId: $assigneeId }) { success } }`;
export const UNASSIGN = `mutation($id: String!) { issueUpdate(id: $id, input: { assigneeId: null }) { success } }`;
export const UPDATE_ISSUE = `mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`;
export const SET_STATE =`mutation($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }`;

export const PROJECT_GROUPS = [
  ["started", "In Progress"], ["planned", "Planned"], ["paused", "Paused"], ["backlog", "Backlog"],
  ["completed", "Completed"], ["canceled", "Canceled"],
];
export const ACTIVE_PROJECT_TYPES = ["started", "planned", "paused", "backlog"];

export const ISSUE_GROUPS = [
  ["started", "In Progress"], ["unstarted", "Todo"], ["backlog", "Backlog"], ["triage", "Triage"],
];

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
    sla: n.slaBreachesAt ? { mediumRiskAt: n.slaMediumRiskAt, highRiskAt: n.slaHighRiskAt, breachesAt: n.slaBreachesAt } : null,
    milestone: n.projectMilestone
      ? { id: n.projectMilestone.id, name: n.projectMilestone.name, sortOrder: n.projectMilestone.sortOrder ?? 0 }
      : null,
    comments: comments.slice(0, COMMENTS_SHOWN), moreComments: Math.max(0, comments.length - COMMENTS_SHOWN),
  };
}

export function groupBy(items, groups, typeOf) {
  return groups.map(([type, label]) => ({ type, label, items: items.filter((i) => typeOf(i) === type) }))
    .filter((g) => g.items.length);
}

// A team can have several statuses of one type, for example "In Progress" and "In Review" are both
// "started". So each type splits into one group per status name, in Linear's order. Teams in one project
// can share a status name, and then their issues share the group.
export function issueGroups(issues) {
  return ISSUE_GROUPS.flatMap(([type]) => {
    const byState = new Map();
    for (const issue of issues.filter((i) => i.stateType === type)) {
      const group = byState.get(issue.state)
        ?? byState.set(issue.state, { key: `${type}:${issue.state}`, type, label: issue.state, position: issue.statePosition, items: [] }).get(issue.state);
      group.position = Math.min(group.position, issue.statePosition);
      group.items.push(issue);
    }
    return [...byState.values()].sort((a, b) => a.position - b.position);
  });
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

// Numbered milestones ("3. Add a feed") by number, then unnumbered ones in Linear's order, then issues
// with no milestone.
export function milestoneGroups(issues) {
  const groups = new Map();
  for (const issue of issues) {
    const key = issue.milestone?.id ?? "none";
    if (!groups.has(key)) groups.set(key, { key, milestone: issue.milestone, number: issue.milestone && milestoneNumber(issue.milestone.name), items: [] });
    groups.get(key).items.push(issue);
  }
  const rank = (g) => (!g.milestone ? 2 : g.number == null ? 1 : 0);
  return [...groups.values()].sort((a, b) => rank(a) - rank(b)
    || (rank(a) === 0 ? a.number - b.number : 0)
    || (a.milestone?.sortOrder ?? 0) - (b.milestone?.sortOrder ?? 0));
}

export const byName =(a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });

const ISSUE_IDENTIFIER = /^([A-Z][A-Z0-9]*-\d+)(?:\s|$)/;
export const identifierOf = (tab) => (tab?.named ? tab.name.match(ISSUE_IDENTIFIER)?.[1] ?? null : null);

// A saved link wins over a name match, so a link can also correct a wrong name match.
export function projectIdForSpace(space, projects, links) {
  if (!space) return null;
  const linked = links?.[space.id];
  if (linked) return linked;
  const name = space.name.trim().toLowerCase();
  return projects.find((p) => p.name.trim().toLowerCase() === name)?.id ?? null;
}

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

// Linear's risk levels for an SLA, from the times it sets: "low" before medium risk, then "medium",
// "high" and "breached". Null for an issue with no SLA.
export function slaStatus(sla, now = Date.now()) {
  if (!sla) return null;
  const breachesAt = Date.parse(sla.breachesAt);
  if (now >= breachesAt) return { level: "breached", label: `SLA breached ${shortDuration(now - breachesAt)} ago` };
  const level = now >= Date.parse(sla.highRiskAt) ? "high" : now >= Date.parse(sla.mediumRiskAt) ? "medium" : "low";
  return { level, label: `SLA ${shortDuration(breachesAt - now)} left` };
}
