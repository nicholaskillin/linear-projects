// Pure helpers for issues that run on a cloud agent instance: one instance for each issue, added to Herdr
// as a machine by `cloud-agent hc launch`. No Herdr imports, so `node --test` can load this file.
import { identifierOf } from "./linear.js";
import { worktreeSlug } from "./orchestrator.js";

export const HOSTS = ["local", "cloud"];
export const AWS_PROFILE = "planningcenter-cloud-agents";

export const parseHost = (value) => (HOSTS.includes(value) ? value : null);

// hc machine names are 1-32 of a-z 0-9 . _ -, starting with a letter or digit. An issue ID such as
// CAL-1462 always fits, so the machine, and the cloud-agent session, are named after the issue.
export function machineName(ident) {
  const name = ident.toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,31}$/.test(name)) throw new Error(`${ident} is not a valid machine name`);
  return name;
}

// A cloud issue's space lives on the machine named after its issue.
export function isCloudSpace(space) {
  const ident = identifierOf(space);
  return Boolean(space?.machine && ident && space.machine === machineName(ident));
}

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const SKILL_END = "LINEAR_PROJECTS_SKILL_END";

// Prints the worktree's path (see worktreeFrom). The branch comes from origin when someone pushed it,
// else it starts at origin/HEAD. A second run reuses the worktree. Claude on a new instance has no
// start-issue skill, has not approved the repo's MCP servers, and does not trust the new folder. The
// script sets up all three, because either prompt stops the agent and loses its first message.
export function setupScript({ codeDir, repo, branch, skill }) {
  if (skill.split("\n").includes(SKILL_END)) throw new Error("the start-issue skill contains the heredoc end marker");
  const path = `$HOME/.herdr/worktrees/${repo}/${worktreeSlug(branch)}`;
  return [
    "set -e",
    `cd "$HOME/${codeDir}/"${shq(repo)}`,
    `path="${path}"`,
    `if [ ! -d "$path" ]; then`,
    "  git fetch -q origin",
    `  if git ls-remote --exit-code --heads origin ${shq(branch)} >/dev/null 2>&1; then`,
    `    git fetch -q origin ${shq(branch)}`,
    `    git worktree add -q -b ${shq(branch)} "$path" FETCH_HEAD >/dev/null`,
    "  else",
    `    git worktree add -q -b ${shq(branch)} "$path" origin/HEAD >/dev/null`,
    "  fi",
    "fi",
    "mkdir -p ~/.claude/skills/start-issue",
    `cat > ~/.claude/skills/start-issue/SKILL.md <<'${SKILL_END}'`,
    skill.replace(/\n?$/, ""),
    SKILL_END,
    "settings=~/.claude/settings.json",
    `[ -s "$settings" ] || echo '{}' > "$settings"`,
    `jq '.enableAllProjectMcpServers = true' "$settings" > "$settings.tmp" && mv "$settings.tmp" "$settings"`,
    "state=~/.claude.json",
    `[ -s "$state" ] || echo '{}' > "$state"`,
    `jq --arg p "$path" '.projects[$p] = ((.projects[$p] // {}) + {hasTrustDialogAccepted: true})' "$state" > "$state.tmp" && mv "$state.tmp" "$state"`,
    `echo "${PATH_MARK}$path"`,
  ].join("\n");
}

// The repo's git hooks can print too, so the path has a mark of its own.
const PATH_MARK = "LINEAR_PROJECTS_WORKTREE=";
export function worktreeFrom(output) {
  const line = output.split("\n").find((l) => l.startsWith(PATH_MARK));
  if (!line) throw new Error("the setup did not report its worktree");
  return line.slice(PATH_MARK.length).trim();
}

// "dirty", "unpushed <count>" or "clean". Commits count as pushed when origin has them on any branch.
export function workCheckScript(path) {
  return [
    "set -e",
    `cd ${shq(path)}`,
    `if [ -n "$(git status --porcelain)" ]; then echo dirty; exit 0; fi`,
    "count=$(git rev-list --count HEAD --not --remotes=origin)",
    `if [ "$count" -gt 0 ]; then echo "unpushed $count"; else echo clean; fi`,
  ].join("\n");
}

// What the check found, as words for a toast; null when nothing would be lost.
export function workAtRisk(output) {
  const text = output.trim();
  if (text === "clean") return null;
  if (text === "dirty") return "uncommitted changes";
  const unpushed = text.match(/^unpushed (\d+)$/);
  if (unpushed) return `${unpushed[1]} commit${unpushed[1] === "1" ? "" : "s"} that ${unpushed[1] === "1" ? "is" : "are"} not pushed`;
  throw new Error(`unexpected work check output: ${text}`);
}
