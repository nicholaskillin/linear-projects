// Linear projects from your teams. The active space selects its project, and the active tab selects
// the issue it is named after. Clicks change the view only until the next space or tab switch.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea, Scrollbar } from "gpui-base";
import { spaces, agents, run, exec, home, appHome, readTextFile, shared, setShared, theme, nextCommand, props, openOverlay, notify } from "herdr";
import { loadApiKey, gql } from "./api.js";
import {
  VIEWER_QUERY, TEAM_PROJECTS_QUERY, ASSIGN, UNASSIGN, UPDATE_ISSUE, PROJECT_ISSUES_QUERY, ISSUE_QUERY, ISSUE_STATE_QUERY, TEAM_STATES_QUERY, MAX_PAGES,
  PROJECT_GROUPS, ACTIVE_PROJECT_TYPES, ISSUE_GROUPS, CLOSED_STATE_TYPES, parseProject, parseIssue, sortStates, groupBy,
  milestoneGroups, byName, identifierOf, projectIdForSpace, shortDate, ago,
} from "./linear.js";
import { issueTabs, readyIssues, parseWorktrees, worktreeSlug, startTask } from "./orchestrator.js";
import { StatusMenu, STATUS_MENU_WIDTH, statusMenuHeight } from "./status-menu.js";
import { openUrl } from "./open.js";

const PROJECTS_REFRESH_MS = 5 * 60 * 1000;
const LINKS_KEY = "linear-projects.links"; // { "<space id>": "<project id>" }

const activeSpace = () => spaces().find((s) => s.active) ?? null;
const activeTab = (space) => space?.tabs.find((t) => t.active) ?? null;
const links = () => shared(LINKS_KEY) ?? {};
// A tab is on screen only when it is the active tab of the active space.
const isShown = (tab) => Boolean(tab?.active && tab.spaceId === activeSpace()?.id);

const SETTINGS_KEY = "linear-projects.settings"; // { "<project id>": { maxAgents, pollMinutes, paused } }
const DEFAULT_SETTINGS = { maxAgents: 3, pollMinutes: 0, paused: false, repo: null }; // repo null: the space's repo
const POLL_STEPS = [0, 1, 2, 5, 10, 15, 30, 60, 90, 120]; // minutes; 0 is off
const MAX_AGENTS_LIMIT = 10;
const POLL_CHECK_MS = 15000;

const settingsFor = (projectId) => ({ ...DEFAULT_SETTINGS, ...(shared(SETTINGS_KEY) ?? {})[projectId] });

function saveSettings(projectId, change) {
  const all = shared(SETTINGS_KEY) ?? {};
  setShared(SETTINGS_KEY, { ...all, [projectId]: { ...settingsFor(projectId), ...change } });
}

function stepPoll(minutes, direction) {
  const index = Math.max(0, POLL_STEPS.indexOf(minutes));
  return POLL_STEPS[Math.min(POLL_STEPS.length - 1, Math.max(0, index + direction))];
}

function pollLabel(minutes) {
  if (!minutes) return "Off";
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  if (!hours) return `${rest}m`;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

// Optional ~/.config/herdr-app/linear-projects.json: { "codeDir": "Code", "defaultRepo": "calendar" }.
// codeDir is under the home folder and holds the repos the repo menu lists. defaultRepo is the repo
// "Create space" uses when the project has none; without it, the project must pick a repo first.
const CONFIG_FILE = "linear-projects.json";
const config = { codeDir: "Code", defaultRepo: null };

async function loadConfig() {
  const text = await readTextFile(`${appHome()}/${CONFIG_FILE}`).catch(() => null);
  if (text == null) return;
  let raw;
  try { raw = JSON.parse(text); } catch { throw new Error(`${CONFIG_FILE} is not valid JSON`); }
  if (typeof raw?.codeDir === "string" && raw.codeDir.trim()) config.codeDir = raw.codeDir.trim().replace(/^~\//, "").replace(/\/+$/, "");
  if (typeof raw?.defaultRepo === "string" && raw.defaultRepo.trim()) config.defaultRepo = raw.defaultRepo.trim();
}

const codeDir = () => (config.codeDir.startsWith("/") ? config.codeDir : `${home()}/${config.codeDir}`);
const repoPath = (name) => `${codeDir()}/${name}`;
const REPO_ROW = 24, REPO_LIST_MAX_ROWS = 10;
const ISSUE_REPOS_KEY = "linear-projects.issue-repos"; // { "<issue identifier>": "<repo name>" }

// `target` is { kind: "project" | "issue", id }; a null repo clears the choice.
function saveRepo(target, repo) {
  if (target.kind === "issue") {
    const { [target.id]: _old, ...rest } = shared(ISSUE_REPOS_KEY) ?? {};
    setShared(ISSUE_REPOS_KEY, repo ? { ...rest, [target.id]: repo } : rest);
  } else saveSettings(target.id, { repo });
}

const sleep = (seconds) => exec("sleep", [String(seconds)]);

// A project's home folder in a repo: a worktree named after the project, detached at origin/HEAD.
const projectWorktree = (repo, project) => `${home()}/.herdr/worktrees/${repo}/${worktreeSlug(project.name).toLowerCase()}`;

async function ensureProjectWorktree(repo, project) {
  const folder = projectWorktree(repo, project), main = repoPath(repo);
  await git(main, ["fetch", "origin"], 120000);
  if (!parseWorktrees(await git(main, ["worktree", "list", "--porcelain"])).some((w) => w.path === folder)) {
    await git(main, ["worktree", "add", "--detach", folder, "origin/HEAD"], 120000);
  }
  return folder;
}

// The repo that a folder is a checkout or worktree of, for example "calendar"; null outside git.
async function repoNameOf(folder) {
  const listed = await exec("git", ["-C", folder, "worktree", "list", "--porcelain"]).catch(() => null);
  const main = listed?.code === 0 ? parseWorktrees(listed.stdout)[0] : null;
  return main ? main.path.split("/").pop() : null;
}

async function listRepos() {
  const r = await exec("find", [codeDir(), "-mindepth", "2", "-maxdepth", "2", "-name", ".git", "-type", "d"]);
  return r.stdout.split("\n").filter(Boolean).map((p) => p.replace(/\/\.git$/, "").split("/").pop())
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}
const AGENT_BUSY = ["working", "blocked"];

async function git(cwd, args, timeout = 30000) {
  const r = await exec("git", ["-C", cwd, ...args], { timeout });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout || `git ${args[0]} failed`).trim());
  return r.stdout;
}

