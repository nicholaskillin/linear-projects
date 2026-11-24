# Linear Queues

A Herdr panel that runs Claude Code agents on your Linear issues. You set up queues: a queue picks a set of Linear issues and holds the settings for their agents. A timer in the mod starts an agent for each ready issue, in a space of its own and the issue's own git worktree, on this computer or on a cloud agent instance. It also cleans up finished ones. The timer uses plain code, so it spends no tokens.

The panel is for settings only. To read and change issues in Herdr, use the `linear` mod from planningcenter/herdr-mods.

## What it does

- **Queues:** a queue is a name, a Linear issue filter, and agent and poll settings. "+ New queue" asks how to start:
  - **Start with a project:** a list of the projects of all your Linear teams, and each team's issues in no project.
  - **Start from scratch:** type a name and press Create. The queue starts with only the default conditions, and its page opens so you can add the rest. Polling stays off until you turn it on.

  The project list has filter rows like a queue's conditions: "Lead", "Status" and "Team", each "is" or "is not" any of the values you pick. It starts with "Lead is Me" and "Status is In Progress, Planned, Paused, Backlog", and it keeps your filters after a reload. Pick one, and its queue finds every issue in that project or team.
- **Conditions:** the "Finds issues where" box on a queue's page edits what the queue finds, with no JSON. Each row is one condition, and all of them must match:
  - "+ Add condition" picks a field: Project, Team, Label, Assignee, Status, Priority, Milestone or Blocked.
  - Click the values to open a picker from Linear, with a filter box. Pick as many values as you want: the condition matches any of them. Project, Assignee and Milestone also offer "none", and Assignee offers "Me". For example, "Assignee is No one, Me".
  - "Blocked is not" leaves out issues that an open issue blocks. A blocker that is closed does not count.
  - A new queue starts with three conditions: "Assignee is No one, Me", "Status is" your teams' Todo statuses (for example "To Do"), and "Blocked is not". Change or remove them like any other condition.
  - Click "is" to switch to "is not", and × to remove the condition.
  - Labels come from the workspace and your teams. Milestones come from the projects in the Project condition.
  - A queue with no conditions does not poll, because it would find every issue in the workspace.
- **Running:** the queue's issue spaces, also those that its conditions no longer find (for example, an issue that is now In Progress). Click a row to open its space. "Move ▾" starts the issue again somewhere else:
  - **Move to this computer / Move to a cloud instance:** the same repo, on the other host.
  - **Move to this computer / a cloud instance, in another repo:** both at once.
  - **Restart in another repo:** the same host. A cloud issue keeps its instance, so there is no new launch.

  A move first checks that nothing would be lost: no uncommitted changes and no commits that are not pushed, in any repo, for the issue's branch. Then it closes the old space (and ends the instance when the issue leaves the cloud), saves the new host and repo for that issue, and starts a fresh agent from the pushed branch. The agent's first message says where the work was, with the `{{handoff}}` note from Settings. Later polls and cleanups follow the issue's new host and repo.
