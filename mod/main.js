// Queues for Linear issue agents. A queue is a Linear issue filter with the settings its agents run
// with. Polls start the queue's ready issues, each in a space of its own, and clean up finished ones.
// The panel changes page only when you click: it does not follow the active space or tab.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea, Scrollbar } from "gpui-base";
import { spaces, panes, agents, machines, run, exec, hc, home, appHome, readTextFile, writeTextFile, shared, setShared, theme, nextCommand, notify } from "herdr";
import { loadApiKey, gql } from "./api.js";
import {
  VIEWER_QUERY, TEAM_PROJECTS_QUERY, LABELS_QUERY, USERS_QUERY, MILESTONES_QUERY, UPDATE_ISSUE, QUEUE_ISSUES_QUERY, ISSUE_QUERY, ISSUE_STATE_QUERY, BRANCH_ISSUE_QUERY, TEAM_STATES_QUERY, MAX_PAGES,
  PROJECT_GROUPS, CLOSED_STATE_TYPES, parseTeamViews, parseProject, parseIssue, sortStates, groupBy, byName, identifierOf,
  shortDate, ago, claimInput,
} from "./linear.js";
import {
  QUEUES_FILE, MAX_AGENTS_LIMIT, projectQueue, teamQueue, scratchQueue, parseQueues, serializeQueues, openIssuesFilter, migrateQueues,
  stepPoll, pollLabel,
} from "./queues.js";
import { FIELDS, PROJECT_FIELDS, DEFAULT_PROJECT_FILTERS, NONE, ME, BLOCKED, PRIORITIES, toConditions, toFilter, toggleValue, projectMatches } from "./conditions.js";
import { DEFAULT_PROMPTS, PLACEHOLDERS, MAX_COMMENTS, parsePrompts, promptsToConfig, parseCommand, startTask } from "./prompts.js";
import { issueTabs, readyIssues, pickupOrder, repoOfFolder, parseWorktrees, sweepCandidates, worktreeSlug, colorFor } from "./orchestrator.js";
import { openUrl } from "./open.js";
import { HOSTS, AWS_PROFILE, parseHost, machineName, isCloudSpace, setupScript, folderFrom, workCheckScript, instanceWorkCheckScript, workAtRisk } from "./cloud.js";

// Before 2.0, a queue, then a project, could have a space of its own: linked by these keys, or by its name.
const OLD_LINKS_KEY = "linear-projects.links"; // { "<space id>": "<project id>" }

const OLD_SETTINGS_KEY = "linear-projects.settings"; // before queues: { "<project id>": { maxAgents, pollMinutes, paused, repo, host } }
const POLL_CHECK_MS = 15000;
const SWEEP_MS = 30 * 60 * 1000;

// Optional ~/.config/herdr-app/linear-queues-settings.json: { "codeDir": "Code", "defaultRepo": "calendar", "agentHost": "local" },
// plus the prompt settings (see prompts.js). codeDir is under the home folder and holds the repos the
// repo menu lists. defaultRepo is the repo a queue uses when it picks none. teamViews is read only to
// turn old team views into queues. The Settings page writes the file; `raw` keeps keys it does not know.
const CONFIG_FILE = "linear-queues-settings.json";
const configPath = () => `${appHome()}/${CONFIG_FILE}`;
const config = { codeDir: "Code", defaultRepo: null, teamViews: [], agentHost: "local", prompts: parsePrompts(), raw: {}, text: null };

