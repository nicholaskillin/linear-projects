# Linear Projects

A Herdr panel for Linear projects that also runs your issue agents. The panel shows each project's issues, and it starts a Claude Code agent for each issue in a space of its own, in the issue's own git worktree, on this computer or on a cloud agent instance. A timer in the mod starts new agents and cleans up finished ones. The timer uses plain code, so it spends no tokens.

## What it does

- **Projects list:** the projects of all your Linear teams. "Lead" shows only the projects you lead, and "Show all" adds completed and canceled projects.
- **Follows Herdr:** when you switch to an issue's space or tab, for example `CAL-123`, the panel shows that issue. When you switch to a space linked to a project, the panel shows that project.
- **One space for each issue:** each issue's agent runs in a space named after the issue, for example "CAL-123 Fix the feed", with one Claude tab. Each project's issue spaces share one avatar color.
- **Project sidebar (optional):** the `project-spaces` sidebar shows issue spaces first, under one header for each project, with local and cloud ones together. See "Move to one space per issue".
- **Team views:** a team's open issues that are in no project, listed at the top of the projects list, for example "Calendar Core" for CAL. Set them with `teamViews` (see Install). A team view acts as a project: it can have a space, settings and polls.
- **Project page:**
  - Open issues, grouped by status and then by milestone. Each status has its own group, in Linear's order, so "In Progress" and "In Review" are separate.
  - Status groups that you can collapse.
  - "Mine" and "Unassigned" filters.
  - A red ⊘ on blocked issues.
  - The SLA of an issue that has one, for example "SLA 2d left" or "SLA breached 3h ago", in Linear's risk colors.
  - Buttons: "Start" or "Open" (an issue's agent space), and "Assign myself". "Start ☁" means the issue starts on a cloud agent.
- **Start:** when an issue's agent starts, the mod assigns the issue to you and sets the team's first "started" status, for example "In Progress". It does not move an issue that is already started, for example "In Review". This applies to Start, "Assign & start" and polls. A Start on someone else's issue makes you the assignee.
- **Issue page:**
  - Click the title or the description to edit it.
  - Change the status, and assign or unassign yourself.
  - The 10 latest comments.
- **Agents box:**
  - "Max": the number of issue agents that can run at the same time, local and cloud together.
  - "Repo": the repo for new worktrees. An issue can also pick its own repo on the issue page.
  - "Run on": Local or Cloud, or the default from `agentHost`. An issue can also pick its own on the issue page. Click the chip to change it.
- **Polling box:** a poll interval from 1 minute to 2 hours, Pause/Resume, and Poll now. Each poll does these steps:
  1. It closes the space of each issue that is Done or Canceled, and force-removes that issue's worktree. The local branch stays. For a cloud issue, see "Cloud agents".
  2. It starts your ready issues in the free slots. Ready means Todo, assigned to you, no open "blocked by" issue, and no space yet. The order is milestone number, then priority, then Linear's order.
  3. It does not start unassigned issues. When none of your issues is ready, a "Ready to pick up" row shows the unassigned ones, each with "Assign & start".
- **Polls need no space:** a project with polling turned on polls whether or not it has a space. "Create space" still makes a space for the project, in a worktree named after it, for work that is not one issue. The project-spaces sidebar shows it first under the project's header, above the issue spaces, in the project's color. "Link to this space" does the same for a space you already have.

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
   - `agentHost`: `"local"` (the default) or `"cloud"`, where new agents run when neither the project nor the issue picked.
   - `teamViews`: team views to list, each with a `name` and a team key, for example `[{ "name": "Calendar Core", "team": "CAL" }]`. The mod reads this file again at each refresh.
4. Add the panel to your layout. In your layout file under `~/.config/herdr-app/layouts/`, add this block to a column, for example the right `panel` column:
   ```json
   { "id": "linear-projects", "type": "block", "size": { "weight": 1 }, "min": 160, "content": { "mod": "linear-projects" } }
   ```
   To show or hide the panel column, run `herdr-app do layout.toggle '{"id":"panel"}'`.

`install.sh` also installs the `project-spaces` sidebar mod. It shows only after a layout uses it: see the next section.

To update, run `git pull && ./install.sh`, then reload the mod. The panel shows the installed version next to the "Projects" title.

To install a fixed version, check out its tag first, for example `git checkout v1.0.0 && ./install.sh`. To go back to the latest, run `git checkout main && git pull && ./install.sh`.

## Move to one space per issue

Before version 1.3, each issue was a tab in its project's space. To move an existing setup, run this while Herdr is open:

```sh
./migrate.sh
```

It asks before each step:

1. **Sidebar:** it switches each layout that uses the stock `spaces` sidebar to `project-spaces`. It saves each layout as `<name>.json.bak` first. To go back, restore the backup, or change `"project-spaces"` back to `"spaces"`.
2. **Issue tabs:** it moves each issue tab in a project space into a space of its own. The agents keep running. The panel shows a toast with what moved. The panel's projects list also has a "Move them" button while such tabs are left, and `herdr-app do linear-projects.move-issue-tabs` does the same.

It does not close any space. After the move, a project space that holds only a shell tab is no longer needed, and you can close it.

`project-spaces` is a copy of Herdr's `spaces` sidebar (version 0.1.16) with the project groups added. It does not get Herdr's later changes to the stock sidebar.

## Cloud agents

An issue can run on a Planning Center cloud agent instance instead of this computer. Set "Run on" to Cloud for a project or an issue, or set `agentHost` to `"cloud"`.

You need the [cloud-agent CLI](https://github.com/planningcenter/cloud-agent-cli) on your PATH and the `aws` command, with your login from `pco aws-login`.

A cloud start does these steps:

1. It refuses to start if the issue's branch has local commits that are not pushed, or if your AWS login has expired. The mod never lets `cloud-agent` open a browser to log in.
2. It runs `cloud-agent hc launch` to start one instance for the issue. The instance is added to Herdr as a machine named after the issue, for example `cal-123`.
3. On the instance, it makes the issue's worktree from origin, and installs the `start-issue` skill. It also approves the repo's MCP servers and trusts the worktree for Claude, so that no prompt stops the agent.
4. It opens the issue's space on that machine, with Claude in it.

When the issue is Done or Canceled, the poll checks the instance's worktree. If the worktree has uncommitted changes or commits that are not pushed, the poll keeps the instance and shows a toast. If not, it closes the space and terminates the instance.

An instance costs money while it runs. If you close a cloud issue's space by hand, the mod no longer tracks its instance: run `cloud-agent hc delete -s <issue ID in lower case>`.

## The `/start-issue` skill

The mod starts each agent with `claude` in the issue's worktree. The first message is `/start-issue <ID>` followed by the issue's text. The skill then does these steps:

1. It reads the acceptance criteria.
2. It makes the change and runs the related tests. For Planning Center apps in PCO Box, it uses `box worktree setup` and `box worktree server`.
3. It reports what changed, the acceptance criteria, the tests, and any open questions.

It does not commit, push, open a PR, or change Linear. If the work belongs in another repo, it moves to a worktree there and says so in the report.

You can also run `/start-issue CAL-123` by hand in any Claude Code session.

## Versions

The version is in `VERSION`, and `CHANGELOG.md` lists the changes in each version. Each release has a git tag, for example `v1.0.0`, and a GitHub release with the same notes.

The version uses three numbers, MAJOR.MINOR.PATCH:

- **MAJOR** goes up when an update needs you to do something, for example a new layout block or a changed settings file.
- **MINOR** goes up for new features.
- **PATCH** goes up for fixes.

To make a release (owner only):

1. Change `VERSION`, and add a section to the top of `CHANGELOG.md`.
2. Commit, then tag: `git tag v<version>`.
3. Push with the tag: `git push && git push --tags`.
4. Make the GitHub release: `gh release create v<version> --notes "<the changelog section>"`.

## Notes

- **Herdr must be open.** The mod does the timing, so polls run only while Herdr is open.
- **Force cleanup.** When an issue is Done or Canceled, the cleanup runs `git worktree remove --force`. Changes that are not committed in that worktree are lost.
- **Saved state.** The mod saves the space links, the project settings, and the repo choices in Herdr's `shared.json`, on your computer only.
- **Tests:** `node --test mod/*.test.js`.
- **License:** `api.js`, `env.js`, `open.js`, and `urls.js` come from the `linear` mod in planningcenter/herdr-mods. They are under the MIT license in `LICENSE.linear-mod`. `sidebar/project-spaces/main.js` is a changed copy of Herdr's `spaces` mod, under the Apache 2.0 license in `sidebar/project-spaces/LICENSE.herdr`.

## Contributing

Send changes as a pull request. Do not push to `main`.

1. Make a branch in your clone, and change the files in `mod/`, `sidebar/`, or `skills/`.
2. Run `./install.sh` to try your change in Herdr.
3. Open a pull request.

Do not change `VERSION` or `CHANGELOG.md` in a pull request. The owner sets the version at release time.

If you changed your installed copy instead, `./sync-from-local.sh` copies it back into your clone. Run it on your branch, and check the diff before you commit.
