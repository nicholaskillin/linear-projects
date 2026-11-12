# Linear Projects

A Herdr panel for Linear projects that also runs your issue agents. Each Herdr space matches one Linear project. The panel shows the project's issues, and it starts a Claude Code agent for each issue in its own git worktree. A timer in the mod starts new agents and cleans up finished ones. The timer uses plain code, so it spends no tokens.

## What it does

- **Projects list:** the projects of all your Linear teams. "Lead" shows only the projects you lead, and "Show all" adds completed and canceled projects.
- **Follows Herdr:** when you switch to a space, the panel shows that space's project. When you switch to a tab named after an issue ID, for example `CAL-123`, the panel shows that issue.
- **Project page:**
  - Open issues, grouped by status and then by milestone.
  - Status groups that you can collapse.
  - A "Mine" filter.
  - A red ⊘ on blocked issues.
  - Buttons: "Start" or "Open" (an issue's agent tab), and "Assign myself".
- **Issue page:**
  - Click the title or the description to edit it.
  - Change the status, and assign or unassign yourself.
  - The 10 latest comments.
- **Agents box:**
  - "Max": the number of issue tabs that can be open at the same time.
  - "Repo": the repo for new worktrees. An issue can also pick its own repo on the issue page.
- **Polling box:** a poll interval from 1 minute to 2 hours, Pause/Resume, and Poll now. Each poll does these steps:
  1. It closes the tab of each issue that is Done or Canceled, and force-removes that issue's worktree. The local branch stays.
  2. It starts your ready issues in the free slots. Ready means Todo, assigned to you, no open "blocked by" issue, and no tab yet. The order is milestone number, then priority, then Linear's order.
  3. It does not start unassigned issues. When none of your issues is ready, a "Ready to pick up" row shows the unassigned ones, each with "Assign & start".
- **Create space:** for a project with no space, this makes a worktree of the project's repo named after the project, and a space in it.
- **Other repos:** an issue in a different repo starts in its own space for that repo, under `~/.herdr/worktrees/<repo>/<project>`.

Worktrees use Herdr's layout: `~/.herdr/worktrees/<repo>/<branch>`, with the branch name that Linear suggests.

## Install

You need Herdr and Claude Code. You also need the Linear MCP server in Claude Code, which the skill uses only when you run `/start-issue` by hand.

1. Clone this repo and run the install script:
   ```sh
   git clone git@github.com:nicholaskillin/linear-projects.git
   cd linear-projects && ./install.sh
   ```
   It copies the mod to `~/.config/herdr-app/mods/linear-projects/` and the skill to `~/.claude/skills/start-issue/`. If you already have a different `start-issue` skill, the script first saves it as `SKILL.md.bak`.
2. Put your Linear API key (Linear › Settings › Security & access › Personal API keys) in `~/.config/herdr-app/linear.json`. The `linear` mod uses the same file.
   ```json
   { "apiKey": "lin_api_..." }
   ```
   Or set `LINEAR_API_KEY` in your shell. The key stays on your computer, and the mod sends it only to `api.linear.app`.
3. Optional: copy `linear-projects.example.json` to `~/.config/herdr-app/linear-projects.json`, and change it:
   - `codeDir`: the folder under your home folder that holds your git repos. The default is `Code`.
   - `defaultRepo`: the repo that "Create space" uses when a project has no repo. Without it, pick the project's repo first.
4. Add the panel to your layout. In your layout file under `~/.config/herdr-app/layouts/`, add this block to a column, for example the right `panel` column:
   ```json
   { "id": "linear-projects", "type": "block", "size": { "weight": 1 }, "min": 160, "content": { "mod": "linear-projects" } }
   ```
   To show or hide the panel column, run `herdr-app do layout.toggle '{"id":"panel"}'`.

To update, run `git pull && ./install.sh`, then reload the mod.

## The `/start-issue` skill

The mod starts each agent with `claude` in the issue's worktree. The first message is `/start-issue <ID>` followed by the issue's text. The skill then does these steps:

1. It reads the acceptance criteria.
2. It makes the change and runs the related tests. For Planning Center apps in PCO Box, it uses `box worktree setup` and `box worktree server`.
3. It reports what changed, the acceptance criteria, the tests, and any open questions.

It does not commit, push, open a PR, or change Linear. If the work belongs in another repo, it moves to a worktree there and says so in the report.

You can also run `/start-issue CAL-123` by hand in any Claude Code session.

## Notes

- **Herdr must be open.** The mod does the timing, so polls run only while Herdr is open.
- **Force cleanup.** When an issue is Done or Canceled, the cleanup runs `git worktree remove --force`. Changes that are not committed in that worktree are lost.
- **Saved state.** The mod saves the space links, the project settings, and the repo choices in Herdr's `shared.json`, on your computer only.
- **Tests:** `node --test mod/orchestrator.test.js`.
- **License:** `api.js`, `env.js`, `open.js`, and `urls.js` come from the `linear` mod in planningcenter/herdr-mods. They are under the MIT license in `LICENSE.linear-mod`.

## Contributing

Send changes as a pull request. Do not push to `main`.

1. Make a branch in your clone, and change the files in `mod/` or `skills/`.
2. Run `./install.sh` to try your change in Herdr.
3. Open a pull request.

If you changed your installed copy instead, `./sync-from-local.sh` copies it back into your clone. Run it on your branch, and check the diff before you commit.