function applyConfig(raw) {
  config.raw = raw ?? {};
  config.codeDir = typeof raw?.codeDir === "string" && raw.codeDir.trim() ? raw.codeDir.trim().replace(/^~\//, "").replace(/\/+$/, "") : "Code";
  config.defaultRepo = typeof raw?.defaultRepo === "string" && raw.defaultRepo.trim() ? raw.defaultRepo.trim() : null;
  config.teamViews = parseTeamViews(raw?.teamViews);
  config.agentHost = parseHost(raw?.agentHost) ?? "local";
  config.prompts = parsePrompts(raw ?? {});
}

async function loadConfig() {
  const text = await readTextFile(configPath()).catch(() => null);
  if (text == null) { config.text = null; return applyConfig({}); }
  let raw;
  try { raw = JSON.parse(text); } catch { throw new Error(`${CONFIG_FILE} is not valid JSON`); }
  config.text = text;
  applyConfig(raw);
}

// Merges `change` into the file. A file that changed on disk since it was read is not overwritten: the
// mod reads it again, and the change is dropped with an error toast.
async function saveConfig(change) {
  const next = `${JSON.stringify({ ...config.raw, ...change }, null, 2)}\n`;
  try { await writeTextFile(configPath(), next, config.text); }
  catch (e) {
    await loadConfig().catch(() => {});
    notify({ title: `Did not save the change to ${CONFIG_FILE}`, body: `The file changed on disk, so the mod read it again. ${e.message ?? e}`, level: "error" });
    return false;
  }
  config.text = next;
  applyConfig(JSON.parse(next));
  return true;
}

// Before the rename to Linear Queues, the two files had other names. Each moves once, and only when
// the new file does not exist yet.
async function moveOldFiles() {
  for (const [from, to] of [["linear-projects.json", CONFIG_FILE], ["linear-projects-contexts.json", QUEUES_FILE]]) {
    const [oldText, newText] = await Promise.all([`${appHome()}/${from}`, `${appHome()}/${to}`].map((p) => readTextFile(p).catch(() => null)));
    if (oldText != null && newText == null) await exec("mv", ["-n", `${appHome()}/${from}`, `${appHome()}/${to}`]).catch(() => null);
  }
}

const skillPath = (name) => `${home()}/.claude/skills/${name}/SKILL.md`;

async function readSkill(name) {
  const text = await readTextFile(skillPath(name)).catch(() => null);
  if (text == null) throw new Error(`the skill ${name} is not in ~/.claude/skills. Pick another skill in Settings or on the queue.`);
  return text;
}

async function listSkills() {
  const r = await exec("find", [`${home()}/.claude/skills`, "-mindepth", "2", "-maxdepth", "2", "-name", "SKILL.md"]).catch(() => null);
  return (r?.stdout ?? "").split("\n").filter(Boolean).map((p) => p.split("/").slice(-2)[0]).sort((a, b) => a.localeCompare(b));
}

// For the first-message preview on the Settings page.
const SAMPLE_ISSUE = {
  identifier: "CAL-123", title: "Fix the feed", branchName: "you/cal-123-fix-the-feed", url: "https://linear.app/team/issue/CAL-123",
  description: "The issue's description goes here.", milestone: { name: "2. Feed" },
  comments: [{ author: "Ann", createdAt: "2026-11-20T00:00:00Z", body: "The newest comment." }, { author: "Bo", createdAt: "2026-11-18T00:00:00Z", body: "An older comment." }],
};
const SETTINGS_TARGET = "settings"; // the repo picker's target on the Settings page

const queuesPath = () => `${appHome()}/${QUEUES_FILE}`;
const codeDir = () => (config.codeDir.startsWith("/") ? config.codeDir : `${home()}/${config.codeDir}`);
const repoPath = (name) => `${codeDir()}/${name}`;
const REPO_ROW = 24, REPO_LIST_MAX_ROWS = 10;
const fieldOf = (key) => FIELDS.find((f) => f.key === key) ?? PROJECT_FIELDS.find((f) => f.key === key);

// The "New queue" filters are a choice for this window only, so browser storage is enough. It can be
// empty or unavailable; the defaults then apply.
const PROJECT_FILTERS_STORE = "new-queue-filters";
function loadProjectFilters() {
  try { return JSON.parse(localStorage.getItem(PROJECT_FILTERS_STORE) ?? "null") ?? DEFAULT_PROJECT_FILTERS; } catch { return DEFAULT_PROJECT_FILTERS; }
}
function saveProjectFilters(filters) {
  try { localStorage.setItem(PROJECT_FILTERS_STORE, JSON.stringify(filters)); } catch { /* the choice lasts until reload */ }
}

// The project-spaces sidebar reads these keys. They were named when each project had its settings, and
// they now hold queue IDs. A queue made from a project, or moved from one, has the project's ID.
const OLD_HOMES_KEY = "linear-projects.project-spaces"; // the sidebar still reads it, so it is set empty
const ISSUE_PROJECTS_KEY = "linear-projects.issue-projects"; // { "<issue identifier>": "<queue id>" }: which queue an issue space counts for
const PROJECT_COLORS_KEY = "linear-projects.project-colors"; // { "<queue id>": "<space color>" }
const PROJECT_NAMES_KEY = "linear-projects.project-names"; // { "<queue id>": "<name>" }, for the sidebar
const SPACE_COLORS_KEY = "space.colors"; // the stock spaces sidebar's avatar colors: { "<space id>": "<color>" }

function setIssueQueue(ident, queueId) {
  const { [ident]: _old, ...rest } = shared(ISSUE_PROJECTS_KEY) ?? {};
  setShared(ISSUE_PROJECTS_KEY, queueId ? { ...rest, [ident]: queueId } : rest);
}

// A moved issue's own host and repo, which win over its queue's: { "<issue identifier>": { host, repo } }.
// The entry goes when the issue's space is cleaned up for good.
const ISSUE_OVERRIDES_KEY = "linear-queues.issue-overrides";
const issueOverride = (ident) => (shared(ISSUE_OVERRIDES_KEY) ?? {})[ident] ?? null;

function setIssueOverride(ident, value) {
  const { [ident]: _old, ...rest } = shared(ISSUE_OVERRIDES_KEY) ?? {};
  setShared(ISSUE_OVERRIDES_KEY, value ? { ...rest, [ident]: value } : rest);
}

function forgetSpaceColor(spaceId) {
  const { [spaceId]: _old, ...rest } = shared(SPACE_COLORS_KEY) ?? {};
  setShared(SPACE_COLORS_KEY, rest);
}

// An issue space is a space named after an issue that a poll started, on this computer or on a cloud
// instance. Its queue comes from the record that the start made.
const issueQueueOf = (space) => {
  const ident = identifierOf(space);
  return ident ? (shared(ISSUE_PROJECTS_KEY) ?? {})[ident] ?? null : null;
};

const nextHost = (current) => [null, ...HOSTS][([null, ...HOSTS].indexOf(current) + 1) % (HOSTS.length + 1)];
// Remote repos sit in the same folder under the instance's home; an absolute local codeDir cannot apply there.
const remoteCodeDir = () => (config.codeDir.startsWith("/") ? "Code" : config.codeDir);

const sleep = (seconds) => exec("sleep", [String(seconds)]);

// "45s" or "3m 05s".
function duration(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000)), minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}m ${String(seconds % 60).padStart(2, "0")}s` : `${seconds}s`;
}

// What a poll is doing now (step) and what it did (log). Starts and sweeps also run outside a poll.
const NO_REPORT = { step() {}, log() {} };

async function listRepos() {
  const r = await exec("find", [codeDir(), "-mindepth", "2", "-maxdepth", "2", "-name", ".git", "-type", "d"]);
  return r.stdout.split("\n").filter(Boolean).map((p) => p.replace(/\/\.git$/, "").split("/").pop())
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}
const AGENT_BUSY = ["working", "blocked"];
const CLOUD_AGENT = "cloud-agent";
const AWS_CHECK_MS = 5 * 60 * 1000;
const AWS_EXPIRED = "Your AWS login for cloud agents has expired, or the aws command is missing. Run `pco aws-login`, then try again.";

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
    this.queues = null; this.queuesText = null; this.queuesError = null; // null queues: not loaded yet
    this.filesMoved = moveOldFiles(); // every load of the two files waits for this
    this.saving = Promise.resolve();
    this.projects = []; this.teams = []; this.projectsLoaded = false;
    this.teamStates = new Map();
    this.polling = new Set(); // queue ids
    this.starting = new Set(); // issue identifiers
    this.moving = new Map(); // issue identifier -> what its move does now
    this.moveMenu = null; // the issue whose Move menu is open
    this.moveRepoFor = null; // { ident, host }: the Move menu's repo list is open, for a move to that host
    this.sweptAt = 0;
    this.notes = new Set(); // noteOnce keys
    this.awsCheckedAt = 0;
    this.repos = null; this.reposError = null; // null: not loaded yet
    // install.sh copies the repo's VERSION file into the mod's folder.
    cx.spawn(async (cx) => {
      const text = await readTextFile(`${appHome()}/mods/linear-queues/VERSION`).catch(() => null);
      this.version = text?.trim() || null;
      cx.notify();
    });
    cx.spawn(async (cx) => {
      await this.filesMoved;
      try { await loadConfig(); } catch (e) { notify({ title: "Linear Queues settings", body: String(e.message ?? e), level: "error" }); }
      this.loadRepos(cx);
      await this.loadQueues(cx);
    });
    this.repoPicker = null; // { target, current, fallback }
    this.repoFilter = InputState.new({ placeholder: "Filter repos" });
    this.repoFilter.on("change", (_e, cx) => cx.notify());
    this.repoFilter.on("submit", () => { const first = this.repoMatches()[0]; if (first) this.pickRepo(first); });
    this.view = { kind: "queues" };
    this.confirmDelete = null; // a queue id
    this.confirmStartOver = null; // a queue id
    this.matches = new Map(); // queue id -> { key, issues, error }: the open issues its filter finds
    this.optionLists = new Map(); // "label", "assignee", "status" or "milestone:<project ids>" -> { items, error }
    // The condition editors: a queue's filter, and the "New queue" project filters. Each has a key.
    this.condPicker = null; // { key, field }: the value picker that is open
    this.pending = null; // { key, field, negate }: a condition with no value yet, so not saved
    this.addMenu = null; // the key of the editor whose "+ Add" menu is open
    this.projectFilters = loadProjectFilters();
    // The Settings page.
    this.skills = null; // the skill names in ~/.claude/skills; null while they load
    this.skillMenu = false; // the skill menu is open
    this.skillEdit = null; // { name, original }: the skill whose SKILL.md is open on the Settings page
    this.preview = null; // "local" or "cloud": the first-message preview that is open
    this.form = null; // the Settings page's first-message fields that are not text: { comments }
    this.commandInput = InputState.new({ placeholder: DEFAULT_PROMPTS.command });
    this.templateInput = TextareaState.new({ placeholder: "Template" }); this.templateInput.set_auto_grow(4, 14);
    this.localNoteInput = TextareaState.new({ placeholder: "Note for agents on this computer" }); this.localNoteInput.set_auto_grow(2, 8);
    this.cloudNoteInput = TextareaState.new({ placeholder: "Note for agents on cloud instances" }); this.cloudNoteInput.set_auto_grow(2, 8);
    this.handoffNoteInput = TextareaState.new({ placeholder: "Note for an agent after a move" }); this.handoffNoteInput.set_auto_grow(2, 8);
    this.skillInput = TextareaState.new({ placeholder: "SKILL.md" }); this.skillInput.set_auto_grow(8, 30);
    for (const input of [this.commandInput, this.templateInput, this.localNoteInput, this.cloudNoteInput, this.handoffNoteInput, this.skillInput]) {
      input.on("change", (_e, cx) => cx.notify());
    }
    this.commandInput.on("submit", (_e, cx) => this.saveCommand(cx));
    this.newName = InputState.new({ placeholder: "Name, for example Urgent bugs" });
    this.newName.on("change", (_e, cx) => cx.notify());
    this.newName.on("submit", (_e, cx) => this.createScratch(cx));
    this.condFilter = InputState.new({ placeholder: "Filter" });
    this.condFilter.on("change", (_e, cx) => cx.notify());
    this.polls = new Map(); // queue id -> { at, result }; the clock starts when the mod loads
    cx.timer.every(1000, (cx) => { if (this.polling.size) cx.notify(); }); // the elapsed times
    cx.timer.every(POLL_CHECK_MS, (cx) => {
      cx.spawn(async (cx) => { await this.loadQueues(cx); this.syncSpaceColors(); this.pollDueQueues(cx); cx.notify(); });
    });
    this.refreshProjects(cx);
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "refresh") { this.refreshProjects(cx); await this.loadQueues(cx); }
        else if (command === "settings") this.go({ kind: "settings" }, cx);
        cx.notify();
      }
    });
  }

  // The projects list is for "New queue", and it names projects when old settings move to queues.
  refreshProjects(cx, manual = false) {
    this.loadingProjects = true; this.manual = manual;
    cx.spawn(async (cx) => {
      try {
        this.apiKey = await loadApiKey();
        const viewer = (await gql(this.apiKey, VIEWER_QUERY)).viewer;
        this.viewerId = viewer.id;
        this.teams = [...viewer.teams.nodes].sort((a, b) => a.key.localeCompare(b.key));
        const perTeam = await Promise.all(viewer.teams.nodes.map((team) =>
          allPages(this.apiKey, TEAM_PROJECTS_QUERY, { team: team.id }, (d) => d.team.projects)));
        const byId = new Map();
        viewer.teams.nodes.forEach((team, i) => perTeam[i].forEach((n) => {
          const project = byId.get(n.id) ?? byId.set(n.id, { ...parseProject(n), teamKeys: [] }).get(n.id);
          project.teamKeys.push(team.key);
        }));
        this.projects = [...byId.values()].sort(byName);
        // Read again on each refresh: the settings file is outside the mod's folder, so editing it does not reload the mod.
        await this.filesMoved;
        try { await loadConfig(); } catch (e) { if (manual) notify({ title: "Linear Queues settings", body: String(e.message ?? e), level: "error" }); }
        this.error = null;
      } catch (e) { this.error = String(e.message ?? e); }
      finally {
        this.loadingProjects = false; this.projectsLoaded = true;
        if (!this.queues) await this.loadQueues(cx); // a move of old settings waits for the project names
        cx.notify();
      }
    });
    if (manual) cx.notify();
  }

  // The file can change by hand at any time, so each poll check reads it again. With no file yet, the old
  // project settings move into it once the projects are loaded, because they give the project names.
  async loadQueues(cx) {
    if (this.loadingQueues) return;
    this.loadingQueues = true;
    try {
      await this.filesMoved;
      const text = await readTextFile(queuesPath()).catch((e) => { throw new Error(`Could not read ${QUEUES_FILE}: ${e.message ?? e}`); });
      if (text == null) return await this.migrate(cx);
      if (text === this.queuesText && this.queues) return;
      const { queues, skipped } = parseQueues(text);
      this.queues = queues; this.queuesText = text; this.queuesError = null;
      this.dropOldKeys();
      if (skipped.length) notify({ title: `Skipped ${skipped.length} queue${skipped.length === 1 ? "" : "s"} in ${QUEUES_FILE}`, body: `Each needs a unique "id", a "name" and a "filter": ${skipped.join(", ")}`, level: "error" });
    } catch (e) {
      this.queuesError = String(e.message ?? e);
    } finally { this.loadingQueues = false; cx.notify(); }
  }

  async migrate(cx) {
    if (!this.projectsLoaded || this.error) return;
    const names = { ...(shared(PROJECT_NAMES_KEY) ?? {}), ...Object.fromEntries(this.projects.map((p) => [p.id, p.name])) };
    const queues = migrateQueues({
      settings: shared(OLD_SETTINGS_KEY) ?? {}, links: shared(OLD_LINKS_KEY) ?? {}, issueProjects: shared(ISSUE_PROJECTS_KEY) ?? {}, teamViews: config.teamViews, names,
      todoNames: await this.todoNames(),
    });
    const text = serializeQueues(queues);
    await writeTextFile(queuesPath(), text, null);
    this.queues = queues; this.queuesText = text; this.queuesError = null;
    if (queues.length) notify({ title: `Moved your project settings into ${queues.length} queue${queues.length === 1 ? "" : "s"}`, body: `They are in ~/.config/herdr-app/${QUEUES_FILE}.` });
    cx.notify();
  }

  // The change shows at once, and the file is written after it. A file that changed on disk since it was
  // read is not overwritten: the hand edit wins, and the change is dropped.
  // An event's cx is valid only during the event, so the write runs in a spawn with a cx of its own.
  saveQueues(next, cx) {
    this.queues = next;
    cx.spawn(async (cx) => {
      this.saving = this.saving.then(async () => {
        const text = serializeQueues(this.queues);
        try { await writeTextFile(queuesPath(), text, this.queuesText); this.queuesText = text; }
        catch (e) {
          notify({ title: `Did not save the change to ${QUEUES_FILE}`, body: `The file changed on disk, so the mod read it again. ${e.message ?? e}`, level: "error" });
          this.queuesText = null;
          await this.loadQueues(cx);
        }
      });
      await this.saving;
    });
    cx.notify();
  }

  updateQueue(id, change, cx) {
    this.saveQueues(this.queues.map((c) => (c.id === id ? { ...c, ...change } : c)), cx);
  }

  // Old settings move into the file before this runs, so these keys are no longer needed.
  dropOldKeys() {
    if (shared(OLD_LINKS_KEY)) setShared(OLD_LINKS_KEY, null);
    if (Object.keys(shared(OLD_HOMES_KEY) ?? {}).length) setShared(OLD_HOMES_KEY, {});
  }

  queueById(id) { return this.queues?.find((c) => c.id === id) ?? null; }

  loadRepos(cx) {
    cx.spawn(async (cx) => {
      try { this.repos = await listRepos(); this.reposError = null; }
      catch (e) { this.repos ??= []; this.reposError = String(e.message ?? e); }
      cx.notify();
    });
  }

  show(view) {
    this.view = view; this.repoPicker = null; this.confirmDelete = null; this.confirmStartOver = null;
    this.condPicker = null; this.pending = null; this.addMenu = null; this.skillMenu = false;
    if (view.kind === "settings") this.fillSettings();
  }

  go(view, cx) { this.show(view); cx.notify(); }

  async fetchIssues(queueId) {
    const queue = this.queueById(queueId);
    if (!queue) throw new Error("the queue is gone");
    if (!Object.keys(queue.filter).length) throw new Error("the queue has no conditions, so it would find every issue in the workspace");
    const nodes = await allPages(this.apiKey, QUEUE_ISSUES_QUERY, { filter: openIssuesFilter(queue.filter) }, (d) => d.issues);
    return nodes.map(parseIssue);
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

  queueSpaces(queueId) {
    return spaces().filter((s) => issueQueueOf(s) === queueId);
  }

  pollClock(queueId) {
    if (!this.polls.has(queueId)) this.polls.set(queueId, { at: Date.now(), running: false, log: [], result: null, failed: false, took: 0 });
    return this.polls.get(queueId);
  }

  // Each issue has its own space, so a queue with polling turned on polls on its own clock.
  pollDueQueues(cx) {
    const now = Date.now();
    for (const queue of this.queues ?? []) {
      const { id, pollMinutes, paused } = queue;
      if (!paused && pollMinutes && now - this.pollClock(id).at >= pollMinutes * 60000) this.poll(id, cx);
    }
  }

  // Resume polls at once, so the queue catches up on what changed while it was paused.
  togglePause(queueId, cx) {
    const paused = !this.queueById(queueId).paused;
    this.updateQueue(queueId, { paused }, cx);
    if (!paused) this.poll(queueId, cx);
  }

  // Every poll restarts the clock. "Poll now" during a poll only notes that one is running.
  poll(queueId, cx) {
    if (this.polling.has(queueId)) {
      this.polls.get(queueId)?.log.push({ at: Date.now(), text: "A poll is already running, so Poll now waits for it.", level: "info" });
      return cx.notify();
    }
    const clock = { at: Date.now(), running: true, step: "Starting", stepAt: Date.now(), log: [], result: null, failed: false, took: 0 };
    this.polls.set(queueId, clock);
    this.polling.add(queueId);
    cx.spawn(async (cx) => {
      const report = {
        step: (text) => { clock.step = text; clock.stepAt = Date.now(); cx.notify(); },
        log: (text, level = "info") => { clock.log.push({ at: Date.now(), text, level }); cx.notify(); },
      };
      try { clock.result = await this.runPoll(queueId, report); }
      catch (e) {
        clock.result = `failed: ${e.message ?? e}`; clock.failed = true;
        report.log(`Failed: ${e.message ?? e}`, "error");
        notify({ title: `The poll for ${this.queueById(queueId)?.name ?? "a queue"} failed`, body: String(e.message ?? e), level: "error" });
      }
      finally { clock.running = false; clock.took = Date.now() - clock.at; this.polling.delete(queueId); cx.notify(); }
    });
    cx.notify();
  }

  async runPoll(queueId, report) {
    this.apiKey ??= await loadApiKey();
    if (!this.viewerId) throw new Error("your Linear user is not loaded yet");
    report.step("Asking Linear for the queue's open issues");
    const issues = await this.fetchIssues(queueId);
    this.matches.set(queueId, { key: JSON.stringify(this.queueById(queueId)?.filter), issues, error: null });
    const { maxAgents } = this.queueById(queueId);

    const openIdents = new Set(issues.map((i) => i.identifier)), queueSpaces = this.queueSpaces(queueId);
    const tabs = queueSpaces.flatMap((s) => issueTabs(s).map((t) => ({ ...t, space: s }))), cleaned = [];
    const leftOpen = tabs.filter((t) => !openIdents.has(t.ident));
    report.log(`The filter finds ${issues.length} open issue${issues.length === 1 ? "" : "s"}. ${tabs.length} running${leftOpen.length ? `, ${leftOpen.length} of them not found by the filter now` : ""}.`);
    for (const { tab, ident, space: tabSpace } of leftOpen) {
      report.step(`Checking whether ${ident} is closed`);
      const issue = (await gql(this.apiKey, ISSUE_STATE_QUERY, { id: ident }).catch(() => null))?.issue;
      if (!issue) { report.log(`Could not read ${ident} from Linear, so its space stays.`, "error"); continue; }
      // For example, the start assigned it to you and the filter finds only unassigned issues.
      if (!CLOSED_STATE_TYPES.includes(issue.state.type)) { report.log(`${ident} is still open, so its space stays.`); continue; }
      const agent = agents().find((a) => a.tab === tab.id);
      if (agent && AGENT_BUSY.includes(agent.status)) { report.log(`${ident} is closed, but its agent is ${agent.status}. The next poll tries again.`); continue; }
      report.step(`Cleaning up ${ident}`);
      const done = isCloudSpace(tabSpace) ? await this.cleanUpCloud(tabSpace, ident, issue.branchName, report) : await this.cleanUpIssueSpace(tabSpace, ident, issue.branchName);
      if (done) { cleaned.push(ident); setIssueOverride(ident, null); report.log(`Cleaned up ${ident}.`); }
    }
    const swept = await this.sweepOrphans(report);
    const ended = await this.sweepCloudMachines(report);

    const openTabs = tabs.length - cleaned.length;
    const tabIdents = new Set(spaces().flatMap((s) => s.tabs.map(identifierOf)).filter(Boolean));
    const ready = readyIssues(issues, { tabIdents, viewerId: this.viewerId }), free = Math.max(0, maxAgents - openTabs);
    const picks = ready.slice(0, free);
    if (!ready.length) report.log("No issue is ready: each one the filter finds already has a space.");
    else if (!free) report.log(`${ready.length} ready, but all ${maxAgents} slots are in use.`);
    else report.log(`${ready.length} ready and ${free} free slot${free === 1 ? "" : "s"}: starting ${picks.map((i) => i.identifier).join(", ")}.`);
    const started = [];
    for (const issue of picks) {
      const startedAt = Date.now(), where = this.hostFor(queueId, issue.identifier) === "cloud" ? "on a cloud instance" : "on this computer";
      try {
        await this.startIssue(issue, queueId, report);
        report.step(`${issue.identifier}: setting it In Progress in Linear`);
        await this.claimOnStart(issue);
        started.push(issue.identifier);
        report.log(`Started ${issue.identifier} ${where} in ${duration(Date.now() - startedAt)}.`);
      } catch (e) {
        report.log(`Could not start ${issue.identifier}: ${e.message ?? e}`, "error");
        notify({ title: `Could not start ${issue.identifier}`, body: String(e.message ?? e), level: "error" });
      }
    }
    return [
      `${openTabs + started.length}/${maxAgents} agents`,
      started.length && `started ${started.join(", ")}`,
      cleaned.length && `cleaned up ${cleaned.join(", ")}`,
      swept.length && `swept ${swept.length} old worktree${swept.length === 1 ? "" : "s"}`,
      ended.length && `ended the cloud agent${ended.length === 1 ? "" : "s"} for ${ended.join(", ")}`,
    ].filter(Boolean).join(" · ");
  }

  // `cleanUp` finds worktrees through their issue tab, so one whose tab was closed by hand stays. This
  // removes those once their issue is closed, if nothing in Herdr is in them and they have no
  // uncommitted changes. The branch stays. sweptAt is set first so that parallel polls sweep once.
  async sweepOrphans(report = NO_REPORT) {
    if (Date.now() - this.sweptAt < SWEEP_MS) return [];
    this.sweptAt = Date.now();
    report.step("Looking for old worktrees to remove (once every 30 minutes)");
    const root = `${home()}/.herdr/worktrees`;
    const openFolders = [...spaces().map((s) => s.folder), ...panes().map((p) => p.cwd)].filter(Boolean);
    const swept = [];
    for (const repo of this.repos ?? await listRepos()) {
      const listed = await exec("git", ["-C", repoPath(repo), "worktree", "list", "--porcelain"]).catch(() => null);
      if (listed?.code !== 0) continue;
      const main = parseWorktrees(listed.stdout)[0].path;
      for (const w of sweepCandidates(listed.stdout, { root, openFolders })) {
        const status = await exec("git", ["-C", w.path, "status", "--porcelain"]).catch(() => null);
        if (status?.code !== 0 || status.stdout.trim()) continue;
        const issue = (await gql(this.apiKey, BRANCH_ISSUE_QUERY, { branch: w.branch }).catch(() => null))?.issueVcsBranchSearch;
        if (!issue || !CLOSED_STATE_TYPES.includes(issue.state.type)) continue;
        // git refuses a worktree with submodules unless forced; the status check above already found it clean.
        try { await git(main, ["worktree", "remove", "--force", w.path]); swept.push(w.path); report.log(`Removed the old worktree for ${issue.identifier}.`); }
        catch (e) { notify({ title: `Could not remove worktree for ${issue.identifier}`, body: String(e.message ?? e), level: "error" }); }
      }
    }
    return swept;
  }

  // Closing the space ends its terminals; the worktree goes after them, and the local branch stays.
  async cleanUpIssueSpace(space, ident, branch) {
    run("space.close", { id: space.id, confirmed: true });
    forgetSpaceColor(space.id);
    setIssueQueue(ident, null);
    await this.removeWorktrees(branch, space.folder);
    return true;
  }

  async removeWorktrees(branch, nearFolder) {
    if (!branch) return;
    const removed = new Set();
    for (const folder of [nearFolder, ...(this.repos ?? await listRepos()).map(repoPath)]) {
      const listed = await exec("git", ["-C", folder, "worktree", "list", "--porcelain"]).catch(() => null);
      if (listed?.code !== 0) continue;
      const [main, ...worktrees] = parseWorktrees(listed.stdout);
      for (const w of worktrees.filter((w) => w.branch === branch && !removed.has(w.path))) {
        await git(main.path, ["worktree", "remove", "--force", w.path]);
        removed.add(w.path);
      }
    }
  }

  // A cloud issue's space and instance end together. The agent can move to another repo on the
  // instance, so the check covers the space's folder and every checkout on the issue's branch.
  async cleanUpCloud(space, ident, branch, report = NO_REPORT) {
    report.step(`${ident}: checking the instance for work that is not pushed`);
    if (!(await this.instanceCanEnd(space.machine, ident, workCheckScript(space.folder), report))) return false;
    if (branch && !(await this.instanceCanEnd(space.machine, ident, instanceWorkCheckScript(remoteCodeDir(), branch), report))) return false;
    run("space.close", { id: space.id, confirmed: true });
    forgetSpaceColor(space.id);
    report.step(`${ident}: terminating the instance`);
    await this.endInstance(space.machine, ident);
    return true;
  }

  // Herdr also closes a cloud space when its last tab closes, for example when the agent exits. Then no
  // issue tab leads the poll to the instance, so this finds the machine instead: a cloud-agent machine
  // with no space, named after an issue that is closed. A machine added by hand is not a cloud-agent one.
  async sweepCloudMachines(report = NO_REPORT) {
    if (this.sweepingCloud) return [];
    this.sweepingCloud = true;
    try {
      report.step("Looking for cloud machines that have no space");
      const listed = await hc(["machine", "ls", "--json"]).catch(() => null);
      if (listed?.code !== 0) return [];
      const inUse = new Set(spaces().map((s) => s.machine).filter(Boolean)), ended = [];
      for (const { name, target } of JSON.parse(listed.stdout).machines ?? []) {
        const ident = name.toUpperCase();
        if (!target?.startsWith("cloud-agent-") || inUse.has(name) || this.starting.has(ident)) continue;
        const issue = (await gql(this.apiKey, ISSUE_STATE_QUERY, { id: ident }).catch(() => null))?.issue;
        if (!issue?.branchName || !CLOSED_STATE_TYPES.includes(issue.state.type)) continue;
        report.step(`${ident}: checking its instance, which has no space, for work that is not pushed`);
        if (!(await this.instanceCanEnd(name, ident, instanceWorkCheckScript(remoteCodeDir(), issue.branchName), report))) continue;
        report.step(`${ident}: terminating its instance`);
        await this.endInstance(name, ident);
        setIssueOverride(ident, null);
        ended.push(ident);
        report.log(`Ended the cloud agent for ${ident}, whose space was gone.`);
      }
      return ended;
    } finally { this.sweepingCloud = false; }
  }

  // Terminating the instance deletes its disk, so its checkouts must hold nothing that would be lost.
  // Until then the poll keeps it, and says why once.
  async instanceCanEnd(machine, ident, checkScript, report = NO_REPORT) {
    const check = await exec("bash", ["-lc", checkScript], { on: machine, timeout: 60000 }).catch((e) => ({ code: -1, stderr: String(e.message ?? e) }));
    let risk;
    try {
      if (check.code !== 0) throw new Error((check.stderr || check.stdout || "the check failed").trim());
      risk = workAtRisk(check.stdout);
    } catch (e) { return this.keep(ident, "check", `Could not check its work for changes that are not pushed: ${e.message ?? e}`, report); }
    if (risk) return this.keep(ident, "risk", `Its checkout has ${risk}. Push or discard them, and the next poll ends the instance.`, report);
    if (!(await this.awsLoggedIn())) return this.keep(ident, "aws", AWS_EXPIRED, report);
    return true;
  }

  // The toast shows once per mod load; the poll log says it at each poll.
  keep(ident, reason, text, report) {
    this.noteOnce(`${ident}:${reason}`, `Kept the cloud agent for ${ident}`, text);
    report.log(`Kept the cloud agent for ${ident}: ${text}`, "error");
    return false;
  }

  // `cloud-agent hc delete` also removes the hc machine.
  async endInstance(machine, ident) {
    const r = await exec(CLOUD_AGENT, ["hc", "delete", "-s", machine], { timeout: 180000 }).catch((e) => ({ code: -1, stderr: String(e.message ?? e) }));
    if (r.code !== 0) notify({ title: `Could not terminate the instance for ${ident}`, body: `${(r.stderr || r.stdout || "").trim()}\nRun: cloud-agent hc delete -s ${machine}`, level: "error" });
    setIssueQueue(ident, null);
  }

  // Each queue has one avatar color, and its issue spaces wear it, so the sidebar shows which spaces
  // belong together. This writes only what changed.
  syncSpaceColors() {
    if (!this.queues) return;
    const grouped = spaces().map((s) => ({ s, queueId: issueQueueOf(s) })).filter((x) => x.queueId);
    if (!grouped.length) return;
    const saved = shared(PROJECT_COLORS_KEY) ?? {}, active = new Set(grouped.map((x) => x.queueId));
    const assigned = { ...saved };
    for (const id of active) assigned[id] = colorFor(id, assigned, active);
    if (Object.keys(assigned).length !== Object.keys(saved).length) setShared(PROJECT_COLORS_KEY, assigned);
    const savedNames = shared(PROJECT_NAMES_KEY) ?? {};
    const names = Object.fromEntries([...active].map((id) => [id, this.queueById(id)?.name ?? savedNames[id]]).filter(([, n]) => n));
    if (JSON.stringify(names) !== JSON.stringify(savedNames)) setShared(PROJECT_NAMES_KEY, names);
    const colors = shared(SPACE_COLORS_KEY) ?? {};
    const changed = grouped.filter(({ s, queueId }) => colors[s.id] !== assigned[queueId]);
    if (changed.length) setShared(SPACE_COLORS_KEY, { ...colors, ...Object.fromEntries(changed.map(({ s, queueId }) => [s.id, assigned[queueId]])) });
  }

  // A poll runs again and again, so a problem that waits on you shows its toast once per mod load.
  noteOnce(key, title, body) {
    if (this.notes.has(key)) return;
    this.notes.add(key);
    notify({ title, body, level: "error" });
  }

  // cloud-agent runs `pco aws-login` when the login has expired, and that opens a browser. A poll must
  // never do that, so every cloud-agent call checks the login first. A good answer holds for 5 minutes.
  async awsLoggedIn() {
    if (Date.now() - this.awsCheckedAt < AWS_CHECK_MS) return true;
    const r = await exec("aws", ["sts", "get-caller-identity", "--profile", AWS_PROFILE], { timeout: 30000 }).catch(() => null);
    if (r?.code !== 0) return false;
    this.awsCheckedAt = Date.now();
    return true;
  }

  // A moved issue's own choice, else the queue's, else the default.
  repoFor(queueId, ident) {
    return issueOverride(ident)?.repo ?? this.queueById(queueId)?.repo ?? config.defaultRepo;
  }

  hostFor(queueId, ident) {
    return issueOverride(ident)?.host ?? this.queueById(queueId)?.host ?? config.agentHost;
  }

  // Each issue gets its own space, named after it, in its own worktree.
  // `from` is set after a move: where the work was, for the handoff note.
  async startIssue(issue, queueId, report = NO_REPORT, { from = null } = {}) {
    if (this.hostFor(queueId, issue.identifier) === "cloud") return this.startCloud(issue, queueId, report, { from });
    const ident = issue.identifier, step = (text) => report.step(`Starting ${ident}: ${text}`);
    this.starting.add(ident);
    try {
      const repo = this.repoFor(queueId, ident);
      if (!repo) throw new Error("pick a repo for the queue first (Repo)");
      step(`making its worktree in ${repo}`);
      if (from && issue.branchName) await this.syncLocalBranch(repo, issue.branchName);
      const folder = issue.branchName ? await ensureWorktree(repoPath(repo), issue.branchName) : repoPath(repo);
      const prompts = config.prompts, argv = parseCommand(prompts.command);
      if (prompts.skill) await readSkill(prompts.skill);
      step("reading the issue and its comments");
      const full = parseIssue((await gql(this.apiKey, ISSUE_QUERY, { id: ident })).issue);
      step("opening its space");
      await this.openIssueSpace(ident, queueId, { name: `${ident} ${issue.title}`, tab: ident, folder, argv, task: startTask(full, prompts, { from }), focus: false });
    } finally { this.starting.delete(ident); }
  }

  // space.new reports nothing, and once it made no space with no error at all. The caller then set the
  // issue In Progress, and the poll, which starts only Todo issues, never tried it again. Throwing here
  // keeps the issue in Todo, so the next poll tries again.
  async openIssueSpace(ident, queueId, args) {
    setIssueQueue(ident, queueId);
    run("space.new", args);
    for (let i = 0; i < 40; i++) {
      if (spaces().some((s) => s.tabs.some((t) => identifierOf(t) === ident))) return;
      await sleep(0.5);
    }
    setIssueQueue(ident, null);
    throw new Error("Herdr did not open the issue's space. Nothing changed in Linear, so the next poll tries again if the issue is in Todo.");
  }

  // One instance for each issue, added to Herdr as a machine named after the issue. Its space holds the
  // issue's Claude tab, in the repo's main checkout on the instance. The space's name starts with the
  // issue ID, so the poll finds it like a local issue space.
  async startCloud(issue, queueId, report = NO_REPORT, { from = null } = {}) {
    const ident = issue.identifier, machine = machineName(ident), step = (text) => report.step(`Starting ${ident}: ${text}`);
    this.starting.add(ident);
    try {
      if (!issue.branchName) throw new Error("the issue has no branch name in Linear");
      const repo = this.repoFor(queueId, ident);
      if (!repo) throw new Error("pick a repo for the queue first (Repo)");
      const prompts = config.prompts, argv = parseCommand(prompts.command);
      const skill = prompts.skill ? await readSkill(prompts.skill) : "";
      step("checking its branch for local commits");
      await this.refuseLocalWork(ident, repo, issue.branchName);
      step("checking your AWS login");
      if (!(await this.awsLoggedIn())) throw new Error(AWS_EXPIRED);
      if (machines().some((m) => m.name === machine)) report.log(`${ident} already has the machine ${machine}, so no new instance.`);
      else {
        step("launching a cloud instance. This often takes a few minutes.");
        const r = await exec(CLOUD_AGENT, ["hc", "launch", "-s", machine, "--new"], { timeout: 600000 })
          .catch((e) => ({ code: -1, stderr: String(e.message ?? e) }));
        if (r.code !== 0) throw new Error(`cloud-agent hc launch failed: ${(r.stderr || r.stdout || "").trim().split("\n").slice(-3).join(" ")}`);
      }
      step(`waiting for Herdr to connect to ${machine}`);
      await this.waitForMachine(machine);
      step(`checking out ${issue.branchName} and setting up Claude on the instance`);
      const script = setupScript({ codeDir: remoteCodeDir(), repo, branch: issue.branchName, skillName: prompts.skill, skill, setup: prompts.cloudSetup });
      const setup = await exec("bash", ["-lc", script], { on: machine, timeout: 300000 });
      if (setup.code !== 0) throw new Error(`setup on ${machine} failed: ${(setup.stderr || setup.stdout).trim()}`);
      const folder = folderFrom(setup.stdout);
      step("reading the issue and its comments");
      const full = parseIssue((await gql(this.apiKey, ISSUE_QUERY, { id: ident })).issue);
      step("opening its space");
      await this.openIssueSpace(ident, queueId, { name: `${ident} ${issue.title}`, tab: ident, machine, folder, argv, task: startTask(full, prompts, { cloud: true, from }), focus: false });
    } finally { this.starting.delete(ident); }
  }

  async waitForMachine(machine) {
    for (let i = 0; i < 120; i++) {
      if (machines().find((m) => m.name === machine)?.layout === "ready") return;
      await sleep(0.5);
    }
    throw new Error(`Herdr could not reach the machine ${machine}`);
  }

  // A branch with local commits that origin does not have would start on the instance without them.
  async refuseLocalWork(ident, repo, branch) {
    const main = repoPath(repo);
    const local = await exec("git", ["-C", main, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).catch(() => null);
    if (local?.code !== 0) return;
    const count = Number((await git(main, ["rev-list", "--count", branch, "--not", "--remotes=origin"])).trim());
    if (count > 0) throw new Error(`${ident} has ${count} local commit${count === 1 ? "" : "s"} on ${branch} that ${count === 1 ? "is" : "are"} not pushed. Push the branch, or start it locally.`);
  }

  // A moved issue continues from its pushed branch. A local branch from an earlier start can be behind
  // it, so it moves forward; one with commits that origin does not have stops the move.
  async syncLocalBranch(repo, branch) {
    const main = repoPath(repo);
    const fetched = await exec("git", ["-C", main, "fetch", "-q", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`], { timeout: 120000 }).catch(() => null);
    if (fetched?.code !== 0) return; // origin has no such branch: the worktree starts a new one
    const local = await exec("git", ["-C", main, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).catch(() => null);
    if (local?.code !== 0) return void await git(main, ["branch", "--track", branch, `origin/${branch}`]);
    const behind = await exec("git", ["-C", main, "merge-base", "--is-ancestor", branch, `origin/${branch}`]);
    if (behind.code !== 0) throw new Error(`the local branch ${branch} in ${repo} has commits that origin does not have. Push or remove them first.`);
    await git(main, ["branch", "-f", branch, `origin/${branch}`]);
  }

  // What would be lost if the space and its checkouts went now: null, or words for a toast.
  async cloudWorkAtRisk(space, branch) {
    for (const script of [workCheckScript(space.folder), instanceWorkCheckScript(remoteCodeDir(), branch)]) {
      const r = await exec("bash", ["-lc", script], { on: space.machine, timeout: 60000 }).catch((e) => ({ code: -1, stderr: String(e.message ?? e) }));
      if (r.code !== 0) throw new Error(`could not check the instance: ${(r.stderr || r.stdout || "").trim()}`);
      const risk = workAtRisk(r.stdout);
      if (risk) return risk;
    }
    return null;
  }

  async localWorkAtRisk(space, branch) {
    const folders = new Set([space.folder]);
    for (const repo of this.repos ?? await listRepos()) {
      const listed = await exec("git", ["-C", repoPath(repo), "worktree", "list", "--porcelain"]).catch(() => null);
      if (listed?.code === 0) for (const w of parseWorktrees(listed.stdout).filter((w) => w.branch === branch)) folders.add(w.path);
    }
    for (const folder of folders) {
      const r = await exec("bash", ["-c", workCheckScript(folder)]).catch((e) => ({ code: -1, stderr: String(e.message ?? e) }));
      if (r.code !== 0) throw new Error(`could not check ${folder}: ${(r.stderr || r.stdout || "").trim()}`);
      const risk = workAtRisk(r.stdout);
      if (risk) return `${risk} in ${folder.replace(home(), "~")}`;
    }
    return null;
  }

  // Starts a running issue again on the other host, or in another repo, from its pushed branch. A
  // cloud issue that stays on the cloud keeps its instance. Nothing moves while work is not pushed.
  moveIssue(queueId, space, change, cx) {
    const ident = identifierOf(space);
    if (!ident || this.moving.has(ident)) return;
    this.moveMenu = null; this.moveRepoFor = null;
    // The click's cx is valid only during the click; after that, `ui` is the spawn's cx.
    let ui = cx;
    const stage = (text) => { this.moving.set(ident, text); ui.notify(); };
    const report = { step: (text) => stage(text.replace(`Starting ${ident}: `, "")), log() {} };
    const fromHost = space.machine ? "cloud" : "local", fromRepo = repoOfFolder(space.folder);
    const to = { host: change.host ?? fromHost, repo: change.repo ?? fromRepo };
    stage("Reading the issue");
    cx.spawn(async (cx) => {
      ui = cx;
      try {
        this.apiKey ??= await loadApiKey();
        const node = (await gql(this.apiKey, ISSUE_QUERY, { id: ident })).issue;
        if (!node?.branchName) throw new Error("the issue has no branch name in Linear");
        const issue = parseIssue(node);
        stage("Checking for work that is not pushed");
        const risk = fromHost === "cloud" ? await this.cloudWorkAtRisk(space, issue.branchName) : await this.localWorkAtRisk(space, issue.branchName);
        if (risk) throw new Error(`it has ${risk}. Ask its agent to push, or discard the work, then move it again.`);
        const keepInstance = fromHost === "cloud" && to.host === "cloud";
        if (fromHost === "cloud" && !keepInstance && !(await this.awsLoggedIn())) throw new Error(AWS_EXPIRED);
        setIssueOverride(ident, to);
        stage("Closing its space");
        if (fromHost === "local") await this.cleanUpIssueSpace(space, ident, issue.branchName);
        else {
          run("space.close", { id: space.id, confirmed: true });
          forgetSpaceColor(space.id);
          if (!keepInstance) { stage("Terminating its instance"); await this.endInstance(space.machine, ident); }
        }
        await this.startIssue(issue, queueId, report, { from: `${fromHost === "cloud" ? "a cloud instance" : "this computer"}, in ${fromRepo}` });
        notify({ title: `Moved ${ident}`, body: `It runs ${to.host === "cloud" ? "on a cloud instance" : "on this computer"}, in ${to.repo}.` });
      } catch (e) {
        const closed = !spaces().some((s) => s.id === space.id);
        notify({ title: `Could not move ${ident}`, level: "error", body: closed
          ? `${e.message ?? e}\nIts old space is closed, and its work is pushed. Set the issue back to To Do in Linear, and the next poll starts it ${to.host === "cloud" ? "on a cloud instance" : "on this computer"}, in ${to.repo}.`
          : String(e.message ?? e) });
      } finally { this.moving.delete(ident); cx.notify(); }
    });
  }

  openMoveRepos(ident, host, cx) {
    this.moveRepoFor = { ident, host };
    this.repoFilter.set_value("");
    this.repoFilter.focus();
    cx.notify();
  }

  // The queue's issue spaces, also those that its filter no longer finds, with a Move menu on each.
  runningBox(queue, t) {
    const running = this.queueSpaces(queue.id).map((s) => ({ s, ident: identifierOf(s) })).filter((x) => x.ident);
    const menuRow = (id, label, onClick) => h_flex().id(id).h(REPO_ROW).px(8).flex_none().items_center().rounded(5).cursor_pointer()
      .text_size(12).hover((s) => s.bg(t.selected)).on_click((_e, cx) => onClick(cx)).child(label);
    const row = ({ s, ident }) => {
      const host = s.machine ? "cloud" : "local", repo = repoOfFolder(s.folder), stage = this.moving.get(ident);
      const repos = (this.repos ?? []).filter((r) => r !== repo && r.toLowerCase().includes(this.repoFilter.value().trim().toLowerCase()));
      return v_flex().gap(4)
        .child(h_flex().id(`running-${ident}`).gap(8).items_center().px(8).py(5).rounded(6).cursor_pointer().hover((st) => st.bg(t.hover))
          .tooltip("Open its space").on_click(() => run("space.select", { id: s.id }))
          .child(v_flex().flex_1().min_w(0).gap(2)
            .child(div().truncate().text_size(12).text_color(t.foreground).child(s.name))
            .child(div().text_color(stage ? t.accent : t.dim).child(stage ? `Moving: ${stage}` : `${host === "cloud" ? "Cloud" : "Local"} · ${repo ?? "?"}`)))
          .when(!stage, (e) => e.child(this.button(`move-${ident}`, "Move ▾", (cx) => {
            this.moveMenu = this.moveMenu === ident ? null : ident; this.moveRepoFor = null; this.loadRepos(cx); cx.notify();
          }, t))))
        .when(this.moveMenu === ident, (e) => e.child(v_flex().id(`move-menu-${ident}`).flex_none().p(4).rounded(7).border_1()
          .border_color(t.accent).bg(t.popover).on_mouse_down_out((_e, cx) => { this.moveMenu = null; this.moveRepoFor = null; cx.notify(); })
          .child(menuRow(`move-host-${ident}`, host === "cloud" ? `Move to this computer, in ${repo}` : `Move to a cloud instance, in ${repo}`,
            (cx) => this.moveIssue(queue.id, s, { host: host === "cloud" ? "local" : "cloud" }, cx)))
          .child(menuRow(`move-host-repo-${ident}`, `${host === "cloud" ? "Move to this computer" : "Move to a cloud instance"}, in another repo ›`,
            (cx) => this.openMoveRepos(ident, host === "cloud" ? "local" : "cloud", cx)))
          .child(menuRow(`move-repo-${ident}`, `Restart in another repo, ${host === "cloud" ? "on the same instance" : "on this computer"} ›`,
            (cx) => this.openMoveRepos(ident, host, cx)))
          .when(this.moveRepoFor?.ident === ident, (e) => e
            .child(div().px(8).pt(4).text_size(11).text_color(t.muted).child(`Repo ${this.moveRepoFor?.host === "cloud" ? "on a cloud instance" : "on this computer"}:`))
            .child(div().id(`move-repo-filter-${ident}`).flex_none().h(28).mx(4).px(8).flex().items_center().rounded(5).border_1()
              .border_color(t.border).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation())
              .child(Input.new(this.repoFilter).h_full().text_size(12)))
            .children(repos.slice(0, 12).map((r) => menuRow(`move-to-${ident}-${r}`, r, (cx) => this.moveIssue(queue.id, s, { repo: r, host: this.moveRepoFor.host }, cx)))))
          .child(div().px(8).pt(4).whitespace_normal().text_size(11).text_color(t.dim)
            .child("The work must be pushed. A fresh agent starts from the pushed branch, and its first message says where the work was."))));
    };
    return this.settingsGroup("running", `Running · ${running.length}`, t, v_flex().gap(2)
      .when(!running.length, (e) => e.child(div().text_color(t.dim).child("No agent runs for this queue now.")))
      .children(running.map(row)));
  }

  // A started issue becomes yours and in progress. This runs after the space opens, so a failed start
  // changes nothing in Linear.
  async claimOnStart(issue) {
    try {
      const input = claimInput(issue, this.viewerId, await this.statesFor(issue.teamId));
      if (!input) return;
      const data = await gql(this.apiKey, UPDATE_ISSUE, { id: issue.id, input });
      if (!data.issueUpdate.success) throw new Error("Linear did not save the change");
    } catch (e) {
      notify({ title: `Started ${issue.identifier}, but could not assign it or set In Progress`, body: String(e.message ?? e), level: "error" });
    }
  }

  // A queue made from a project the list already has a queue for opens that queue instead. Make
  // a second queue for one project by hand in the file.
  // `team` is { name, team } for a team's issues in no project; else `project` is a Linear project.
  addQueue({ project, team }, cx) {
    if (!this.queues) return;
    const existing = this.queues.find((c) => (team ? c.id === teamQueue(team).id : c.projectId === project.id));
    if (existing) return this.go({ kind: "queue", id: existing.id }, cx);
    cx.spawn(async (cx) => {
      const todoNames = await this.todoNames();
      const queue = team ? teamQueue(team, todoNames) : projectQueue(project, new Set(this.queues.map((c) => c.id)), todoNames);
      this.saveQueues([...this.queues, queue], cx);
      this.go({ kind: "queue", id: queue.id }, cx);
    });
  }

  createScratch(cx) {
    const name = this.newName.value().trim();
    if (!name || !this.queues) return;
    cx.spawn(async (cx) => {
      const queue = scratchQueue(name, new Set(this.queues.map((c) => c.id)), await this.todoNames());
      this.newName.set_value("");
      this.saveQueues([...this.queues, queue], cx);
      this.go({ kind: "queue", id: queue.id }, cx);
    });
  }

  // The names of your teams' Todo-type statuses, for the default Status condition. Empty when Linear
  // does not answer: the new queue then has no Status condition, and the toast says so.
  async todoNames() {
    try {
      this.apiKey ??= await loadApiKey();
      const states = (await Promise.all(this.teams.map((tm) => this.statesFor(tm.id)))).flat();
      return [...new Set(states.filter((st) => st.type === "unstarted").map((st) => st.name))];
    } catch (e) {
      notify({ title: "Could not read your teams' statuses", body: `The new queue has no Status condition. Add "Status is To Do" yourself. ${e.message ?? e}`, level: "error" });
      return [];
    }
  }

  // The queue's issue spaces keep running. No poll cleans them up after this, so they stay until you
  // close them.
  deleteQueue(id, cx) {
    if (this.confirmDelete !== id) { this.confirmDelete = id; return cx.notify(); }
    this.polls.delete(id);
    this.saveQueues(this.queues.filter((c) => c.id !== id), cx);
    this.go({ kind: "queues" }, cx);
  }

  button(id, label, onClick, t, { accent = false, danger = false } = {}) {
    return div().id(id).flex_none().px(7).h(22).flex().items_center().rounded(6).text_size(11).border_1().cursor_pointer()
      .when(accent, (e) => e.bg(t.accent).border_color(t.accent).text_color(t.accent_foreground).hover((s) => s.opacity(0.85)))
      .when(danger, (e) => e.border_color(t.ansi1).text_color(t.ansi1).hover((s) => s.bg(t.raised)))
      .when(!accent && !danger, (e) => e.text_color(t.muted).border_color(t.border).hover((s) => s.bg(t.raised).text_color(t.foreground)))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); }).child(label);
  }

  dot(color, t) { return div().size(7).flex_none().rounded_full().bg(color ?? t.dim); }

  groupHeading(label, count, t) {
    return div().px(10).pt(8).pb(2).text_size(11).font_semibold().text_color(t.muted).child(count == null ? label : `${label} · ${count}`);
  }

  stepper(id, label, value, onStep, t) {
    const arrow = (dir, glyph) => div().id(`${id}-${dir > 0 ? "up" : "down"}`).size(20).flex().flex_none().items_center().justify_center()
      .rounded(4).cursor_pointer().text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => onStep(dir, cx)).child(glyph);
    return h_flex().flex_none().gap(4).items_center()
      .child(div().text_color(t.muted).child(label))
      .child(h_flex().items_center().rounded(5).border_1().border_color(t.border)
        .child(arrow(-1, "−")).child(div().min_w(28).flex().justify_center().text_color(t.foreground).child(value)).child(arrow(1, "+")));
  }

  pollStatus(queue) {
    const clock = this.pollClock(queue.id);
    const last = clock.result ? `Last poll ${ago(new Date(clock.at).toISOString())} ago, took ${duration(clock.took)}: ${clock.result}` : "No poll yet";
    const nextMinutes = Math.max(0, Math.ceil((clock.at + queue.pollMinutes * 60000 - Date.now()) / 60000));
    return queue.paused ? `Paused · ${last}` : queue.pollMinutes ? `${last} · next in ${nextMinutes ? pollLabel(nextMinutes) : "<1m"}` : last;
  }

  // While a poll runs: what it does now, and for how long. Below: what this poll, or the last one, did.
  pollProgress(queue, t) {
    const clock = this.pollClock(queue.id), now = Date.now();
    const status = clock.running
      ? v_flex().gap(2)
        .child(div().text_color(t.accent).child(`Polling for ${duration(now - clock.at)}`))
        .child(div().whitespace_normal().text_color(t.foreground).child(`▸ ${clock.step} · ${duration(now - clock.stepAt)}`))
      : div().whitespace_normal().text_color(clock.failed ? t.ansi1 : t.dim).child(this.pollStatus(queue));
    const LOG_SHOWN = 8, log = clock.log.slice(-LOG_SHOWN);
    return v_flex().gap(3).child(status)
      .when(log.length > 0, (e) => e.child(v_flex().gap(1).pl(6).border_l(2).border_color(t.border)
        .when(clock.log.length > LOG_SHOWN, (e) => e.child(div().text_color(t.dim).child(`${clock.log.length - LOG_SHOWN} earlier lines`)))
        .children(log.map((l) => h_flex().gap(6).items_start()
          .child(div().flex_none().text_color(t.dim).child(`+${duration(l.at - clock.at)}`))
          .child(div().flex_1().min_w(0).whitespace_normal().text_color(l.level === "error" ? t.ansi1 : t.muted).child(l.text))))));
  }

  queueSettings(queue, t, cx) {
    const { id, maxAgents, pollMinutes, paused } = queue, running = this.polling.has(id);
    // Two boxes: what agents run with, and when the polls run. The poll status sits in the polling box.
    return v_flex().flex_none().px(10).py(7).gap(6).border_b(1).border_color(t.border).text_size(11)
      .child(this.settingsGroup("agent-settings", "Agents", t, h_flex().flex_wrap().gap_x(10).gap_y(5).items_center()
        .child(this.stepper("max-agents", "Max", String(maxAgents),
          (dir, cx) => this.updateQueue(id, { maxAgents: Math.min(MAX_AGENTS_LIMIT, Math.max(1, maxAgents + dir)) }, cx), t))
        .child(this.queueRepoChip(queue, t))
        .child(this.hostChip("queue-host", queue.host, config.agentHost, (cx) => this.updateQueue(id, { host: nextHost(queue.host) }, cx), t)))
        .children([this.repoPickerView(t)].filter(Boolean)))
      .child(this.settingsGroup("poll-settings", "Polling", t, v_flex().gap(5)
        .child(h_flex().flex_wrap().gap_x(10).gap_y(5).items_center()
          .child(this.stepper("poll-every", "Every", pollLabel(pollMinutes),
            (dir, cx) => this.updateQueue(id, { pollMinutes: stepPoll(pollMinutes, dir) }, cx), t))
          .child(div().flex_1())
          .child(this.button("pause", paused ? "▶ Resume" : "❚❚ Pause", (cx) => this.togglePause(id, cx), t, { accent: paused }))
          .child(this.button("poll-now", running ? "Polling…" : "Poll now", (cx) => this.poll(id, cx), t)))
        .child(this.pollProgress(queue, t))));
  }

  settingsGroup(id, title, t, body) {
    return v_flex().id(id).gap(5).px(8).pt(5).pb(7).rounded(7).border_1().border_color(t.border).bg(t.raised)
      .child(div().text_size(10).font_semibold().text_color(t.muted).child(title.toUpperCase()))
      .child(body);
  }

  message(text, t, error = false) {
    return div().p(10).text_size(12).whitespace_normal().text_color(error ? t.ansi1 : t.dim).child(text);
  }

  // `action` is an element that goes just before Refresh.
  header(title, t, { back, subtitle, version, action } = {}) {
    return h_flex().h(42).flex_none().px(10).gap(8).items_center().border_b(1).border_color(t.border)
      .when(Boolean(back), (e) => e.child(div().id("back").px(6).h(26).flex().items_center().rounded(6).cursor_pointer()
        .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => back(cx)).child("‹ Back")))
      .child(h_flex().flex_1().min_w(0).gap(6).items_baseline()
        .child(div().min_w(0).truncate().font_semibold().child(title))
        .when(Boolean(version), (e) => e.child(div().flex_none().text_size(10).text_color(t.dim).child(`v${version}`))))
      .when(Boolean(subtitle), (e) => e.child(div().flex_none().text_size(11).text_color(t.dim).child(subtitle ?? "")))
      .when(Boolean(action), (e) => e.child(action))
      .child(div().id("refresh").size(26).flex().flex_none().items_center().justify_center().rounded(7).cursor_pointer()
        .text_color(t.muted).tooltip(`Refresh, and read ${QUEUES_FILE} again`).hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => { this.optionLists.clear(); this.matches.clear(); this.refreshProjects(cx, true); cx.spawn((cx) => this.loadQueues(cx)); })
        .child(svg("mods/linear-queues/refresh.svg").size(13).when(this.loadingProjects && this.manual, (e) => e.spin(900))));
  }

  // A queue's color is the avatar color of its spaces, once it has one.
  queueColor(queue, t) {
    const color = (shared(PROJECT_COLORS_KEY) ?? {})[queue.id];
    return color ? t[color] ?? null : null;
  }

  queueRow(queue, t) {
    const running = spaces().filter((s) => issueQueueOf(s) === queue.id).length;
    const host = (queue.host ?? config.agentHost) === "cloud" ? "Cloud" : "Local";
    const meta = [queue.paused ? "Paused" : queue.pollMinutes ? `Polls every ${pollLabel(queue.pollMinutes)}` : "Polling off",
      `${running}/${queue.maxAgents} agents`, host].join(" · ");
    return v_flex().id(`queue-${queue.id}`).flex_none().px(10).py(7).gap(3).rounded(7).cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.go({ kind: "queue", id: queue.id }, cx))
      .child(h_flex().gap(8).items_center()
        .child(this.dot(this.queueColor(queue, t), t))
        .child(div().flex_1().min_w(0).truncate().child(queue.name)))
      .child(div().pl(15).text_size(11).text_color(t.dim).child(meta));
  }

  queuesPage(t) {
    const queues = this.queues ?? [];
    let body = null;
    if (this.queuesError) body = this.message(`${this.queuesError}. Fix the file, then press Refresh.`, t, true);
    else if (!this.queues) body = this.message(this.error ? `Could not load your Linear projects: ${this.error}` : "Loading…", t, Boolean(this.error));
    else if (!queues.length) body = this.message("No queues yet. A queue picks the Linear issues that agents work on. Start with a project.", t);
    return v_flex().size_full().min_h(0)
      .child(this.header("Linear Queues", t, { subtitle: this.queues ? String(queues.length) : "", version: this.version, action: this.settingsButton(t) }))
      .child(v_flex().id("queue-list").flex_1().min_h(0).overflow_y_scrollbar().p(6).gap(2)
        .when(Boolean(body), (e) => e.child(body))
        .children(queues.map((c) => this.queueRow(c, t))))
      .child(h_flex().flex_none().px(10).py(8).gap(8).items_center().border_t(1).border_color(t.border).text_size(11)
        .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(`~/.config/herdr-app/${QUEUES_FILE}`))
        .when(Boolean(this.queues), (e) => e.child(this.button("new-queue", "+ New queue", (cx) => this.go({ kind: "new" }, cx), t, { accent: true }))));
  }

  pickRow(id, name, meta, dotColor, hasQueue, onClick, t) {
    return v_flex().id(id).flex_none().px(10).py(7).gap(3).rounded(7).cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => onClick(cx))
      .child(h_flex().gap(8).items_center()
        .child(this.dot(dotColor, t))
        .child(div().flex_1().min_w(0).truncate().child(name))
        .when(hasQueue, (e) => e.child(div().flex_none().text_size(11).text_color(t.dim).child("has a queue ›"))))
      .when(Boolean(meta), (e) => e.child(div().pl(15).text_size(11).text_color(t.dim).child(meta)));
  }

  // The first step of "+ New queue": start from a project or a team, or from scratch with a name.
  newQueuePage(t) {
    const name = this.newName.value().trim();
    const card = (id) => v_flex().id(id).flex_none().p(10).gap(4).rounded(8).border_1().border_color(t.border).bg(t.raised);
    return v_flex().size_full().min_h(0)
      .child(this.header("New queue", t, { back: (cx) => this.go({ kind: "queues" }, cx) }))
      .child(v_flex().id("new-queue-choice").flex_1().min_h(0).overflow_y_scrollbar().p(10).gap(10).text_size(12)
        .child(card("from-project").cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.go({ kind: "new-project" }, cx))
          .child(h_flex().items_center().child(div().flex_1().font_semibold().child("Start with a project")).child(div().text_color(t.dim).child("›")))
          .child(div().whitespace_normal().text_size(11).text_color(t.muted)
            .child("Pick a project, or a team's issues in no project. The queue finds its issues, and you can change that later.")))
        .child(card("from-scratch")
          .child(div().font_semibold().child("Start from scratch"))
          .child(div().whitespace_normal().text_size(11).text_color(t.muted)
            .child("Name the queue, then add conditions on its page. It starts with Assignee is No one or Me, Status is To Do, and Blocked is not. Polling stays off until you turn it on."))
          .child(h_flex().gap(6).items_center()
            .child(div().id("new-name").flex_1().min_w(0).h(28).px(8).flex().items_center().rounded(5).border_1()
              .border_color(t.border).bg(t.background).cursor_text().child(Input.new(this.newName).h_full().text_size(12)))
            .child(this.button("create-scratch", "Create", (cx) => this.createScratch(cx), t, { accent: Boolean(name) })))));
  }

  projectPickPage(t, cx) {
    const filters = this.projectFilters;
    const shown = this.projects.filter((p) => projectMatches(p, filters, this.viewerId));
    const groups = groupBy(shown, PROJECT_GROUPS, (p) => p.statusType);
    const withQueue = new Set((this.queues ?? []).map((c) => c.projectId).filter(Boolean));
    const queueIds = new Set((this.queues ?? []).map((c) => c.id));
    const teamFilter = filters.find((f) => f.field === "team" && f.values.length);
    const teams = this.teams.filter((tm) => !teamFilter || teamFilter.values.includes(tm.key) !== teamFilter.negate);
    let body = null;
    if (this.error) body = this.message(this.error, t, true);
    else if (!this.projectsLoaded) body = this.message("Loading…", t);
    else if (!groups.length) body = this.message("No projects match these filters.", t);
    const project = (p) => this.pickRow(`pick-${p.id}`, p.name,
      [`${Math.round(p.progress * 100)}%`, shortDate(p.targetDate), p.leadId !== this.viewerId && p.leadName].filter(Boolean).join(" · "),
      p.statusColor, withQueue.has(p.id), (cx) => this.addQueue({ project: p }, cx), t);
    const team = ({ key }) => {
      const make = { name: `${key} issues in no project`, team: key };
      return this.pickRow(`pick-team-${key}`, make.name, null, null, queueIds.has(teamQueue(make).id), (cx) => this.addQueue({ team: make }, cx), t);
    };
    return v_flex().size_full().min_h(0)
      .child(this.header("Start with a project", t, { back: (cx) => this.go({ kind: "new" }, cx) }))
      .child(v_flex().id("new-queue").flex_1().min_h(0).overflow_y_scrollbar()
        .child(v_flex().flex_none().px(10).py(7).gap(6).text_size(11).border_b(1).border_color(t.border)
          .child(div().whitespace_normal().text_color(t.muted).child("Pick a project, or a team's issues in no project. You can change what the queue finds on its page."))
          .child(this.settingsGroup("project-filters", "Show projects where", t, v_flex().gap(5).children(this.conditionRows(this.projectEditor(), t, cx)))))
        .child(v_flex().flex_none().p(6).gap(2)
          .when(Boolean(body), (e) => e.child(body))
          .children(groups.flatMap((g) => [this.groupHeading(g.label, g.items.length, t), ...g.items.map(project)]))
          .when(teams.length > 0, (e) => e.child(this.groupHeading("Teams", null, t)).children(teams.map(team)))));
  }

  queuePage(t, cx) {
    const queue = this.queueById(this.view.id);
    const back = (cx) => this.go({ kind: "queues" }, cx);
    if (!queue) return v_flex().size_full().min_h(0).child(this.header("Queue", t, { back })).child(this.message("This queue is gone.", t));
    const id = queue.id;
    return v_flex().size_full().min_h(0)
      .child(this.header(queue.name, t, { back, action: this.deleteButton(id, t) }))
      .child(v_flex().id("queue-page").flex_1().min_h(0).overflow_y_scrollbar()
        .child(this.queueSettings(queue, t, cx))
        .child(v_flex().flex_none().px(10).py(7).gap(6).text_size(11)
          .child(this.runningBox(queue, t))
          .child(this.conditionsEditor(queue, t, cx))
          .child(this.matchesList(queue, t, cx))));
  }

  // The lists that the pickers show, as { value, label, hint, color }. Projects and teams are already
  // loaded. The others load once, when a picker or a chip first needs them; Refresh loads them again.
  optionItems(field, conditions, cx) {
    if (field === "project") return this.projectsLoaded ? { items: this.projects.map((p) => ({ value: p.id, label: p.name, hint: p.status, color: p.statusColor })) } : {};
    if (field === "team") return { items: this.teams.map((tm) => ({ value: tm.key, label: tm.name ?? tm.key, hint: tm.key })) };
    if (field === "priority") return { items: PRIORITIES.map(([value, label]) => ({ value, label })) };
    if (field === "projectStatus") return { items: PROJECT_GROUPS.map(([value, label]) => ({ value, label })) };
    if (field === "assignee" || field === "lead") {
      const people = this.optionList("assignee", cx);
      return { ...people, items: people.items && [{ value: ME, label: "Me" }, ...people.items] };
    }
    if (field !== "milestone") return this.optionList(field, cx);
    const projects = conditions.find((c) => c.field === "project" && !c.negate)?.values.filter((v) => v !== NONE) ?? [];
    if (!projects.length) return { items: [], note: "Add a Project condition first: milestones belong to a project." };
    return this.optionList(`milestone:${[...projects].sort().join(",")}`, cx);
  }

  optionList(key, cx) {
    if (!this.optionLists.has(key)) {
      const entry = { items: null, error: null };
      this.optionLists.set(key, entry);
      cx.spawn(async (cx) => {
        try { entry.items = await this.loadOptions(key); } catch (e) { entry.error = String(e.message ?? e); }
        cx.notify();
      });
    }
    return this.optionLists.get(key);
  }

  async loadOptions(key) {
    this.apiKey ??= await loadApiKey();
    const byLabel = (a, b) => a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: "base" });
    if (key === "label") {
      const filter = { or: [{ team: { null: true } }, { team: { key: { in: this.teams.map((tm) => tm.key) } } }] };
      const nodes = await allPages(this.apiKey, LABELS_QUERY, { filter }, (d) => d.issueLabels);
      return nodes.filter((l) => !l.isGroup)
        .map((l) => ({ value: l.id, label: l.parent ? `${l.parent.name} › ${l.name}` : l.name, hint: l.team?.key ?? "Workspace", color: l.color }))
        .sort(byLabel);
    }
    if (key === "assignee") {
      // "Me" is its own value (Linear's isMe), so you are left out of the people.
      const nodes = await allPages(this.apiKey, USERS_QUERY, {}, (d) => d.users);
      return [...nodes.filter((u) => u.id !== this.viewerId)
        .map((u) => ({ value: u.id, label: u.displayName || u.name, hint: u.displayName && u.displayName !== u.name ? u.name : "" })).sort(byLabel)];
    }
    if (key === "status") {
      const states = (await Promise.all(this.teams.map((tm) => this.statesFor(tm.id)))).flat();
      const types = ["triage", "backlog", "unstarted", "started", "completed", "canceled"];
      const byName = new Map();
      for (const st of states.sort((a, b) => types.indexOf(a.type) - types.indexOf(b.type) || a.position - b.position)) if (!byName.has(st.name)) byName.set(st.name, st);
      return [...byName.values()].map((st) => ({ value: st.name, label: st.name, color: st.color }));
    }
    const ids = key.slice("milestone:".length).split(",");
    const projects = await Promise.all(ids.map((id) => gql(this.apiKey, MILESTONES_QUERY, { id })));
    return projects.flatMap((d) => (d.project?.projectMilestones.nodes ?? [])
      .map((m) => ({ value: m.id, label: m.name, hint: ids.length > 1 ? d.project.name : "" }))).sort(byLabel);
  }

  valueLabel(field, value, conditions, cx) {
    if (value === NONE) return fieldOf(field).none;
    if (value === ME || ((field === "assignee" || field === "lead") && value === this.viewerId)) return "Me";
    if (value === BLOCKED) return fieldOf(field).fixed;
    const { items, error } = this.optionItems(field, conditions, cx);
    return items?.find((i) => i.value === value)?.label ?? (items || error ? "Unknown" : "…");
  }

  // An editor is what the condition rows edit: `conditions`, the `fields` it offers, and `set` to save.
  queueEditor(queue) {
    return {
      key: `queue:${queue.id}`, fields: FIELDS, conditions: toConditions(queue.filter) ?? [], add: "+ Add condition",
      set: (conditions, cx) => this.updateQueue(queue.id, { filter: toFilter(conditions) }, cx),
    };
  }

  projectEditor() {
    return {
      key: "projects", fields: PROJECT_FIELDS, conditions: this.projectFilters, add: "+ Add filter",
      set: (conditions, cx) => { this.projectFilters = conditions.filter((c) => c.values.length); saveProjectFilters(this.projectFilters); cx.notify(); },
    };
  }

  // A condition that loses its last value stays on screen as a pending one, so the picker stays put.
  pickValue(editor, field, value, cx) {
    const saved = editor.conditions;
    const current = saved.find((c) => c.field === field) ?? { field, negate: this.pending?.negate ?? false, values: [] };
    const next = { ...current, values: toggleValue(current.values, value) };
    const list = saved.some((c) => c.field === field) ? saved.map((c) => (c.field === field ? next : c)) : [...saved, next];
    this.pending = next.values.length ? null : { key: editor.key, field, negate: next.negate };
    editor.set(list, cx);
  }

  toggleNegate(editor, condition, cx) {
    if (!condition.values.length) { this.pending = { ...this.pending, negate: !this.pending.negate }; return cx.notify(); }
    editor.set(editor.conditions.map((c) => (c.field === condition.field ? { ...c, negate: !c.negate } : c)), cx);
  }

  removeCondition(editor, field, cx) {
    if (this.pending?.key === editor.key && this.pending.field === field) this.pending = null;
    if (this.condPicker?.key === editor.key && this.condPicker.field === field) this.condPicker = null;
    editor.set(editor.conditions.filter((c) => c.field !== field), cx);
  }

  // Delete takes a second click. After the first, the icon says so.
  deleteButton(id, t) {
    const armed = this.confirmDelete === id;
    return h_flex().id("delete").h(26).px(6).gap(5).flex_none().items_center().justify_center().rounded(7).cursor_pointer()
      .text_size(11).text_color(t.ansi1).when(armed, (e) => e.bg(t.hover))
      .tooltip(armed ? "Click again to delete this queue" : "Delete this queue").hover((s) => s.bg(t.hover))
      .on_mouse_down_out((_e, cx) => { if (this.confirmDelete === id) { this.confirmDelete = null; cx.notify(); } })
      .on_click((_e, cx) => this.deleteQueue(id, cx))
      .child(svg("mods/linear-queues/trash.svg").size(13))
      .when(armed, (e) => e.child(div().child("Delete?")));
  }

  // A press outside closes the picker before the chip's click arrives: see closeRepoPicker.
  openConditionPicker(editor, field, cx) {
    const closed = this.condPickerClosed, same = (p) => p?.key === editor.key && p.field === field;
    if (same(closed) && Date.now() - closed.at < 500) return;
    this.repoPicker = null; this.addMenu = null;
    this.condPicker = same(this.condPicker) ? null : { key: editor.key, field };
    this.condFilter.set_value("");
    if (this.condPicker) this.condFilter.focus();
    cx.notify();
  }

  closeConditionPicker(cx) {
    if (!this.condPicker) return;
    this.condPickerClosed = { ...this.condPicker, at: Date.now() };
    if (this.pending?.key === this.condPicker.key && this.pending.field === this.condPicker.field) this.pending = null;
    this.condPicker = null;
    cx.notify();
  }

  // Blocked has one value, so it is saved at once as "is not": the usual choice.
  addCondition(editor, field, cx) {
    this.addMenu = null;
    if (fieldOf(field).fixed) return editor.set([...editor.conditions, { field, negate: true, values: [BLOCKED] }], cx);
    this.pending = { key: editor.key, field, negate: false };
    this.condPicker = null;
    this.openConditionPicker(editor, field, cx);
  }

  // Setting a hand-written filter aside is the only way to edit it here, so it takes a second click.
  startOver(queue, cx) {
    if (this.confirmStartOver !== queue.id) { this.confirmStartOver = queue.id; return cx.notify(); }
    this.confirmStartOver = null;
    this.updateQueue(queue.id, { filter: {} }, cx);
  }

  // The open issues that the queue's filter finds now. They load again when the filter changes, and
  // each poll brings them up to date. An answer for a filter that changed since is dropped.
  matchesFor(queue, cx) {
    const key = JSON.stringify(queue.filter), entry = this.matches.get(queue.id);
    if (entry?.key === key) return entry;
    const next = { key, issues: null, error: null };
    this.matches.set(queue.id, next);
    if (!Object.keys(queue.filter).length) { next.issues = []; return next; }
    cx.spawn(async (cx) => {
      try {
        this.apiKey ??= await loadApiKey();
        const issues = await this.fetchIssues(queue.id);
        if (this.matches.get(queue.id) === next) next.issues = issues;
      } catch (e) { if (this.matches.get(queue.id) === next) next.error = String(e.message ?? e); }
      cx.notify();
    });
    return next;
  }

  // Started issues first, then Todo in the order polls start them (yours before unassigned), then the rest.
  matchesList(queue, t, cx) {
    const { issues, error } = this.matchesFor(queue, cx);
    const rank = (i) => ["started", "unstarted", "backlog", "triage"].indexOf(i.stateType);
    const order = pickupOrder(this.viewerId), sorted = [...(issues ?? [])].sort((a, b) => rank(a) - rank(b) || order(a, b));
    const spaceOf = new Map(spaces().map((s) => [identifierOf(s), s]).filter(([ident]) => ident));
    let note = null;
    if (error) note = this.message(`Could not load the issues: ${error}`, t, true);
    else if (!issues) note = this.message("Loading…", t);
    else if (!issues.length) note = this.message(Object.keys(queue.filter).length ? "No open issues match." : "Add a condition to see its issues.", t);
    const row = (issue) => {
      const space = spaceOf.get(issue.identifier);
      const ready = !space;
      const who = issue.assigneeId === this.viewerId ? "You" : issue.assigneeName ?? "Unassigned";
      return v_flex().id(`match-${issue.id}`).flex_none().px(8).py(5).gap(2).rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
        .tooltip(space ? "Open its space" : "Open in Linear")
        .on_click(() => (space ? run("space.select", { id: space.id }) : openUrl(issue.url)))
        .child(h_flex().gap(8).items_start()
          .child(div().flex_none().text_color(t.accent).child(issue.identifier))
          .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.foreground).child(issue.title)))
        .child(h_flex().gap(6).items_center().text_color(t.dim)
          .child(this.dot(issue.stateColor, t)).child(div().flex_none().child(issue.state))
          .child(div().flex_none().child(`· ${who}`))
          .when(issue.blockedBy.length > 0, (e) => e.child(div().flex_none().text_color(t.ansi1).child(`· blocked by ${issue.blockedBy.join(", ")}`)))
          .when(Boolean(space), (e) => e.child(div().flex_none().text_color(t.accent).child("· running")))
          .when(ready, (e) => e.child(div().flex_none().text_color(t.ansi2).child("· ready"))));
    };
    return this.settingsGroup("matches", issues ? `Matching issues · ${issues.length} open` : "Matching issues", t, v_flex().gap(1)
      .when(Boolean(note), (e) => e.child(note))
      .children(sorted.map(row)));
  }

  conditionsEditor(queue, t, cx) {
    if (!toConditions(queue.filter)) return this.settingsGroup("finds", "Finds", t, v_flex().gap(5)
      .child(div().whitespace_normal().text_color(t.muted)
        .child(`This filter was written by hand, and it does not fit the conditions below. Edit it in ${QUEUES_FILE}, or start over with conditions.`))
      .child(div().whitespace_normal().text_color(t.dim).font_family("monospace").child(JSON.stringify(queue.filter)))
      .child(h_flex().child(this.button("start-over", this.confirmStartOver === queue.id ? "Replace this filter?" : "Start over", (cx) => this.startOver(queue, cx), t, { danger: true })))
      .child(this.pollNote(t)));
    const editor = this.queueEditor(queue);
    return this.settingsGroup("finds", "Finds issues where", t, v_flex().gap(5)
      .children(this.conditionRows(editor, t, cx))
      .when(!editor.conditions.length, (e) => e.child(div().whitespace_normal().text_color(t.ansi3)
        .child("Add a condition. With none, this queue would find every issue in the workspace, so it does not poll.")))
      .child(this.pollNote(t)));
  }

  pollNote(t) {
    return div().whitespace_normal().text_color(t.dim).child("Polls start the issues these conditions find, one per free slot, unless the issue already has a space. A start assigns the issue to you.");
  }

  // The rows, each open picker, the add button and its menu.
  conditionRows(editor, t, cx) {
    const pending = this.pending?.key === editor.key && !editor.conditions.some((c) => c.field === this.pending.field) ? this.pending : null;
    const conditions = pending ? [...editor.conditions, { field: pending.field, negate: pending.negate, values: [] }] : editor.conditions;
    const unused = editor.fields.filter((f) => !conditions.some((c) => c.field === f.key));
    const open = (field) => this.condPicker?.key === editor.key && this.condPicker.field === field;
    const menu = this.addMenu === editor.key && unused.length > 0;
    return [
      ...conditions.flatMap((c) => [this.conditionRow(editor, c, conditions, t, cx), open(c.field) ? this.conditionPicker(editor, c, conditions, t, cx) : null]),
      unused.length ? h_flex().child(this.button(`add-${editor.key}`, editor.add, (cx) => {
        this.condPicker = null; this.repoPicker = null; this.addMenu = menu ? null : editor.key; cx.notify();
      }, t)) : null,
      menu ? v_flex().id(`add-menu-${editor.key}`).flex_none().p(4).rounded(7).border_1()
        .border_color(t.accent).bg(t.popover).on_mouse_down_out((_e, cx) => { this.addMenu = null; cx.notify(); })
        .children(unused.map((f) => h_flex().id(`add-${editor.key}-${f.key}`).h(REPO_ROW).px(8).flex_none().items_center().rounded(5).cursor_pointer()
          .text_size(12).hover((s) => s.bg(t.selected)).on_click((_e, cx) => this.addCondition(editor, f.key, cx)).child(f.label))) : null,
    ].filter(Boolean);
  }

  conditionRow(editor, condition, conditions, t, cx) {
    const { field, negate, values } = condition, def = fieldOf(field), id = `${editor.key}-${field}`;
    const text = values.map((v) => this.valueLabel(field, v, conditions, cx)).join(", ");
    const open = this.condPicker?.key === editor.key && this.condPicker.field === field;
    const box = (boxId) => h_flex().id(boxId).h(22).px(6).items_center().rounded(5).border_1().border_color(t.border).cursor_pointer()
      .hover((s) => s.bg(t.background)).on_mouse_down("left", (_e, cx) => cx.stop_propagation());
    return h_flex().id(`cond-${id}`).gap(6).items_center()
      .child(div().w(64).flex_none().text_color(t.muted).child(def.label))
      .child(box(`cond-op-${id}`).flex_none().text_color(t.foreground).tooltip("Click to switch between is and is not")
        .on_click((_e, cx) => { cx.stop_propagation(); this.toggleNegate(editor, condition, cx); }).child(negate ? "is not" : "is"))
      .child(def.fixed
        ? h_flex().h(22).px(6).flex_1().min_w(0).items_center().text_color(t.foreground).child(div().truncate().child(text))
        : box(`cond-values-${id}`).flex_1().min_w(0).gap(4)
          .when(open, (e) => e.border_color(t.accent))
          .on_click((_e, cx) => { cx.stop_propagation(); this.openConditionPicker(editor, field, cx); })
          .child(div().flex_1().min_w(0).truncate().text_color(text ? t.foreground : t.dim).child(text || "Pick…"))
          .child(div().flex_none().text_size(9).text_color(t.dim).child("▾")))
      .child(div().id(`cond-remove-${id}`).size(22).flex().flex_none().items_center().justify_center().rounded(5).cursor_pointer()
        .text_color(t.dim).hover((s) => s.bg(t.background).text_color(t.foreground)).tooltip("Remove")
        .on_click((_e, cx) => { cx.stop_propagation(); this.removeCondition(editor, field, cx); }).child("×"));
  }

  // Many values can be picked; a click on a row adds or removes it, and the picker stays open.
  conditionPicker(editor, condition, conditions, t, cx) {
    const { field, values } = condition, def = fieldOf(field), id = `${editor.key}-${field}`;
    const { items, error, note } = this.optionItems(field, conditions, cx);
    const filter = this.condFilter.value().trim().toLowerCase();
    const matches = (items ?? []).filter((i) => !filter || i.label.toLowerCase().includes(filter) || String(i.hint ?? "").toLowerCase().includes(filter));
    const SHOWN = 150;
    const noneRow = def.none && !filter ? [{ value: NONE, label: def.none }] : [];
    const meRow = matches[0]?.value === ME ? [matches.shift()] : [];
    const rows = [...meRow, ...noneRow, ...matches.slice(0, SHOWN)];
    let message = note ?? null;
    if (!message && error) message = `Could not load the list: ${error}`;
    else if (!message && !items) message = "Loading…";
    else if (!message && !matches.length) message = "Nothing matches";
    else if (!message && matches.length > SHOWN) message = `${matches.length - SHOWN} more: type to narrow the list`;
    const row = (item) => h_flex().id(`opt-${id}-${item.value}`).h(REPO_ROW).px(8).gap(8).flex_none().items_center().rounded(5).cursor_pointer()
      .hover((s) => s.bg(t.selected)).on_click((_e, cx) => this.pickValue(editor, field, item.value, cx))
      .child(div().w(12).flex_none().text_color(t.accent).child(values.includes(item.value) ? "✓" : ""))
      .when(Boolean(item.color), (e) => e.child(this.dot(item.color, t)))
      .child(div().flex_1().min_w(0).truncate().text_color(item.value === NONE ? t.muted : t.foreground).child(item.label))
      .when(Boolean(item.hint), (e) => e.child(div().flex_none().max_w(110).truncate().text_size(11).text_color(t.dim).child(String(item.hint ?? ""))));
    const height = Math.min(REPO_LIST_MAX_ROWS, rows.length + (message ? 1 : 0)) * REPO_ROW;
    return v_flex().id(`cond-picker-${id}`).flex_none().gap(3).p(5).rounded(7).border_1().border_color(t.accent).bg(t.popover)
      .text_size(12).on_mouse_down_out((_e, cx) => this.closeConditionPicker(cx))
      .child(div().id("cond-filter").flex_none().h(28).px(8).flex().items_center().rounded(5).border_1()
        .border_color(t.border).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(Input.new(this.condFilter).h_full().text_size(12)))
      .child(v_flex().flex_none().relative().h(height)
        .child(v_flex().id(`cond-list-${id}`).size_full().overflow_y_scroll()
          .children(rows.map(row))
          .when(Boolean(message), (e) => e.child(div().h(REPO_ROW).flex_none().px(8).flex().items_center().text_size(11)
            .text_color(error ? t.ansi1 : t.dim).child(message ?? ""))))
        .child(Scrollbar.vertical(`cond-list-${id}`).absolute().inset_0()));
  }

  // A press outside closes the picker before the chip's click arrives, so a click on the chip just
  // after that close must not open the picker again: the chip toggles.
  closeRepoPicker(cx) {
    if (!this.repoPicker) return;
    this.repoPickerClosed = { id: this.repoPicker.target, at: Date.now() };
    this.repoPicker = null;
    cx.notify();
  }

  openRepoPicker(target, current, fallback, cx) {
    const closed = this.repoPickerClosed;
    if (closed?.id === target && Date.now() - closed.at < 500) return;
    if (this.repoPicker?.target === target) {
      this.repoPicker = null;
      return cx.notify();
    }
    this.condPicker = null; this.addMenu = null;
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

  pickRepo(repo, cx) {
    const target = this.repoPicker.target;
    this.repoPicker = null;
    if (target === SETTINGS_TARGET) return this.saveSetting({ defaultRepo: repo }, cx);
    this.updateQueue(target, { repo }, cx);
  }

  // Opens in the panel under its chip. The first row clears the choice.
  repoPickerView(t) {
    const picker = this.repoPicker;
    if (!picker) return null;
    const filtering = Boolean(this.repoFilter.value().trim()), matches = this.repoMatches();
    const row = (id, label, checked, onClick, muted = false) => h_flex().id(id).h(REPO_ROW).px(8).gap(8).flex_none().items_center()
      .rounded(5).cursor_pointer().hover((s) => s.bg(t.selected)).on_click((_e, cx) => onClick(cx))
      .child(div().flex_1().min_w(0).truncate().text_color(muted ? t.muted : t.foreground).child(label))
      .child(div().flex_none().text_color(t.muted).child(checked ? "✓" : ""));
    let note = null;
    if (this.repos == null) note = "Loading repos…";
    else if (this.reposError) note = `Could not list repos: ${this.reposError}`;
    else if (!this.repos.length) note = `No git repos in ${codeDir().replace(home(), "~")}`;
    else if (!matches.length) note = "No repo matches";
    return v_flex().id("repo-picker").flex_none().gap(3).p(5).rounded(7).border_1().border_color(t.accent).bg(t.popover)
      .text_size(12).on_mouse_down_out((_e, cx) => this.closeRepoPicker(cx))
      .child(div().id("repo-filter").flex_none().h(28).px(8).flex().items_center().rounded(5).border_1()
        .border_color(t.border).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(Input.new(this.repoFilter).h_full().text_size(12)))
      // A scroll area needs a set height: the box gets one, and the list fills it.
      .child(v_flex().flex_none().relative().h(Math.min(REPO_LIST_MAX_ROWS, matches.length + (filtering ? 0 : 1) + (note ? 1 : 0)) * REPO_ROW)
        .child(v_flex().id("repo-list").size_full().overflow_y_scroll()
          .when(!filtering, (e) => e.child(row("repo-default", `Default (${picker.fallback})`, !picker.current, (cx) => this.pickRepo(null, cx), true)))
          .children(matches.map((r) => row(`repo-${r}`, r, r === picker.current, (cx) => this.pickRepo(r, cx))))
          .when(Boolean(note), (e) => e.child(div().h(REPO_ROW).flex_none().px(8).flex().items_center().text_size(11)
            .text_color(this.reposError ? t.ansi1 : t.dim).child(note ?? ""))))
        .child(Scrollbar.vertical("repo-list").absolute().inset_0()));
  }

  // A chosen repo shows in full; the default shows with "default" after it.
  queueRepoChip(queue, t) {
    const current = queue.repo, fallback = config.defaultRepo ?? "none";
    return h_flex().id("queue-repo").flex_none().h(22).px(6).gap(4).items_center().rounded(5).border_1().border_color(t.border)
      .cursor_pointer().text_size(11).hover((s) => s.bg(t.raised)).tooltip("Repo for new worktrees")
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); this.openRepoPicker(queue.id, current, fallback, cx); })
      .child(div().text_color(t.muted).child("Repo"))
      .child(div().text_color(t.foreground).child(current ?? fallback ?? "…"))
      .when(!current, (e) => e.child(div().text_color(t.dim).child("default")))
      .child(div().text_size(9).text_color(t.dim).child("▾"));
  }

  // A click moves to the next choice: the default, Local, Cloud. The default shows with "default" after it.
  hostChip(id, current, fallback, onClick, t) {
    const label = (host) => (host === "cloud" ? "Cloud" : "Local");
    return h_flex().id(id).flex_none().h(22).px(6).gap(4).items_center().rounded(5).border_1().border_color(t.border)
      .cursor_pointer().text_size(11).hover((s) => s.bg(t.raised))
      .tooltip("Where new agents run: this computer, or a cloud agent instance for each issue. Click to change.")
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); })
      .child(div().text_color(t.muted).child("Run on"))
      .child(div().text_color(t.foreground).child(label(current ?? fallback)))
      .when(!current, (e) => e.child(div().text_color(t.dim).child("default")));
  }

  settingsButton(t) {
    return div().id("open-settings").size(26).flex().flex_none().items_center().justify_center().rounded(7).cursor_pointer()
      .text_color(t.muted).tooltip("Settings: the agent command, the skill and the first message").hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => this.go({ kind: "settings" }, cx))
      .child(svg("mods/linear-queues/settings.svg").size(13));
  }

  loadSkills(cx) {
    cx.spawn(async (cx) => { this.skills = await listSkills(); cx.notify(); });
  }

  fillSettings() {
    const p = config.prompts;
    this.commandInput.set_value(p.command);
    this.templateInput.set_value(p.template);
    this.localNoteInput.set_value(p.localNote);
    this.cloudNoteInput.set_value(p.cloudNote);
    this.handoffNoteInput.set_value(p.handoffNote);
    this.form = { comments: p.comments };
    this.skillEdit = null; this.preview = null;
  }

  saveSetting(change, cx) {
    cx.spawn(async (cx) => { await saveConfig(change); cx.notify(); });
  }

  saveCommand(cx) {
    try { parseCommand(this.commandInput.value()); } catch (e) { return notify({ title: "Not saved", body: String(e.message ?? e), level: "error" }); }
    this.saveSetting({ agentCommand: this.commandInput.value().trim() }, cx);
  }

  // The first-message fields as prompt settings, saved or not, for the preview and the save.
  formPrompts() {
    return parsePrompts({ ...promptsToConfig(config.prompts), comments: this.form?.comments ?? config.prompts.comments,
      firstMessage: { template: this.templateInput.value(), localNote: this.localNoteInput.value(), cloudNote: this.cloudNoteInput.value(), handoffNote: this.handoffNoteInput.value() } });
  }

  firstMessageChanged() {
    const now = this.formPrompts(), saved = config.prompts;
    return ["template", "localNote", "cloudNote", "handoffNote", "comments"].some((k) => now[k] !== saved[k]);
  }

  saveFirstMessage(cx) {
    const { firstMessage, comments } = promptsToConfig(this.formPrompts());
    this.saveSetting({ firstMessage, comments }, cx);
  }

  resetFirstMessage(cx) {
    this.templateInput.set_value(DEFAULT_PROMPTS.template);
    this.localNoteInput.set_value(DEFAULT_PROMPTS.localNote);
    this.cloudNoteInput.set_value(DEFAULT_PROMPTS.cloudNote);
    this.handoffNoteInput.set_value(DEFAULT_PROMPTS.handoffNote);
    this.form = { comments: DEFAULT_PROMPTS.comments };
    cx.notify();
  }

  // Opens the skill's SKILL.md on the Settings page. Save writes it only if the file did not change
  // on disk since.
  openSkillEdit(name, cx) {
    if (this.skillEdit?.name === name) { this.skillEdit = null; return cx.notify(); }
    cx.spawn(async (cx) => {
      try {
        const original = await readSkill(name);
        this.skillInput.set_value(original);
        this.skillEdit = { name, original };
      } catch (e) { notify({ title: `Could not open ${name}`, body: String(e.message ?? e), level: "error" }); }
      cx.notify();
    });
  }

  saveSkill(cx) {
    const edit = this.skillEdit, text = this.skillInput.value();
    if (!edit || text === edit.original) return;
    cx.spawn(async (cx) => {
      try {
        await writeTextFile(skillPath(edit.name), text, edit.original);
        edit.original = text;
        notify({ title: `Saved the ${edit.name} skill`, body: "New agents use it. Cloud instances get a copy at their next start." });
      } catch (e) { notify({ title: `Did not save the ${edit.name} skill`, body: `It changed on disk since it was opened. Close it and open it again. ${e.message ?? e}`, level: "error" }); }
      cx.notify();
    });
  }

  // `current` is the chosen skill, or "" for none.
  skillChip(current, t) {
    return h_flex().id("skill").flex_none().h(22).px(6).gap(4).items_center().rounded(5).border_1()
      .border_color(this.skillMenu ? t.accent : t.border).cursor_pointer().text_size(11).hover((s) => s.bg(t.raised))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); this.skillMenu = !this.skillMenu; if (this.skillMenu) this.loadSkills(cx); cx.notify(); })
      .child(div().text_color(t.muted).child("Skill"))
      .child(div().text_color(t.foreground).child(current || "None"))
      .child(div().text_size(9).text_color(t.dim).child("▾"));
  }

  skillMenuView(current, onPick, t) {
    if (!this.skillMenu) return null;
    const skills = this.skills ?? [];
    const options = [{ value: "", label: "None: no skill command in the first message" },
      ...skills.map((name) => ({ value: name, label: name })),
      ...(current && !skills.includes(current) && this.skills ? [{ value: current, label: `${current} (not in ~/.claude/skills)` }] : [])];
    return v_flex().id("skill-menu").flex_none().p(4).rounded(7).border_1().border_color(t.accent).bg(t.popover).text_size(12)
      .on_mouse_down_out((_e, cx) => { this.skillMenu = false; cx.notify(); })
      .children(options.map((o) => h_flex().id(`skill-opt-${o.value || "none"}`).h(REPO_ROW).px(8).gap(8).flex_none().items_center()
        .rounded(5).cursor_pointer().hover((s) => s.bg(t.selected)).on_click((_e, cx) => { this.skillMenu = false; onPick(o.value, cx); })
        .child(div().w(12).flex_none().text_color(t.accent).child(o.value === current ? "✓" : ""))
        .child(div().flex_1().min_w(0).truncate().child(o.label))))
      .when(this.skills == null, (e) => e.child(div().px(8).text_size(11).text_color(t.dim).child("Loading skills…")));
  }

  toggleRow(id, label, hint, on, onClick, t) {
    return h_flex().id(id).gap(8).items_start().cursor_pointer().on_click((_e, cx) => onClick(cx))
      .child(div().size(14).mt(1).flex().flex_none().items_center().justify_center().rounded(3).border_1()
        .border_color(on ? t.accent : t.border).bg(on ? t.accent : t.background).text_size(10).text_color(t.accent_foreground).child(on ? "✓" : ""))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().text_color(t.foreground).child(label))
        .child(div().whitespace_normal().text_color(t.dim).child(hint)));
  }

  textField(id, label, state, t, { area = false } = {}) {
    return v_flex().gap(3)
      .child(div().text_color(t.muted).child(label))
      .child(div().id(id).px(8).py(area ? 5 : 0).when(!area, (e) => e.h(28)).flex().items_center().rounded(5).border_1()
        .border_color(t.border).bg(t.background).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(area ? Textarea.new(state).w_full().text_size(12).text_color(t.foreground) : Input.new(state).h_full().text_size(12)));
  }

  settingsPage(t, cx) {
    const p = config.prompts, back = (cx) => this.go({ kind: "queues" }, cx);
    if (this.skills == null && !this.loadingSkills) { this.loadingSkills = true; this.loadSkills(cx); }
    const commandChanged = this.commandInput.value().trim() !== p.command;
    const editing = this.skillEdit, skillChanged = editing && this.skillInput.value() !== editing.original;
    const changed = this.firstMessageChanged(), comments = this.form?.comments ?? p.comments;
    const setup = p.cloudSetup, toggleSetup = (key) => (cx) => this.saveSetting({ cloudSetup: { ...setup, [key]: !setup[key] } }, cx);
    return v_flex().size_full().min_h(0)
      .child(this.header("Settings", t, { back }))
      .child(v_flex().id("settings-page").flex_1().min_h(0).overflow_y_scrollbar().px(10).py(7).gap(8).text_size(11)
        .child(div().whitespace_normal().text_color(t.dim).child(`Saved in ~/.config/herdr-app/${CONFIG_FILE}.`))
        .child(this.settingsGroup("settings-agent", "Agent", t, v_flex().gap(6)
          .child(h_flex().gap(6).items_end()
            .child(div().flex_1().min_w(0).child(this.textField("agent-command", "Command that each agent runs", this.commandInput, t)))
            .child(this.button("save-command", "Save", (cx) => this.saveCommand(cx), t, { accent: commandChanged })))
          .child(div().whitespace_normal().text_color(t.dim).child("For example: claude --model opus. Quotes keep spaces in one word. Cloud instances run the same command, so it must be installed there."))
          .child(h_flex().flex_wrap().gap(8).items_center()
            .child(this.hostChip("settings-host", config.agentHost, "local", (cx) => this.saveSetting({ agentHost: config.agentHost === "cloud" ? "local" : "cloud" }, cx), t))
            .child(h_flex().id("settings-repo").flex_none().h(22).px(6).gap(4).items_center().rounded(5).border_1().border_color(t.border)
              .cursor_pointer().text_size(11).hover((s) => s.bg(t.raised)).tooltip("The repo for queues that pick none")
              .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
              .on_click((_e, cx) => { cx.stop_propagation(); this.openRepoPicker(SETTINGS_TARGET, config.defaultRepo, "none", cx); })
              .child(div().text_color(t.muted).child("Default repo"))
              .child(div().text_color(t.foreground).child(config.defaultRepo ?? "none"))
              .child(div().text_size(9).text_color(t.dim).child("▾"))))
          .children([this.repoPicker?.target === SETTINGS_TARGET ? this.repoPickerView(t) : null].filter(Boolean))))
        .child(this.settingsGroup("settings-skill", "Skill", t, v_flex().gap(6)
          .child(div().whitespace_normal().text_color(t.dim).child("The first message runs this skill, for example /start-issue CAL-123. The skills are the folders in ~/.claude/skills. Cloud instances get a copy of the skill at each start."))
          .child(h_flex().flex_wrap().gap(6).items_center()
            .child(this.skillChip(p.skill, t))
            .when(Boolean(p.skill), (e) => e.child(this.button("edit-skill", editing ? "Close SKILL.md" : "Edit SKILL.md", (cx) => this.openSkillEdit(p.skill, cx), t))))
          .children([this.skillMenuView(p.skill, (value, cx) => { this.skillEdit = null; this.saveSetting({ skill: value }, cx); }, t)].filter(Boolean))
          .when(Boolean(editing), (e) => e
            .child(div().text_color(t.dim).child(`~/.claude/skills/${editing?.name}/SKILL.md`))
            .child(this.textField("skill-text", "", this.skillInput, t, { area: true }))
            .child(h_flex().gap(6)
              .child(this.button("save-skill", "Save", (cx) => this.saveSkill(cx), t, { accent: Boolean(skillChanged) }))
              .child(this.button("revert-skill", "Revert", (cx) => { this.skillInput.set_value(editing.original); cx.notify(); }, t))))))
        .child(this.settingsGroup("settings-message", "First message", t, v_flex().gap(6)
          .child(this.textField("template", "Template", this.templateInput, t, { area: true }))
          .child(v_flex().gap(1).text_color(t.dim)
            .children(PLACEHOLDERS.map(([name, about]) => h_flex().gap(6).child(div().flex_none().font_family("monospace").text_color(t.muted).child(name)).child(div().whitespace_normal().child(about)))))
          .child(this.textField("local-note", "{{location}} on this computer", this.localNoteInput, t, { area: true }))
          .child(this.textField("cloud-note", "{{location}} on a cloud instance", this.cloudNoteInput, t, { area: true }))
          .child(this.textField("handoff-note", "{{handoff}} after a move. {{from}} says where the work was.", this.handoffNoteInput, t, { area: true }))
          .child(this.stepper("comments", "Newest comments in {{issue}}", String(comments),
            (dir, cx) => { this.form = { comments: Math.min(MAX_COMMENTS, Math.max(0, comments + dir)) }; cx.notify(); }, t))
          .child(h_flex().flex_wrap().gap(6)
            .child(this.button("save-message", "Save", (cx) => this.saveFirstMessage(cx), t, { accent: changed }))
            .child(this.button("reset-message", "Reset to defaults", (cx) => this.resetFirstMessage(cx), t))
            .child(div().flex_1())
            .child(this.button("preview-local", this.preview === "local" ? "Hide preview" : "Preview local", (cx) => { this.preview = this.preview === "local" ? null : "local"; cx.notify(); }, t))
            .child(this.button("preview-cloud", this.preview === "cloud" ? "Hide preview" : "Preview cloud", (cx) => { this.preview = this.preview === "cloud" ? null : "cloud"; cx.notify(); }, t)))
          .when(changed, (e) => e.child(div().text_color(t.ansi3).child("Not saved yet.")))
          .when(Boolean(this.preview), (e) => e.child(div().p(8).rounded(5).border_1().border_color(t.border).bg(t.background)
            .whitespace_normal().font_family("monospace").text_color(t.foreground)
            .child(startTask(SAMPLE_ISSUE, this.formPrompts(), { cloud: this.preview === "cloud" }))))))
        .child(this.settingsGroup("settings-cloud", "Cloud instances", t, v_flex().gap(6)
          .child(div().whitespace_normal().text_color(t.dim).child("Claude settings that the mod sets on each new instance. Any prompt stops the agent and loses its first message, so turn one off only if your image does it already."))
          .child(this.toggleRow("setup-mcp", "Approve the repo's MCP servers", "Sets enableAllProjectMcpServers.", setup.approveMcpServers, toggleSetup("approveMcpServers"), t))
          .child(this.toggleRow("setup-onboarding", "Skip Claude's first-run onboarding", "Sets hasCompletedOnboarding. Onboarding asks about trust even for a trusted folder.", setup.skipOnboarding, toggleSetup("skipOnboarding"), t))
          .child(this.toggleRow("setup-trust", "Trust the checkout", "Sets hasTrustDialogAccepted for the repo's folder.", setup.trustFolder, toggleSetup("trustFolder"), t)))));
  }

  render(cx) {
    const t = theme();
    const page = this.view.kind === "settings" ? this.settingsPage(t, cx) : this.view.kind === "queue" ? this.queuePage(t, cx) : this.view.kind === "new" ? this.newQueuePage(t) : this.view.kind === "new-project" ? this.projectPickPage(t, cx) : this.queuesPage(t);
    return v_flex().id("linear-queues").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background)
      .border_1().border_color(t.border).text_color(t.foreground).text_size(13).child(page);
  }
}