// Reuses a worktree that is already on the branch. Else adds one from the local branch, or a new branch
// from origin/HEAD.
async function ensureWorktree(folder, branch) {
  const worktrees = parseWorktrees(await git(folder, ["worktree", "list", "--porcelain"]));
  const existing = worktrees.find((w) => w.branch === branch);
  if (existing) return existing.path;
  const main = worktrees[0].path;
  const path = `${home()}/.herdr/worktrees/${main.split("/").pop()}/${worktreeSlug(branch)}`;
  const local = await exec("git", ["-C", main, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  if (local.code === 0) await git(main, ["worktree", "add", path, branch], 120000);
  else {
    await git(main, ["fetch", "origin"], 120000);
    await git(main, ["worktree", "add", "-b", branch, path, "origin/HEAD"], 120000);
  }
  return path;
}

const COLLAPSED_KEY ="collapsed-issue-groups"; // ["<project id>:<status type>", …]

// localStorage can be empty or unavailable; the groups then all start open.
function loadCollapsed() {
  try { return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]")); } catch { return new Set(); }
}

function saveCollapsed(types) {
  try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...types])); } catch { /* the choice lasts until reload */ }
}

async function allPages(apiKey, query, variables, connectionOf) {
  const nodes = [];
  let after = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const connection = connectionOf(await gql(apiKey, query, { ...variables, after }));
    nodes.push(...(connection?.nodes ?? []));
    if (!connection?.pageInfo?.hasNextPage) break;
    after = connection.pageInfo.endCursor;
  }
  return nodes;
}

export default class LinearProjects extends View {
  init(_props, cx) {
    if (props()?.dialog === "status") { this.menu = new StatusMenu(); return; }
    this.projects = []; this.projectsLoaded = false;
    this.issuesByProject = new Map(); this.issueByIdent = new Map(); this.teamStates = new Map();
    this.assigning = new Set(); // issue ids
    this.creatingSpace = new Set(); // project ids
    this.polling = new Set(); // project ids
    this.firstPoll = new Set(); // project ids whose new space gets a poll once it appears
    this.starting = new Set(); // issue identifiers
    this.repos = null; this.reposError = null; // null: not loaded yet
    // install.sh copies the repo's VERSION file into the mod's folder.
    cx.spawn(async (cx) => {
      const text = await readTextFile(`${appHome()}/mods/linear-projects/VERSION`).catch(() => null);
      this.version = text?.trim() || null;
      cx.notify();
    });
    cx.spawn(async (cx) => {
      try { await loadConfig(); } catch (e) { notify({ title: "Linear Projects settings", body: String(e.message ?? e), level: "error" }); }
      this.loadRepos(cx);
    });
    this.spaceRepos = new Map(); // space id -> repo name, or null while it loads
    this.repoPicker = null; // { target, current, fallback }
    this.repoFilter = InputState.new({ placeholder: "Filter repos" });
    this.repoFilter.on("change", (_e, cx) => cx.notify());
    this.repoFilter.on("submit", () => { const first = this.repoMatches()[0]; if (first) this.pickRepo(first); });
    this.editing = null; // { ident, field: "title" | "description", saving }
    this.titleInput = InputState.new({ placeholder: "Title" });
    this.titleInput.on("submit", (_e, cx) => this.saveEdit(cx));
    this.descriptionInput = TextareaState.new({ placeholder: "Description (Markdown)" });
    this.descriptionInput.set_auto_grow(6, 30);
    this.view = { kind: "list" }; this.followKey = null; this.pageGeneration = 0;
    this.leadOnly = true; this.showAll = false; this.mineOnly = false;
    this.collapsed = loadCollapsed();
    this.polls = new Map(); // project id -> { at, result }; the clock starts when the mod loads
    cx.timer.every(POLL_CHECK_MS, (cx) => { this.pollDueProjects(cx); if (this.view.kind === "project") cx.notify(); });
    this.refreshProjects(cx);
    cx.timer.every(PROJECTS_REFRESH_MS, (cx) => this.refreshProjects(cx));
    cx.spawn(async (cx) => {
      for (;;) {
        if (await nextCommand() === "refresh") { this.refreshProjects(cx); this.loadPage(cx); }
        cx.notify();
      }
    });
  }

  refreshProjects(cx, manual = false) {
    this.loadingProjects = true; this.manual = manual;
    cx.spawn(async (cx) => {
      try {
        this.apiKey = await loadApiKey();
        const viewer = (await gql(this.apiKey, VIEWER_QUERY)).viewer;
        this.viewerId = viewer.id;
        const perTeam = await Promise.all(viewer.teams.nodes.map((team) =>
          allPages(this.apiKey, TEAM_PROJECTS_QUERY, { team: team.id }, (d) => d.team.projects)));
        const unique = new Map(perTeam.flat().map((n) => [n.id, parseProject(n)]));
        this.projects = [...unique.values()].sort(byName);
        this.error = null;
      } catch (e) { this.error = String(e.message ?? e); }
      finally { this.loadingProjects = false; this.projectsLoaded = true; cx.notify(); }
    });
    if (manual) cx.notify();
  }

  // Follows Herdr: a space or tab switch picks the view. Runs again once the project list first
  // arrives, because a space can only match a project after that.
  loadRepos(cx) {
    cx.spawn(async (cx) => {
      try { this.repos = await listRepos(); this.reposError = null; }
      catch (e) { this.repos ??= []; this.reposError = String(e.message ?? e); }
      cx.notify();
    });
  }

  // The name of the repo that a space's folder is a worktree of, for example "calendar".
  spaceRepo(space, cx) {
    if (!space) return null;
    if (!this.spaceRepos.has(space.id)) {
      this.spaceRepos.set(space.id, null);
      cx.spawn(async (cx) => {
        const listed = await exec("git", ["-C", space.folder, "worktree", "list", "--porcelain"]).catch(() => null);
        const main = listed?.code === 0 ? parseWorktrees(listed.stdout)[0] : null;
        this.spaceRepos.set(space.id, main ? main.path.split("/").pop() : "not a git repo");
        cx.notify();
      });
    }
    return this.spaceRepos.get(space.id);
  }

  follow(cx) {
    const space = activeSpace(), tab = activeTab(space);
    const key = `${space?.id}:${tab?.id}:${this.projectsLoaded}`;
    if (key === this.followKey) return;
    this.followKey = key;
    const ident = identifierOf(tab), projectId = projectIdForSpace(space, this.projects, links());
    if (ident) this.show({ kind: "issue", ident }, cx);
    else if (projectId) this.show({ kind: "project", id: projectId }, cx);
    else this.show({ kind: "list" }, cx);
  }

  // Safe during render: the caller draws the new view, so it does not ask for a re-render.
  show(view, cx) {
    this.view = view; this.pageError = null; this.editing = null; this.repoPicker = null;
    this.loadPage(cx);
  }

  go(view, cx) {
    this.show(view, cx);
    cx.notify();
  }