- **Matching issues:** below the conditions, the open issues that the queue finds now. Started issues come first, then Todo issues in the order polls start them. "running" means the issue has a space, and "ready" means the next poll can start it when a slot is free. Click a row to open its space, or the issue in Linear. The list loads again when the conditions change, and at each poll.
- **Any filter:** queues live in `~/.config/herdr-app/linear-queues.json`. For a filter that the conditions cannot express, edit its `filter` there. It takes any Linear [IssueFilter](https://studio.apollographql.com/public/Linear-API/variant/current/schema/reference/inputs/IssueFilter). The panel shows such a filter as text, and it changes it only if you press "Start over". The mod reads the file again every 15 seconds and when you press Refresh. A change in the panel is written to the file. If the file changed on disk since the mod read it, your hand edit wins, and the panel change is dropped with an error toast.
- **Settings:** the gear in the Linear Queues header opens the mod's settings. They are saved in `linear-queues-settings.json`:
  - **Agent:** the command that each agent runs (default `claude`; quotes keep spaces in one word), the default "Run on", and the default repo.
  - **Skill:** the skill that the first message runs, from the folders in `~/.claude/skills`, or none. "Edit SKILL.md" opens the skill's file in the panel. Cloud instances get a copy of the skill at each start.
  - **First message:** the template, with placeholders such as `{{skill}}`, `{{location}}` and `{{issue}}`, the notes for local and cloud agents, and how many of the newest comments go in. "Preview local" and "Preview cloud" show the message for a sample issue. "Reset to defaults" puts back the built-in text.
  - **Cloud instances:** whether the mod approves the repo's MCP servers, skips Claude's onboarding, and trusts the checkout on each new instance.
- **One space for each issue:** each issue's agent runs in a space named after the issue, for example "CAL-123 Fix the feed", with one Claude tab. Each queue's issue spaces share one avatar color.
- **Sidebar (optional):** the `project-spaces` sidebar shows issue spaces first, under one header for each queue, with local and cloud ones together. See "The project-spaces sidebar".
- **Agents box:**
  - "Max": the number of issue agents that can run at the same time, local and cloud together.
  - "Repo": the repo for new worktrees. The default is `defaultRepo`.
  - "Run on": Local or Cloud, or the default from `agentHost`. Click the chip to change it.
- **Polling box:** a poll interval from 1 minute to 2 hours, Pause/Resume, and Poll now. Agents start only from polls. While a poll runs, the box shows its current step and how long it has taken, and a log of what the poll did. The log of the last poll stays until the next one. Each poll does these steps:
  1. It closes the space of each issue that is Done or Canceled, and force-removes that issue's worktree. The local branch stays. For a cloud issue, see "Cloud agents".
  2. It starts the ready issues in the free slots. Ready means the queue's conditions find it and it has no space yet. The conditions decide everything else, so check them: a start assigns the issue to you, also when someone else has it, and it sets In Progress. The order is your issues first, then unassigned ones, then other people's; inside each group, milestone number, then priority, then Linear's order.
  3. When an issue's agent starts, the mod sets the team's first "started" status, for example "In Progress".
- **Delete:** the trash can next to the queue's name removes the queue from the file. It takes a second click. Its issue spaces keep running, but no poll cleans them up, so close them yourself.
- **Moving from 1.x:** the first time this version runs, each project with settings, a linked space or a running issue space, and each team view in `teamViews`, becomes a queue with the same settings. Their issue spaces stay in their group. A converted queue gets "Assignee is Me", "Status is To Do" and "Blocked is not", so it starts the same issues as 1.x did. Add "No one" to its Assignee condition to let it start unassigned issues too.

Worktrees use Herdr's layout: `~/.herdr/worktrees/<repo>/<branch>`, with the branch name that Linear suggests.

## Install

You need Herdr and Claude Code. You also need the Linear MCP server in Claude Code, which the skill uses only when you run `/start-issue` by hand.

1. Clone this repo and run the install script:
   ```sh
   git clone git@github.com:nicholaskillin/linear-projects.git
   cd linear-projects && ./install.sh
   ```
   It copies the mod to `~/.config/herdr-app/mods/linear-queues/` and the skill to `~/.claude/skills/start-issue/`. If you already have a different `start-issue` skill, the script first saves it as `SKILL.md.bak`.
2. Put your Linear API key (Linear › Settings › Security & access › Personal API keys) in `~/.config/herdr-app/linear.json`. The `linear` mod uses the same file.
   ```json
   { "apiKey": "lin_api_..." }
   ```
   Or set `LINEAR_API_KEY` in your shell. The key stays on your computer, and the mod sends it only to `api.linear.app`.
3. Optional: copy `linear-queues-settings.example.json` to `~/.config/herdr-app/linear-queues-settings.json`, and change it:
   - `codeDir`: the folder under your home folder that holds your git repos. The default is `Code`.
   - `defaultRepo`: the repo that a queue uses when it picks none. Without it, pick the queue's repo first.
   - `agentHost`: `"local"` (the default) or `"cloud"`, where new agents run when the queue did not pick.
4. Add the panel to your layout. In your layout file under `~/.config/herdr-app/layouts/`, add this block to a column, for example the right `panel` column:
   ```json
   { "id": "linear-queues", "type": "block", "size": { "weight": 1 }, "min": 160, "content": { "mod": "linear-queues" } }
   ```
   To show or hide the panel column, run `herdr-app do layout.toggle '{"id":"panel"}'`.

`install.sh` also installs the `project-spaces` sidebar mod. It shows only after a layout uses it: see the next section.

To update, run `git pull && ./install.sh`, then reload the mod. If you used this mod when it was named Linear Projects, `install.sh` switches your layouts to `linear-queues` and tells you to delete the old `mods/linear-projects` folder. The mod moves your old settings and contexts files to their new names when it first loads. The panel shows the installed version next to the "Linear Queues" title.

To install a fixed version, check out its tag first, for example `git checkout v1.0.0 && ./install.sh`. To go back to the latest, run `git checkout main && git pull && ./install.sh`.

## The project-spaces sidebar

To switch your layouts to the `project-spaces` sidebar, run this while Herdr is open:

```sh
./migrate.sh
```

It switches each layout that uses the stock `spaces` sidebar to `project-spaces`, after it asks. It saves each layout as `<name>.json.bak` first. To go back, restore the backup, or change `"project-spaces"` back to `"spaces"`.

Before version 1.3, each issue was a tab in its project's space. Version 2.0 cannot move those tabs. If you still have them, install 1.3.0 (`git checkout v1.3.0 && ./install.sh`), run its `./migrate.sh`, and then install the latest version.

`project-spaces` is a copy of Herdr's `spaces` sidebar (version 0.1.16) with the project groups added. It does not get Herdr's later changes to the stock sidebar.

## Cloud agents

An issue can run on a Planning Center cloud agent instance instead of this computer. Set "Run on" to Cloud for a queue, or set `agentHost` to `"cloud"`.

You need the [cloud-agent CLI](https://github.com/planningcenter/cloud-agent-cli) on your PATH and the `aws` command, with your login from `pco aws-login`.

A cloud start does these steps:

1. It refuses to start if the issue's branch has local commits that are not pushed, or if your AWS login has expired. The mod never lets `cloud-agent` open a browser to log in.
2. It runs `cloud-agent hc launch` to start one instance for the issue. The instance is added to Herdr as a machine named after the issue, for example `cal-123`.
3. On the instance, it checks out the issue's branch in the repo's main checkout, for example `~/Code/calendar`. It makes no worktree: the instance holds only this issue, and its main checkout is already set up. The branch comes from origin when it is there, else from origin's default branch. The script also installs the `start-issue` skill, approves the repo's MCP servers, and marks Claude's onboarding as done and the checkout as trusted, so that no prompt stops the agent.
4. The agent's first message tells it to work in that folder, to make no worktree, and to skip `box worktree setup` and `box worktree server`.
5. It opens the issue's space on that machine, with Claude in it.

When the issue is Done or Canceled, the poll checks the instance's checkout. If the checkout has uncommitted changes or commits that are not pushed, the poll keeps the instance and shows a toast. If not, it closes the space and terminates the instance. If the space closed before the issue did, for example because the agent exited, the poll finds the instance by its machine name. It then checks each checkout on the issue's branch, and it terminates the instance on the same terms.

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
- **Saved state.** Queues and their settings are in `linear-queues.json`. The mod saves which queue each issue space belongs to, and the queue colors, in Herdr's `shared.json`. Both stay on your computer.
- **Tests:** `node --test mod/*.test.js`.
- **License:** `api.js`, `env.js`, `open.js`, and `urls.js` come from the `linear` mod in planningcenter/herdr-mods. They are under the MIT license in `LICENSE.linear-mod`. `sidebar/project-spaces/main.js` is a changed copy of Herdr's `spaces` mod, under the Apache 2.0 license in `sidebar/project-spaces/LICENSE.herdr`.

## Contributing

Send changes as a pull request. Do not push to `main`.

1. Make a branch in your clone, and change the files in `mod/`, `sidebar/`, or `skills/`.
2. Run `./install.sh` to try your change in Herdr.
3. Open a pull request.

Do not change `VERSION` or `CHANGELOG.md` in a pull request. The owner sets the version at release time.

If you changed your installed copy instead, `./sync-from-local.sh` copies it back into your clone. Run it on your branch, and check the diff before you commit.
