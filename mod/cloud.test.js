import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { machineName, isCloudSpace, parseHost, setupScript, workCheckScript, workAtRisk, worktreeFrom } from "./cloud.js";

test("machine names come from the issue ID", () => {
  assert.equal(machineName("CAL-1462"), "cal-1462");
  assert.throws(() => machineName("-bad"));
});

test("a cloud space is a named issue space on the machine named after its issue", () => {
  assert.equal(isCloudSpace({ named: true, name: "CAL-1462 Mark groups", machine: "cal-1462" }), true);
  assert.equal(isCloudSpace({ named: true, name: "CAL-1462 Mark groups", machine: null }), false);
  assert.equal(isCloudSpace({ named: true, name: "CAL-1462", machine: "spike-test" }), false);
});

test("host settings accept only local and cloud", () => {
  assert.equal(parseHost("cloud"), "cloud");
  assert.equal(parseHost("Cloud"), null);
});

test("work at risk", () => {
  assert.equal(workAtRisk("clean\n"), null);
  assert.equal(workAtRisk("dirty"), "uncommitted changes");
  assert.equal(workAtRisk("unpushed 1"), "1 commit that is not pushed");
  assert.equal(workAtRisk("unpushed 3"), "3 commits that are not pushed");
  assert.throws(() => workAtRisk("huh"));
});

// Runs the real scripts in a scratch HOME with an origin repo, like an instance's ~/Code/<repo>.
test("setup makes the worktree and the skill, and the work check sees new commits", () => {
  const home = mkdtempSync(join(tmpdir(), "cloud-test-"));
  const sh = (script) => execFileSync("bash", ["-c", script], { env: { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: "/dev/null" }, encoding: "utf8" });
  sh(`set -e
    git init -q -b main "$HOME/origin" && cd "$HOME/origin"
    git -c user.name=t -c user.email=t@t commit -q --allow-empty -m first
    git clone -q "$HOME/origin" "$HOME/Code/calendar"
    mkdir -p "$HOME/.claude" && echo '{"theme":"dark"}' > "$HOME/.claude/settings.json"`);
  const skill = "---\nname: start-issue\n---\nUse 'quotes' and $VARS as they are.\n";
  const script = setupScript({ codeDir: "Code", repo: "calendar", branch: "killin/cal-1-o'brien", skill });
  const path = worktreeFrom(sh(script));
  assert.equal(path, `${home}/.herdr/worktrees/calendar/killin-cal-1-o-brien`);
  assert.equal(sh(`git -C "${path}" branch --show-current`).trim(), "killin/cal-1-o'brien");
  assert.equal(readFileSync(`${home}/.claude/skills/start-issue/SKILL.md`, "utf8"), skill);
  assert.deepEqual(JSON.parse(readFileSync(`${home}/.claude/settings.json`, "utf8")), { theme: "dark", enableAllProjectMcpServers: true });
  assert.equal(JSON.parse(readFileSync(`${home}/.claude.json`, "utf8")).projects[path].hasTrustDialogAccepted, true);
  assert.equal(worktreeFrom(sh(script)), path, "a second run reuses the worktree");

  assert.equal(sh(workCheckScript(path)).trim(), "clean");
  sh(`cd "${path}" && echo x > x.txt`);
  assert.equal(sh(workCheckScript(path)).trim(), "dirty");
  sh(`cd "${path}" && git add x.txt && git -c user.name=t -c user.email=t@t commit -q -m x`);
  assert.equal(sh(workCheckScript(path)).trim(), "unpushed 1");
  sh(`cd "${path}" && git push -q origin HEAD:refs/heads/cal-1 2>/dev/null && git fetch -q origin`);
  assert.equal(sh(workCheckScript(path)).trim(), "clean");
});
