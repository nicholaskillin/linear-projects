import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { machineName, isCloudSpace, parseHost, setupScript, workCheckScript, instanceWorkCheckScript, workAtRisk, folderFrom } from "./cloud.js";

const shq = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

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
test("setup checks out the branch in the main checkout, and the work check sees new commits", () => {
  const home = mkdtempSync(join(tmpdir(), "cloud-test-"));
  const sh = (script) => execFileSync("bash", ["-c", script], { env: { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: "/dev/null" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const commit = "git -c user.name=t -c user.email=t@t commit -q";
  sh(`set -e
    git init -q -b main "$HOME/origin" && cd "$HOME/origin"
    ${commit} --allow-empty -m first
    git branch pushed && git -c advice.detachedHead=false checkout -q pushed && ${commit} --allow-empty -m "pushed work" && git checkout -q main
    git clone -q "$HOME/origin" "$HOME/Code/calendar"
    mkdir -p "$HOME/.claude" && echo '{"theme":"dark"}' > "$HOME/.claude/settings.json"`);
  const main = `${home}/Code/calendar`;
  const skill = "---\nname: start-issue\n---\nUse 'quotes' and $VARS as they are.\n";
  const setup = { approveMcpServers: true, skipOnboarding: true, trustFolder: true };
  const script = setupScript({ codeDir: "Code", repo: "calendar", branch: "killin/cal-1-o'brien", skillName: "start-issue", skill, setup });
  assert.equal(folderFrom(sh(script)), main);
  assert.equal(sh(`git -C "${main}" branch --show-current`).trim(), "killin/cal-1-o'brien");
  assert.equal(sh(`git -C "${main}" rev-parse --abbrev-ref '@{upstream}' 2>/dev/null || echo none`).trim(), "none", "a new branch must not track origin/main");
  assert.equal(readFileSync(`${home}/.claude/skills/start-issue/SKILL.md`, "utf8"), skill);
  assert.deepEqual(JSON.parse(readFileSync(`${home}/.claude/settings.json`, "utf8")), { theme: "dark", enableAllProjectMcpServers: true });
  const state = JSON.parse(readFileSync(`${home}/.claude.json`, "utf8"));
  assert.equal(state.hasCompletedOnboarding, true);
  assert.equal(state.projects[main].hasTrustDialogAccepted, true);

  sh(`cd "${main}" && echo x > x.txt`);
  assert.equal(folderFrom(sh(script)), main, "a second run on the branch keeps the work");
  assert.equal(sh(workCheckScript(main)).trim(), "dirty");
  sh(`cd "${main}" && git add x.txt && ${commit} -m x`);
  assert.equal(sh(workCheckScript(main)).trim(), "unpushed 1");
  sh(`cd "${main}" && git push -q origin HEAD:refs/heads/cal-1 2>/dev/null && git fetch -q origin`);
  assert.equal(sh(workCheckScript(main)).trim(), "clean");

  const pushed = setupScript({ codeDir: "Code", repo: "calendar", branch: "pushed", skillName: "start-issue", skill, setup });
  sh(pushed);
  assert.equal(sh(`git -C "${main}" log -1 --format=%s`).trim(), "pushed work", "a branch on origin starts from origin's commits");

  sh(`cd "${main}" && echo y > y.txt`);
  assert.throws(() => sh(setupScript({ codeDir: "Code", repo: "calendar", branch: "other", skillName: "start-issue", skill, setup })), /uncommitted changes/);
});

test("setup with no skill and no Claude settings only checks out the branch", () => {
  const home = mkdtempSync(join(tmpdir(), "cloud-test-"));
  const sh = (script) => execFileSync("bash", ["-c", script], { env: { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: "/dev/null" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  sh(`set -e
    git init -q -b main "$HOME/origin" && cd "$HOME/origin" && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m first
    git clone -q "$HOME/origin" "$HOME/Code/calendar"`);
  const out = sh(setupScript({ codeDir: "Code", repo: "calendar", branch: "b", setup: { approveMcpServers: false, skipOnboarding: false, trustFolder: false } }));
  assert.equal(folderFrom(out), `${home}/Code/calendar`);
  assert.equal(existsSync(`${home}/.claude`), false, "no skill and no settings file");
  assert.equal(existsSync(`${home}/.claude.json`), false);
  const trustOnly = sh(setupScript({ codeDir: "Code", repo: "calendar", branch: "b", setup: { trustFolder: true } }));
  assert.ok(folderFrom(trustOnly));
  const state = JSON.parse(readFileSync(`${home}/.claude.json`, "utf8"));
  assert.equal(state.hasCompletedOnboarding, undefined);
  assert.equal(state.projects[`${home}/Code/calendar`].hasTrustDialogAccepted, true);
});

test("the instance work check looks at the issue's branch in every repo", () => {
  const home = mkdtempSync(join(tmpdir(), "cloud-test-"));
  const sh = (script) => execFileSync("bash", ["-c", script], { env: { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: "/dev/null" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const commit = "git -c user.name=t -c user.email=t@t commit -q";
  const branch = "killin/cal-1-o'brien";
  const check = () => sh(instanceWorkCheckScript("Code", branch)).trim();
  sh(`set -e
    git init -q -b main "$HOME/origin" && cd "$HOME/origin" && ${commit} --allow-empty -m first
    for r in calendar people chat; do git clone -q "$HOME/origin" "$HOME/Code/$r"; done
    mkdir "$HOME/Code/notes"
    git -C "$HOME/Code/calendar" worktree add -q -b ${shq(branch)} "$HOME/wt/old cal"
    git -C "$HOME/Code/people" checkout -q -b ${shq(branch)}
    git -C "$HOME/Code/chat" worktree add -q -b ${shq(branch)} "$HOME/wt/gone" && rm -rf "$HOME/wt/gone"
    cd "$HOME/Code/calendar" && git checkout -q -b other && ${commit} --allow-empty -m "another branch" && echo x > x.txt`);
  assert.equal(check(), "clean", "work on another branch is not the issue's");
  sh(`cd "$HOME/wt/old cal" && ${commit} --allow-empty -m a && cd "$HOME/Code/people" && ${commit} --allow-empty -m b`);
  assert.equal(check(), "unpushed 2", "counts commits in a worktree and in a main checkout");
  sh(`echo x > "$HOME/Code/people/x.txt"`);
  assert.equal(check(), "dirty");
});