  // Cached data shows at once; this replaces it when the new data arrives.
  loadPage(cx) {
    const view = this.view, generation = ++this.pageGeneration;
    if (view.kind === "list") return;
    this.loadingPage = true;
    cx.spawn(async (cx) => {
      try {
        this.apiKey ??= await loadApiKey();
        if (view.kind === "project") {
          const nodes = await allPages(this.apiKey, PROJECT_ISSUES_QUERY, { id: view.id }, (d) => d.project.issues);
          this.issuesByProject.set(view.id, nodes.map(parseIssue));
        } else {
          const data = await gql(this.apiKey, ISSUE_QUERY, { id: view.ident });
          if (!data.issue) throw new Error(`${view.ident} not found in Linear`);
          this.issueByIdent.set(view.ident, parseIssue(data.issue));
        }
        if (generation === this.pageGeneration) this.pageError = null;
      } catch (e) { if (generation === this.pageGeneration) this.pageError = String(e.message ?? e); }
      finally { if (generation === this.pageGeneration) this.loadingPage = false; cx.notify(); }
    });
  }

  statesFor(teamId) {
    let states = this.teamStates.get(teamId);
    if (!states) {
      states = gql(this.apiKey, TEAM_STATES_QUERY, { id: teamId }).then((d) => sortStates(d.team.states.nodes));
      states.catch(() => this.teamStates.delete(teamId));
      this.teamStates.set(teamId, states);
    }
    return states;
  }

  openStatusMenu(issue, cx) {
    cx.spawn(async (cx) => {
      try {
        const states = await this.statesFor(issue.teamId);
        openOverlay({ mod: "linear-projects", kind: "popup", at: "pointer", width: STATUS_MENU_WIDTH, height: statusMenuHeight(states),
          props: { dialog: "status", issueId: issue.id, current: issue.state, states } });
      } catch (e) { this.pageError = String(e.message ?? e); cx.notify(); }
    });
  }

  spacesByProject() {
    const allLinks = links(), result = new Map();
    for (const s of spaces()) {
      const id = projectIdForSpace(s, this.projects, allLinks);
      if (id && !result.has(id)) result.set(id, s);
    }
    return result;
  }

  // The project's own space, then the spaces it got in other repos (their folder is a project worktree).
  projectSpaces(projectId) {
    const main = this.spacesByProject().get(projectId), project = this.projects.find((p) => p.id === projectId);
    if (!project) return main ? [main] : [];
    const suffix = `/${worktreeSlug(project.name).toLowerCase()}`, root = `${home()}/.herdr/worktrees/`;
    const others = spaces().filter((s) => s !== main && s.id !== main?.id && s.folder?.startsWith(root) && s.folder.endsWith(suffix));
    return main ? [main, ...others] : others;
  }

  pollClock(projectId) {
    if (!this.polls.has(projectId)) this.polls.set(projectId, { at: Date.now(), result: null });
    return this.polls.get(projectId);
  }

  pollDueProjects(cx) {
    const now = Date.now();
    for (const [projectId] of this.spacesByProject()) {
      const { pollMinutes, paused } = settingsFor(projectId);
      if (this.firstPoll.delete(projectId)) this.poll(projectId, cx);
      else if (!paused && pollMinutes && now - this.pollClock(projectId).at >= pollMinutes * 60000) this.poll(projectId, cx);
    }
  }

  // Resume polls at once, so the Orchestrator catches up on what changed while it was paused.
  togglePause(projectId, cx) {
    const paused = !settingsFor(projectId).paused;
    saveSettings(projectId, { paused });
    if (!paused) this.poll(projectId, cx);
    cx.notify();
  }

  // Every poll restarts the clock, also one that is skipped.
  poll(projectId, cx) {
    const clock = { at: Date.now(), result: "polling…" };
    this.polls.set(projectId, clock);
    const space = this.spacesByProject().get(projectId);
    if (!space) clock.result = "skipped: no space";
    else if (this.polling.has(projectId)) clock.result = "skipped: a poll is still running";
    if (!space || this.polling.has(projectId)) return cx.notify();
    this.polling.add(projectId);
    cx.spawn(async (cx) => {
      try { clock.result = await this.runPoll(projectId, space); }
      catch (e) { clock.result = `failed: ${e.message ?? e}`; }
      finally { this.polling.delete(projectId); cx.notify(); }
    });
    cx.notify();
  }

  async runPoll(projectId, space) {
    this.apiKey ??= await loadApiKey();
    if (!this.viewerId) throw new Error("your Linear user is not loaded yet");
    const { maxAgents } = settingsFor(projectId);
    const issues = (await allPages(this.apiKey, PROJECT_ISSUES_QUERY, { id: projectId }, (d) => d.project.issues)).map(parseIssue);
    this.issuesByProject.set(projectId, issues);

    const openIdents = new Set(issues.map((i) => i.identifier)), projectSpaces = this.projectSpaces(projectId);
    const tabs = projectSpaces.flatMap((s) => issueTabs(s).map((t) => ({ ...t, space: s }))), cleaned = [];
    for (const { tab, ident, space: tabSpace } of tabs.filter((t) => !openIdents.has(t.ident))) {
      const issue = (await gql(this.apiKey, ISSUE_STATE_QUERY, { id: ident }).catch(() => null))?.issue;
      if (!issue || !CLOSED_STATE_TYPES.includes(issue.state.type)) continue;
      const agent = agents().find((a) => a.tab === tab.id);
      if (agent && AGENT_BUSY.includes(agent.status)) continue; // try again at the next poll
      await this.cleanUp(tabSpace, tab, issue.branchName);
      cleaned.push(ident);
    }

    const openTabs = tabs.length - cleaned.length;
    const tabIdents = new Set(spaces().flatMap((s) => s.tabs.map(identifierOf)).filter(Boolean));
    const picks = readyIssues(issues, { assigneeId: this.viewerId, tabIdents }).slice(0, Math.max(0, maxAgents - openTabs));
    const started = [];
    for (const issue of picks) {
      try { await this.startIssue(issue, space, projectId); started.push(issue.identifier); }
      catch (e) { notify({ title: `Could not start ${issue.identifier}`, body: String(e.message ?? e), level: "error" }); }
    }
    return [
      `${openTabs + started.length}/${maxAgents} agents`,
      started.length && `started ${started.join(", ")}`,
      cleaned.length && `cleaned up ${cleaned.join(", ")}`,
    ].filter(Boolean).join(" · ");
  }

  // Closing the tab also ends its terminals, so a `box worktree server` there stops first. The local
  // branch stays: it holds any commits that are not pushed.
  // An agent can move its issue to another repo, so this looks in every repo for worktrees on the branch.
  async cleanUp(space, tab, branch) {
    run("tab.close", { id: tab.id, confirmed: true });
    if (!branch) return;
    const removed = new Set();
    for (const folder of [space.folder, ...this.repos.map(repoPath)]) {
      const listed = await exec("git", ["-C", folder, "worktree", "list", "--porcelain"]).catch(() => null);
      if (listed?.code !== 0) continue;
      const [main, ...worktrees] = parseWorktrees(listed.stdout);
      for (const w of worktrees.filter((w) => w.branch === branch && !removed.has(w.path))) {
        await git(main.path, ["worktree", "remove", "--force", w.path]);
        removed.add(w.path);
      }
    }
  }

  // The issue's own choice, else the project's, else null for the space's repo.
  repoFor(ident, projectId) {
    return (shared(ISSUE_REPOS_KEY) ?? {})[ident] ?? (projectId && settingsFor(projectId).repo) ?? null;
  }

