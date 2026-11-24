// Pure helpers for issues that run on a cloud agent instance: one instance for each issue, added to Herdr
// as a machine by `cloud-agent hc launch`. No Herdr imports, so `node --test` can load this file.
import { identifierOf } from "./linear.js";

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

// Prints the folder the agent works in (see folderFrom): the repo's main checkout, on the issue's branch.
// An instance holds one issue, so it needs no worktree, and the image already set up the main checkout.
// A worktree there is not set up, so the repo's pre-commit hook blocks every commit. The branch comes
// from origin when someone pushed it, else it starts at origin/HEAD. A second run keeps the branch.
// Claude on a new instance has no skills, has not approved the repo's MCP servers, has not done its
// first-run onboarding, and does not trust the repo. The script copies the skill (`skillName` and its
// text `skill`; none when skillName is empty) and sets what `setup` turns on: see DEFAULT_PROMPTS.
export function setupScript({ codeDir, repo, branch, skillName = "", skill = "", setup = {} }) {
  if (skillName && skill.split("\n").includes(SKILL_END)) throw new Error(`the ${skillName} skill contains the heredoc end marker`);
  const state = [setup.skipOnboarding && ".hasCompletedOnboarding = true",
    setup.trustFolder && ".projects[$p] = ((.projects[$p] // {}) + {hasTrustDialogAccepted: true})"].filter(Boolean).join(" | ");
  return [
    "set -e",
    `path="$HOME/${codeDir}/"${shq(repo)}`,
    `cd "$path"`,
    `branch=${shq(branch)}`,
    `if [ "$(git branch --show-current)" != "$branch" ]; then`,
    `  if [ -n "$(git status --porcelain)" ]; then echo "$path has uncommitted changes, so the branch cannot be checked out" >&2; exit 1; fi`,
    "  git fetch -q origin",
    `  if git show-ref --verify --quiet "refs/heads/$branch"; then`,
    `    git checkout -q "$branch" >/dev/null`,
    `  elif git ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; then`,
    `    git fetch -q origin "+refs/heads/$branch:refs/remotes/origin/$branch"`,
    `    git checkout -q -b "$branch" --track "origin/$branch" >/dev/null`,
    "  else",
    `    git checkout -q --no-track -b "$branch" origin/HEAD >/dev/null`,
    "  fi",
    "fi",
    ...(skillName ? [
      `mkdir -p ~/.claude/skills/${shq(skillName)}`,
      `cat > ~/.claude/skills/${shq(skillName)}/SKILL.md <<'${SKILL_END}'`,
      skill.replace(/\n?$/, ""),
      SKILL_END,
    ] : []),
    ...(setup.approveMcpServers ? [
      "settings=~/.claude/settings.json",
      `[ -s "$settings" ] || echo '{}' > "$settings"`,
      `jq '.enableAllProjectMcpServers = true' "$settings" > "$settings.tmp" && mv "$settings.tmp" "$settings"`,
    ] : []),
    ...(state ? [
      "state=~/.claude.json",
      `[ -s "$state" ] || echo '{}' > "$state"`,
      `jq --arg p "$path" ${shq(state)} "$state" > "$state.tmp" && mv "$state.tmp" "$state"`,
    ] : []),
    `echo "${PATH_MARK}$path"`,
  ].join("\n");
}

// The repo's git hooks can print too, so the path has a mark of its own.
const PATH_MARK = "LINEAR_PROJECTS_FOLDER=";
export function folderFrom(output) {
  const line = output.split("\n").find((l) => l.startsWith(PATH_MARK));
  if (!line) throw new Error("the setup did not report its folder");
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

// workCheckScript for each checkout on the issue's branch, in any repo on the instance: a machine whose
// space is gone no longer names its folder. The image clones every repo, and a status of all of them
// takes minutes. A folder that git lists but that is gone holds nothing to lose.
export function instanceWorkCheckScript(codeDir, branch) {
  return [
    "set -e",
    `ref=refs/heads/${shq(branch)}`,
    `for repo in "$HOME/${codeDir}"/*/; do`,
    `  [ -e "$repo.git" ] || continue`,
    `  git -C "$repo" worktree list --porcelain | awk -v ref="$ref" '/^worktree /{w=substr($0,10)} $0=="branch " ref{print w}'`,
    "done | {",
    "  dirty=0 unpushed=0",
    "  while IFS= read -r w; do",
    `    [ -d "$w" ] || continue`,
    `    if [ -n "$(git -C "$w" status --porcelain)" ]; then dirty=1; continue; fi`,
    `    count=$(git -C "$w" rev-list --count HEAD --not --remotes=origin)`,
    "    unpushed=$((unpushed + count))",
    "  done",
    `  if [ "$dirty" = 1 ]; then echo dirty; elif [ "$unpushed" -gt 0 ]; then echo "unpushed $unpushed"; else echo clean; fi`,
    "}",
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