  // An issue whose repo is not the project space's repo starts in the project's space for that repo,
  // which this makes on first use.
  async startIssue(issue, space, projectId = issue.projectId ?? projectIdForSpace(space, this.projects, links())) {
    this.starting.add(issue.identifier);
    try {
      const project = this.projects.find((p) => p.id === projectId);
      const repo = this.repoFor(issue.identifier, projectId);
      const spaceRepo = space ? await repoNameOf(space.folder) : null;
      const otherRepo = Boolean(repo && project && repo !== spaceRepo);
      const base = repo ? repoPath(repo) : space?.folder;
      if (!base) throw new Error("the project has no space; create one first");
      const folder = issue.branchName ? await ensureWorktree(base, issue.branchName) : base;
      const full = parseIssue((await gql(this.apiKey, ISSUE_QUERY, { id: issue.identifier })).issue);
      const tab = { name: issue.identifier, folder, argv: ["claude"], task: startTask(full) };
      if (otherRepo) await this.startInRepoSpace(project, repo, tab);
      else run("tab.new", { ...tab, space: space.id });
    } finally { this.starting.delete(issue.identifier); }
  }

  // Herdr nests a space under the repo of its first terminal, so a new space keeps only the issue tab:
  // the shell tab that space.new makes is closed once the issue tab is there.
  async startInRepoSpace(project, repo, tab) {
    const folder = await ensureProjectWorktree(repo, project);
    const existing = spaces().find((s) => s.folder === folder);
    if (existing) return run("tab.new", { ...tab, space: existing.id });
    run("space.new", { name: worktreeSlug(project.name).toLowerCase(), folder });
    let space = null;
    for (let i = 0; i < 40 && !space; i++) { await sleep(0.25); space = spaces().find((s) => s.folder === folder); }
    if (!space) throw new Error(`Herdr did not open the new space for ${repo}`);
    const shellTabs = space.tabs.map((t) => t.id);
    run("tab.new", { ...tab, space: space.id });
    for (let i = 0; i < 40; i++) {
      const now = spaces().find((s) => s.id === space.id);
      if (now?.tabs.some((t) => identifierOf(t) === tab.name)) {
        for (const id of shellTabs) run("tab.close", { id, confirmed: true });
        return;
      }
      await sleep(0.25);
    }
  }

  // `me` false unassigns the issue.
  assignToMe(issue, cx, me = true) {
    if (this.assigning.has(issue.id)) return;
    this.assigning.add(issue.id);
    cx.spawn(async (cx) => {
      try {
        const data = me
          ? await gql(this.apiKey, ASSIGN, { id: issue.id, assigneeId: this.viewerId })
          : await gql(this.apiKey, UNASSIGN, { id: issue.id });
        if (!data.issueUpdate.success) throw new Error(`Linear did not ${me ? "assign" : "unassign"} the issue`);
        issue.assigneeId = me ? this.viewerId : null;
        issue.assigneeName = me ? "You" : null;
        this.loadPage(cx);
      } catch (e) { notify({ title: `Could not ${me ? "assign" : "unassign"} ${issue.identifier}`, body: String(e.message ?? e), level: "error" }); }
      finally { this.assigning.delete(issue.id); cx.notify(); }
    });
    cx.notify();
  }

  assignAndStart(issue, space, cx) {
    if (this.starting.has(issue.identifier)) return;
    this.starting.add(issue.identifier);
    cx.spawn(async (cx) => {
      try {
        const data = await gql(this.apiKey, ASSIGN, { id: issue.id, assigneeId: this.viewerId });
        if (!data.issueUpdate.success) throw new Error("Linear did not assign the issue");
        issue.assigneeId = this.viewerId;
        this.starting.delete(issue.identifier);
        await this.startIssue(issue, space);
      } catch (e) { notify({ title: `Could not start ${issue.identifier}`, body: String(e.message ?? e), level: "error" }); }
      finally { this.starting.delete(issue.identifier); this.loadPage(cx); cx.notify(); }
    });
    cx.notify();
  }

  // Shown only when slots are free and none of your own issues is ready, so the next poll would start nothing.
  pickupSection(projectId, issues, t) {
    const space = this.spacesByProject().get(projectId);
    if (!space || !issues || !this.viewerId) return null;
    const free = settingsFor(projectId).maxAgents - this.projectSpaces(projectId).flatMap(issueTabs).length;
    const tabIdents = new Set(spaces().flatMap((s) => s.tabs.map(identifierOf)).filter(Boolean));
    if (free <= 0 || readyIssues(issues, { assigneeId: this.viewerId, tabIdents }).length) return null;
    const unassigned = readyIssues(issues, { assigneeId: null, tabIdents });
    if (!unassigned.length) return null;
    return v_flex().flex_none().px(10).py(7).gap(4).border_b(1).border_color(t.border).text_size(11)
      .child(div().font_semibold().text_color(t.muted)
        .child(`Ready to pick up · ${unassigned.length} unassigned · ${free} free ${free === 1 ? "slot" : "slots"}`))
      .children(unassigned.slice(0, 5).map((issue) => h_flex().id(`pickup-${issue.id}`).gap(8).items_center()
        .child(div().flex_none().text_color(t.accent).child(issue.identifier))
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(issue.title))
        .child(this.button(`pickup-start-${issue.id}`, this.starting.has(issue.identifier) ? "Starting…" : "Assign & start",
          (cx) => this.assignAndStart(issue, space, cx), t, { accent: true }))));
  }

  // The page can show a project from another space, so this looks in every space, the active one first.
  tabFor(ident) {
    const all = spaces(), active = all.find((s) => s.active);
    for (const space of active ? [active, ...all.filter((s) => s !== active)] : all) {
      const tab = space.tabs.find((t) => identifierOf(t) === ident);
      if (tab) return { ...tab, spaceId: space.id };
    }
    return null;
  }

  startTab(issue, cx) {
    const existing = this.tabFor(issue.identifier);
    if (existing) {
      run("space.select", { id: existing.spaceId });
      return run("tab.select", { id: existing.id });
    }
    const projectId = issue.projectId ?? (this.view.kind === "project" ? this.view.id : projectIdForSpace(activeSpace(), this.projects, links()));
    const space = (projectId && this.spacesByProject().get(projectId)) ?? null;
    if (this.starting.has(issue.identifier)) return;
    cx.spawn(async (cx) => {
      try { await this.startIssue(issue, space, projectId); }
      catch (e) { notify({ title: `Could not start ${issue.identifier}`, body: String(e.message ?? e), level: "error" }); }
      cx.notify();
    });
    cx.notify();
  }

  startLabel(issue, tab) {
    return tab ? "Open" : this.starting.has(issue.identifier) ? "Starting…" : "Start";
  }

  // The space's worktree is detached at origin/main: it is only the space's home folder, and each issue
  // gets its own worktree and branch. The space takes the project's name, so the name match finds it; a
  // mod's run() does not return the new space's ID.
  createSpace(project, cx) {
    if (this.creatingSpace.has(project.id)) return;
    this.creatingSpace.add(project.id);
    cx.spawn(async (cx) => {
      try {
        const repo = settingsFor(project.id).repo ?? config.defaultRepo;
        if (!repo) throw new Error("Pick a repo for this project first (Agents › Repo)");
        const folder = await ensureProjectWorktree(repo, project);
        run("space.new", { name: project.name, folder });
        this.firstPoll.add(project.id);
      } catch (e) {
        notify({ title: `Could not create a space for ${project.name}`, body: String(e.message ?? e), level: "error" });
      } finally { this.creatingSpace.delete(project.id); cx.notify(); }
    });
    cx.notify();
  }

  toggleLink(projectId) {
    const space = activeSpace();
    if (!space) return;
    const { [space.id]: current, ...rest } = links();
    setShared(LINKS_KEY, current === projectId ? rest : { ...rest, [space.id]: projectId });
  }

  button(id, label, onClick, t, { accent = false } = {}) {
    return div().id(id).flex_none().px(7).h(22).flex().items_center().rounded(6).text_size(11).border_1().cursor_pointer()
      .when(accent, (e) => e.bg(t.accent).border_color(t.accent).text_color(t.accent_foreground).hover((s) => s.opacity(0.85)))
      .when(!accent, (e) => e.text_color(t.muted).border_color(t.border).hover((s) => s.bg(t.raised).text_color(t.foreground)))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); }).child(label);
  }

  chip(id, label, on, onClick, t) {
    return h_flex().id(id).h(24).px(8).flex_none().items_center().rounded(6).cursor_pointer().text_size(11)
      .bg(on ? t.selected : t.raised).text_color(on ? t.foreground : t.muted)
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { onClick(); cx.notify(); }).child(label);
  }

  dot(color, t) { return div().size(7).flex_none().rounded_full().bg(color ?? t.dim); }

  groupHeading(label, count, t) {
    return div().px(10).pt(8).pb(2).text_size(11).font_semibold().text_color(t.muted).child(`${label} · ${count}`);
  }

  stepper(id, label, value, onStep, t) {
    const arrow = (dir, glyph) => div().id(`${id}-${dir > 0 ? "up" : "down"}`).size(20).flex().flex_none().items_center().justify_center()
      .rounded(4).cursor_pointer().text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click(() => onStep(dir)).child(glyph);
    return h_flex().flex_none().gap(4).items_center()
      .child(div().text_color(t.muted).child(label))
      .child(h_flex().items_center().rounded(5).border_1().border_color(t.border)
        .child(arrow(-1, "−")).child(div().min_w(28).flex().justify_center().text_color(t.foreground).child(value)).child(arrow(1, "+")));
  }

  orchestratorSettings(projectId, t, cx) {
    const { maxAgents, pollMinutes, paused } = settingsFor(projectId), clock = this.pollClock(projectId);
    const last = clock.result ? `Last poll ${ago(new Date(clock.at).toISOString())} ago: ${clock.result}` : "No poll yet";
    const nextMinutes = Math.max(0, Math.ceil((clock.at + pollMinutes * 60000 - Date.now()) / 60000));
    const status = paused ? `Paused · ${last}` : pollMinutes ? `${last} · next in ${nextMinutes ? pollLabel(nextMinutes) : "<1m"}` : last;
    // Two boxes: what agents run with, and when the polls run. The poll status sits in the polling box.
    return v_flex().flex_none().px(10).py(7).gap(6).border_b(1).border_color(t.border).text_size(11)
      .child(this.settingsGroup("agent-settings", "Agents", t, h_flex().flex_wrap().gap_x(10).gap_y(5).items_center()
        .child(this.stepper("max-agents", "Max", String(maxAgents),
          (dir) => saveSettings(projectId, { maxAgents: Math.min(MAX_AGENTS_LIMIT, Math.max(1, maxAgents + dir)) }), t))
        .child(this.projectRepoChip(projectId, t, cx)))
        .children([this.repoPickerView("project", t)].filter(Boolean)))
      .child(this.settingsGroup("poll-settings", "Polling", t, v_flex().gap(5)
        .child(h_flex().flex_wrap().gap_x(10).gap_y(5).items_center()
          .child(this.stepper("poll-every", "Every", pollLabel(pollMinutes),
            (dir) => saveSettings(projectId, { pollMinutes: stepPoll(pollMinutes, dir) }), t))
          .child(div().flex_1())
          .child(this.button("pause", paused ? "▶ Resume" : "❚❚ Pause", (cx) => this.togglePause(projectId, cx), t, { accent: paused }))
          .child(this.button("poll-now", "Poll now", (cx) => this.poll(projectId, cx), t)))
        .child(div().truncate().text_color(clock.result?.startsWith("failed") ? t.ansi1 : t.dim).child(status))));
  }

  settingsGroup(id, title, t, body) {
    return v_flex().id(id).gap(5).px(8).pt(5).pb(7).rounded(7).border_1().border_color(t.border).bg(t.raised)
      .child(div().text_size(10).font_semibold().text_color(t.muted).child(title.toUpperCase()))
      .child(body);
  }

  milestoneHeading(group, statusType, t) {
    return h_flex().id(`milestone-${statusType}-${group.key}`).flex_none().px(10).pt(6).pb(1).gap(6).items_center().text_size(11)
      .child(div().flex_1().min_w(0).truncate().text_color(group.milestone ? t.muted : t.dim).child(group.milestone?.name ?? "No milestone"))
      .child(div().flex_none().text_color(t.dim).child(String(group.items.length)));
  }

  issueGroupHeader(group, key, t) {
    const open = !this.collapsed.has(key);
    return h_flex().id(`group-${group.type}`).flex_none().h(28).px(8).mt(4).gap(6).items_center().rounded(6).cursor_pointer()
      .bg(t.raised).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => {
        if (open) this.collapsed.add(key); else this.collapsed.delete(key);
        saveCollapsed(this.collapsed);
        cx.notify();
      })
      .child(div().w(10).flex_none().text_size(10).text_color(t.muted).child(open ? "▾" : "▸"))
      .child(this.dot(group.items[0]?.stateColor, t))
      .child(div().flex_1().text_size(12).font_semibold().text_color(t.foreground).child(group.label))
      .child(div().flex_none().px(6).rounded(4).bg(t.background).text_size(11).text_color(t.muted).child(String(group.items.length)));
  }

  message(text, t, error = false) {
    return div().p(10).text_size(12).whitespace_normal().text_color(error ? t.ansi1 : t.dim).child(text);
  }

  header(title, t, { back, subtitle, version } = {}) {
    return h_flex().h(42).flex_none().px(10).gap(8).items_center().border_b(1).border_color(t.border)
      .when(Boolean(back), (e) => e.child(div().id("back").px(6).h(26).flex().items_center().rounded(6).cursor_pointer()
        .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => back(cx)).child("‹ Back")))
      .child(h_flex().flex_1().min_w(0).gap(6).items_baseline()
        .child(div().min_w(0).truncate().font_semibold().child(title))
        .when(Boolean(version), (e) => e.child(div().flex_none().text_size(10).text_color(t.dim).child(`v${version}`))))
      .when(Boolean(subtitle), (e) => e.child(div().flex_none().text_size(11).text_color(t.dim).child(subtitle ?? "")))
      .child(div().id("refresh").size(26).flex().flex_none().items_center().justify_center().rounded(7).cursor_pointer()
        .text_color(t.muted).tooltip("Refresh").hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => { this.refreshProjects(cx, true); this.loadPage(cx); })
        .child(svg("mods/linear-projects/refresh.svg").size(13)
          .when((this.loadingProjects || this.loadingPage) && this.manual, (e) => e.spin(900))));
  }

  projectRow(project, t, spaceByProject) {
    const space = spaceByProject.get(project.id);
    const meta = [`${Math.round(project.progress * 100)}%`, shortDate(project.targetDate), !this.leadOnly && project.leadName]
      .filter(Boolean).join(" · ");
    return v_flex().id(`project-${project.id}`).flex_none().px(10).py(7).gap(3).rounded(7).cursor_pointer()
      .when(Boolean(space?.active), (e) => e.bg(t.selected))
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.go({ kind: "project", id: project.id }, cx))
      .child(h_flex().gap(8).items_center()
        .child(this.dot(project.statusColor, t))
        .child(div().flex_1().min_w(0).truncate().child(project.name))
        .when(Boolean(space), (e) => e.child(this.button(`space-${project.id}`, "Space", () => run("space.select", { id: space.id }), t))))
      .child(div().pl(15).text_size(11).text_color(t.dim).child(meta));
  }

  listPage(t) {
    const types = this.showAll ? PROJECT_GROUPS.map(([type]) => type) : ACTIVE_PROJECT_TYPES;
    const shown = this.projects.filter((p) => types.includes(p.statusType) && (!this.leadOnly || p.leadId === this.viewerId));
    const spaceByProject = this.spacesByProject();
    const groups = groupBy(shown, PROJECT_GROUPS, (p) => p.statusType);
    let body;
    if (this.error) body = this.message(this.error, t, true);
    else if (!this.projectsLoaded) body = this.message("Loading…", t);
    else if (!groups.length) body = this.message(this.leadOnly ? "You lead no projects here. Turn off Lead to see all." : "No projects", t);
    return v_flex().size_full().min_h(0)
      .child(this.header("Projects", t, { subtitle: this.projectsLoaded ? String(shown.length) : "", version: this.version }))
      .child(h_flex().flex_none().px(8).py(7).gap(6).border_b(1).border_color(t.border)
        .child(this.chip("filter-lead", "Lead", this.leadOnly, () => { this.leadOnly = !this.leadOnly; }, t))
        .child(this.chip("filter-all", "Show all", this.showAll, () => { this.showAll = !this.showAll; }, t)))
      .child(v_flex().id("project-list").flex_1().min_h(0).overflow_y_scrollbar().p(6).gap(2)
        .when(Boolean(body), (e) => e.child(body))
        .children(groups.flatMap((g) => [this.groupHeading(g.label, g.items.length, t), ...g.items.map((p) => this.projectRow(p, t, spaceByProject))])));
  }

  startEdit(issue, field, cx) {
    if (this.editing?.saving) return;
    const input = field === "title" ? this.titleInput : this.descriptionInput;
    input.set_value(issue[field] ?? "");
    input.focus();
    this.editing = { ident: issue.identifier, field, saving: false };
    cx.notify();
  }

  cancelEdit(cx) {
    if (this.editing?.saving) return;
    this.editing = null;
    cx.notify();
  }

  saveEdit(cx) {
    const edit = this.editing, issue = edit && this.issueByIdent.get(edit.ident);
    if (!issue || edit.saving) return;
    const value = (edit.field === "title" ? this.titleInput : this.descriptionInput).value();
    const next = edit.field === "title" ? value.trim() : value;
    if (edit.field === "title" && !next) return notify({ title: "A title cannot be empty", level: "error" });
    if (next === (issue[edit.field] ?? "")) return this.cancelEdit(cx);
    edit.saving = true;
    cx.spawn(async (cx) => {
      try {
        const data = await gql(this.apiKey, UPDATE_ISSUE, { id: issue.id, input: { [edit.field]: next } });
        if (!data.issueUpdate.success) throw new Error("Linear did not save the change");
        issue[edit.field] = next;
        for (const list of this.issuesByProject.values()) {
          const row = list.find((i) => i.id === issue.id);
          if (row) row[edit.field] = next;
        }
        if (this.editing === edit) this.editing = null;
      } catch (e) {
        edit.saving = false;
        notify({ title: `Could not save ${issue.identifier}`, body: String(e.message ?? e), level: "error" });
      }
      cx.notify();
    });
    cx.notify();
  }

  // Click to edit. While editing, the field shows the input with Save and Cancel; Enter also saves a title.
  editable(issue, field, view, t) {
    const edit = this.editing;
    if (edit?.ident === issue.identifier && edit.field === field) {
      const box = field === "title"
        ? Input.new(this.titleInput).h(30).text_size(15)
        : Textarea.new(this.descriptionInput).text_size(12.5);
      return v_flex().flex_none().gap(5)
        .child(div().id(`edit-${field}`).px(8).py(4).rounded(6).border_1().border_color(t.accent).bg(t.raised)
          .text_color(t.foreground).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(box))
        .child(h_flex().gap(6)
          .child(this.button(`save-${field}`, edit.saving ? "Saving…" : "Save", (cx) => this.saveEdit(cx), t, { accent: true }))
          .child(this.button(`cancel-${field}`, "Cancel", (cx) => this.cancelEdit(cx), t)));
    }
    return div().id(`view-${field}`).mx(-6).px(6).py(2).rounded(6).cursor_text().hover((s) => s.bg(t.raised))
      .tooltip(`Click to edit the ${field}`).on_click((_e, cx) => this.startEdit(issue, field, cx)).child(view);
  }

  assignButton(issue, t) {
    const mine = issue.assigneeId === this.viewerId;
    const label = this.assigning.has(issue.id) ? (mine ? "Unassigning…" : "Assigning…") : mine ? "Unassign me" : "Assign myself";
    return this.button(`assign-page-${issue.id}`, label, (cx) => this.assignToMe(issue, cx, !mine), t);
  }

  // A press outside closes the picker before the chip's click arrives, so a click on the chip just
  // after that close must not open the picker again: the chip toggles.
  closeRepoPicker(cx) {
    if (!this.repoPicker) return;
    this.repoPickerClosed = { kind: this.repoPicker.target.kind, id: this.repoPicker.target.id, at: Date.now() };
    this.repoPicker = null;
    cx.notify();
  }

  openRepoPicker(target, current, fallback, cx) {
    const closed = this.repoPickerClosed;
    if (closed?.kind === target.kind && closed.id === target.id && Date.now() - closed.at < 500) return;
    if (this.repoPicker?.target.kind === target.kind && this.repoPicker.target.id === target.id) {
      this.repoPicker = null;
      return cx.notify();
    }
    this.repoPicker = { target, current, fallback };
    this.repoFilter.set_value("");
    this.repoFilter.focus();
    this.loadRepos(cx);
    cx.notify();
  }

  repoMatches() {
    const filter = this.repoFilter.value().trim().toLowerCase();
    return (this.repos ?? []).filter((r) => r.toLowerCase().includes(filter));
  }

  pickRepo(repo) {
    saveRepo(this.repoPicker.target, repo);
    this.repoPicker = null;
  }

  // Opens in the panel under its chip. The first row clears the choice.
  repoPickerView(kind, t) {
    const picker = this.repoPicker;
    if (picker?.target.kind !== kind) return null;
    const filtering = Boolean(this.repoFilter.value().trim()), matches = this.repoMatches();
    const row = (id, label, checked, onClick, muted = false) => h_flex().id(id).h(REPO_ROW).px(8).gap(8).flex_none().items_center()
      .rounded(5).cursor_pointer().hover((s) => s.bg(t.selected)).on_click((_e, cx) => { onClick(); cx.notify(); })
      .child(div().flex_1().min_w(0).truncate().text_color(muted ? t.muted : t.foreground).child(label))
      .child(div().flex_none().text_color(t.muted).child(checked ? "✓" : ""));
    let note = null;
    if (this.repos == null) note = "Loading repos…";
    else if (this.reposError) note = `Could not list repos: ${this.reposError}`;
    else if (!this.repos.length) note = `No git repos in ${codeDir().replace(home(), "~")}`;
    else if (!matches.length) note = "No repo matches";
    return v_flex().id(`repo-picker-${kind}`).flex_none().gap(3).p(5).rounded(7).border_1().border_color(t.accent).bg(t.popover)
      .text_size(12).on_mouse_down_out((_e, cx) => this.closeRepoPicker(cx))
      .child(div().id(`repo-filter-${kind}`).flex_none().h(28).px(8).flex().items_center().rounded(5).border_1()
        .border_color(t.border).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(Input.new(this.repoFilter).h_full().text_size(12)))
      // A scroll area needs a set height: the box gets one, and the list fills it.
      .child(v_flex().flex_none().relative().h(Math.min(REPO_LIST_MAX_ROWS, matches.length + (filtering ? 0 : 1) + (note ? 1 : 0)) * REPO_ROW)
        .child(v_flex().id(`repo-list-${kind}`).size_full().overflow_y_scroll()
          .when(!filtering, (e) => e.child(row(`repo-default-${kind}`, `Default (${picker.fallback})`, !picker.current, () => this.pickRepo(null), true)))
          .children(matches.map((r) => row(`repo-${kind}-${r}`, r, r === picker.current, () => this.pickRepo(r))))
          .when(Boolean(note), (e) => e.child(div().h(REPO_ROW).flex_none().px(8).flex().items_center().text_size(11)
            .text_color(this.reposError ? t.ansi1 : t.dim).child(note ?? ""))))
        .child(Scrollbar.vertical(`repo-list-${kind}`).absolute().inset_0()));
  }

  // A chosen repo shows in full; the default shows with "default" after it.
  repoChip(id, current, fallback, onClick, t) {
    return h_flex().id(id).flex_none().h(22).px(6).gap(4).items_center().rounded(5).border_1().border_color(t.border)
      .cursor_pointer().text_size(11).hover((s) => s.bg(t.raised)).tooltip("Repo for new worktrees")
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); })
      .child(div().text_color(t.muted).child("Repo"))
      .child(div().text_color(t.foreground).child(current ?? fallback ?? "…"))
      .when(!current, (e) => e.child(div().text_color(t.dim).child("default")))
      .child(div().text_size(9).text_color(t.dim).child("▾"));
  }

  projectRepoFallback(projectId, cx) {
    const space = this.spacesByProject().get(projectId);
    return space ? this.spaceRepo(space, cx) : config.defaultRepo ?? "none";
  }

  projectRepoChip(projectId, t, cx) {
    const current = settingsFor(projectId).repo ?? null, fallback = this.projectRepoFallback(projectId, cx);
    return this.repoChip("project-repo", current, fallback,
      (cx) => this.openRepoPicker({ kind: "project", id: projectId }, current, fallback, cx), t);
  }

  issueRepoChip(issue, t, cx) {
    const projectId = issue.projectId ?? projectIdForSpace(activeSpace(), this.projects, links());
    const current = (shared(ISSUE_REPOS_KEY) ?? {})[issue.identifier] ?? null;
    const fallback = (projectId && settingsFor(projectId).repo) || (projectId ? this.projectRepoFallback(projectId, cx) : this.spaceRepo(activeSpace(), cx));
    return this.repoChip("issue-repo", current, fallback,
      (cx) => this.openRepoPicker({ kind: "issue", id: issue.identifier }, current, fallback, cx), t);
  }

  blockedIcon(issue, t) {
    if (!issue.blockedBy.length) return null;
    return div().id(`blocked-${issue.id}`).text_color(t.ansi1).tooltip(`Blocked by ${issue.blockedBy.join(", ")}`).child("⊘");
  }

  statusChip(issue, t) {
    return h_flex().id(`status-${issue.id}`).flex_none().gap(5).items_center().rounded(4).cursor_pointer()
      .hover((s) => s.bg(t.raised)).tooltip("Change status")
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); this.openStatusMenu(issue, cx); })
      .border_1().border_color(t.border).px(5)
      .child(this.dot(issue.stateColor, t)).child(div().text_color(t.muted).child(issue.state))
      .child(div().text_size(9).text_color(t.dim).child("▾"));
  }

  issueRow(issue, t) {
    const tab = this.tabFor(issue.identifier);
    return v_flex().id(`issue-${issue.id}`).flex_none().px(10).py(7).gap(3).rounded(7).cursor_pointer()
      .when(isShown(tab), (e) => e.bg(t.selected))
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.go({ kind: "issue", ident: issue.identifier }, cx))
      .child(h_flex().gap(8).items_start()
        .child(h_flex().flex_none().pt(1).gap(4).items_center().text_size(11)
          .child(div().text_color(t.accent).child(issue.identifier)).children([this.blockedIcon(issue, t)].filter(Boolean)))
        .child(div().flex_1().min_w(0).whitespace_normal().child(issue.title))
        .child(this.button(`tab-${issue.id}`, this.startLabel(issue, tab), (cx) => this.startTab(issue, cx), t, { accent: !tab })))
      .child(h_flex().gap(8).items_center().text_size(11).text_color(t.dim)
        .child(this.statusChip(issue, t))
        .child(div().flex_1())
        .child(div().flex_none().child(issue.assigneeId === this.viewerId ? "You" : issue.assigneeName ?? "Unassigned"))
        .when(Boolean(this.viewerId) && issue.assigneeId !== this.viewerId, (e) => e.child(
          this.button(`assign-${issue.id}`, this.assigning.has(issue.id) ? "Assigning…" : "Assign myself", (cx) => this.assignToMe(issue, cx), t))));
  }

  projectPage(t, cx) {
    const id = this.view.id, project = this.projects.find((p) => p.id === id);
    const issues = this.issuesByProject.get(id);
    const shown = (issues ?? []).filter((i) => !this.mineOnly || i.assigneeId === this.viewerId);
    const groups = groupBy(shown, ISSUE_GROUPS, (i) => i.stateType);
    const space = activeSpace(), linked = space && links()[space.id] === id;
    const nameMatch = !linked && projectIdForSpace(space, this.projects, {}) === id;
    let body;
    if (this.pageError) body = this.message(this.pageError, t, true);
    else if (!issues) body = this.message("Loading…", t);
    else if (!groups.length) body = this.message(this.mineOnly ? "No open issues assigned to you" : "No open issues", t);
    return v_flex().size_full().min_h(0)
      .child(this.header(project?.name ?? "Project", t, { back: (cx) => this.go({ kind: "list" }, cx) }))
      .child(h_flex().flex_none().px(10).py(7).gap(6).items_center().border_b(1).border_color(t.border).text_size(11)
        .when(Boolean(project), (e) => e.child(this.dot(project?.statusColor, t))
          .child(div().text_color(t.muted).child(`${project?.status ?? ""} · ${Math.round((project?.progress ?? 0) * 100)}%`)))
        .child(div().flex_1())
        .child(this.chip("filter-mine", "Mine", this.mineOnly, () => { this.mineOnly = !this.mineOnly; }, t))
        .when(Boolean(project) && !this.spacesByProject().has(id), (e) => e.child(this.button("create-space",
          this.creatingSpace.has(id) ? "Creating…" : "Create space", (cx) => this.createSpace(project, cx), t, { accent: true })))
        .when(Boolean(space) && !nameMatch, (e) => e.child(this.button("link", linked ? "Unlink" : "Link to this space", () => this.toggleLink(id), t)))
        .when(Boolean(project?.url), (e) => e.child(this.button("open-project", "Open in Linear", () => openUrl(project.url), t))))
      .child(this.orchestratorSettings(id, t, cx))
      .children([this.pickupSection(id, issues, t)].filter(Boolean))
      .child(v_flex().id("issue-list").flex_1().min_h(0).overflow_y_scrollbar().p(6).gap(2)
        .when(Boolean(body), (e) => e.child(body))
        .children(groups.flatMap((g) => {
          const key = `${id}:${g.type}`;
          if (this.collapsed.has(key)) return [this.issueGroupHeader(g, key, t)];
          return [this.issueGroupHeader(g, key, t), ...milestoneGroups(g.items).flatMap((m) =>
            [this.milestoneHeading(m, g.type, t), ...m.items.map((i) => this.issueRow(i, t))])];
        })));
  }

  issueBack(issue, cx) {
    const projectId = issue?.projectId ?? projectIdForSpace(activeSpace(), this.projects, links());
    this.go(projectId ? { kind: "project", id: projectId } : { kind: "list" }, cx);
  }

  comment(c, t) {
    return v_flex().flex_none().gap(3).py(7).border_t(1).border_color(t.border)
      .child(h_flex().gap(6).text_size(11)
        .child(div().font_semibold().text_color(t.foreground).child(c.author))
        .child(div().text_color(t.dim).child(`${ago(c.createdAt)} ago`)))
      .child(div().whitespace_normal().text_size(12.5).text_color(t.foreground).child(c.body));
  }

  issuePage(t, cx) {
    const ident = this.view.ident, issue = this.issueByIdent.get(ident);
    const header = this.header(ident, t, { back: (cx) => this.issueBack(issue, cx) });
    if (!issue) return v_flex().size_full().min_h(0).child(header)
      .child(this.pageError ? this.message(this.pageError, t, true) : this.message("Loading…", t));
    const tab = this.tabFor(ident);
    const facts = [issue.assigneeName ?? "Unassigned", issue.priority > 0 ? issue.priorityLabel : null].filter(Boolean).join(" · ");
    return v_flex().size_full().min_h(0).child(header)
      .child(v_flex().id("issue-page").flex_1().min_h(0).overflow_y_scrollbar().px(14).py(10).gap(8)
        .when(Boolean(this.pageError), (e) => e.child(this.message(this.pageError ?? "", t, true)))
        .child(this.editable(issue, "title", div().whitespace_normal().text_size(15).font_semibold().child(issue.title), t))
        .child(h_flex().gap(8).items_center().text_size(11).text_color(t.dim)
          .child(this.statusChip(issue, t)).child(div().child(facts))
          .when(issue.blockedBy.length > 0, (e) => e.child(div().text_color(t.ansi1).child(`⊘ Blocked by ${issue.blockedBy.join(", ")}`))))
        .when(issue.labels.length > 0, (e) => e.child(h_flex().flex_wrap().gap(5).text_size(11)
          .children(issue.labels.map((l) => div().px(5).rounded(4).border_1().border_color(`${l.color}88`).text_color(t.muted).child(l.name)))))
        .child(h_flex().flex_wrap().gap(6)
          .child(this.button("open-issue", "Open in Linear", () => openUrl(issue.url), t))
          .child(this.issueRepoChip(issue, t, cx))
          .when(Boolean(this.viewerId), (e) => e.child(this.assignButton(issue, t)))
          .when(!isShown(tab), (e) => e.child(this.button("issue-tab", tab ? "Open tab" : this.startLabel(issue, tab), (cx) => this.startTab(issue, cx), t, { accent: !tab }))))
        .children([this.repoPickerView("issue", t)].filter(Boolean))
        .child(this.editable(issue, "description", div().whitespace_normal().text_size(12.5)
          .text_color(issue.description ? t.foreground : t.dim).child(issue.description?.trim() || "No description"), t))
        .child(div().pt(6).text_size(11).font_semibold().text_color(t.muted).child(`Comments · ${issue.comments.length + issue.moreComments}`))
        .children(issue.comments.map((c) => this.comment(c, t)))
        .when(issue.moreComments > 0, (e) => e.child(div().id("more-comments").text_size(11).text_color(t.accent).cursor_pointer()
          .on_click(() => openUrl(issue.url)).child(`${issue.moreComments} older comments in Linear`))));
  }

  render(cx) {
    if (this.menu) return this.menu.render();
    this.follow(cx);
    const t = theme();
    const page = this.view.kind === "issue" ? this.issuePage(t, cx) : this.view.kind === "project" ? this.projectPage(t, cx) : this.listPage(t);
    return v_flex().id("linear-projects").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background)
      .border_1().border_color(t.border).text_color(t.foreground).text_size(13).child(page);
  }
}
