# Changelog

## 2.0.1 (2026-11-25)

### Fixes

- **Move an issue whose cloud instance is gone.** When a cloud issue's machine is unreachable and AWS no longer has its instance, "Move ▾" no longer refuses with "could not check the instance". It skips the check for work that is not pushed, because nothing on the instance can be recovered. It removes the dead machine and starts the new agent from the pushed branch, and the agent's first message says that only the pushed work is left. An unreachable instance that still exists keeps the check.
- **Shorter README.** The panel shows the details, and `CHANGELOG.md` has the rest.

## 2.0.0 (2026-11-24)

Linear Projects is now **Linear Queues**: a settings panel for queues of Linear issues that agents work through. A queue is any Linear issue filter, edited as conditions in the panel, with its own agents and polling. To read and change issues, use the `linear` mod from planningcenter/herdr-mods.

### Breaking changes

- **New name and folder.** The mod is `mods/linear-queues`. Its settings are in `linear-queues-settings.json`, and its queues in `linear-queues.json`. The mod moves your old `linear-projects.json` the first time it loads. `install.sh` switches your layouts to the new mod, each saved as `<name>.json.bak` first, and tells you to delete the old `mods/linear-projects` folder. Commands are now `linear-queues.refresh` and `linear-queues.settings`.
- **No issue views.** The project page's issue list, the issue page, Start, "Assign & start" and "Assign myself" are gone. Agents start only from polls.
- **Projects become queues.** The first time 2.0 runs, each project with settings, a linked space or a running issue space, and each team view in `teamViews`, becomes a queue with the same settings and ID. Running issue spaces keep their sidebar group and color. A converted queue gets "Assignee is Me", "Status is To Do" and "Blocked is not", so it starts the same issues as 1.x did.
- **No space for a queue.** "Create space", "Link to this space" and "Open in Linear" are gone. Each issue has its own space. A queue's Repo falls back to `defaultRepo`, not to the repo of a space.
- **No move of issue tabs from before 1.3.** To move such tabs, install 1.3.0 and run its `migrate.sh` first. `migrate.sh` now only switches layouts to the project-spaces sidebar.
- **The panel no longer follows the active space or tab.** It changes page only when you click.
- Removed: the repo and host choice for one issue on the issue page, and `teamViews` in the settings file (only the move to queues reads it).

### Queues

- **Conditions instead of JSON.** A queue's "Finds issues where" box edits its filter as rows: Project, Team, Label, Assignee, Status, Priority, Milestone and Blocked, each "is" or "is not" any of the values you pick, from pickers that Linear fills. Assignee can mix "No one", "Me" and people. A filter written by hand that the rows cannot show stays as it is.
- **The conditions decide everything.** A poll starts each issue that the conditions find and that has no space yet. A new queue starts with "Assignee is No one, Me", "Status is" your teams' To Do statuses, and "Blocked is not". A queue with no conditions does not poll.
- **Your issues start first,** then unassigned ones, then by milestone, priority and Linear's order.
- **Matching issues.** A queue's page lists the open issues its conditions find now, in the order polls start them, with "ready" for the next poll.
- **Running.** A queue's page lists its issue spaces, also those its conditions no longer find. Click one to open its space.
- **Move a running issue.** "Move ▾" restarts an issue on the other host (local or cloud), in another repo, or both, from its pushed branch. It refuses while any work is not pushed. A cloud issue that stays on the cloud keeps its instance. The new agent's first message says where the work was.
- **New queue.** Start with a project (filtered by Lead, Status and Team, like conditions), a team's issues in no project, or from scratch with a name.
- **Delete** is a red trash can next to the queue's name. It takes a second click.

### Settings

- **A Settings page** (gear in the Linear Queues header) for the agent command, the default host and repo, the skill (with an editor for its `SKILL.md`), the first-message template with its notes and placeholders, the number of comments, and the Claude settings for cloud instances. A preview shows the first message for a sample issue. The defaults give the same first message as 1.3.
- **Agents can change repo.** The default first message says that the repo is the queue's guess, and how to work in another repo.

### Polls

- **Polls show what they do:** the current step and how long it has taken, for example "Starting CAL-123: launching a cloud instance · 1m 40s", and a log of what the poll did and why. "Poll now" during a poll no longer resets it.

### Cloud agents

- **The main checkout, not a worktree.** A cloud start checks out the issue's branch in `~/Code/<repo>`, which the instance image already set up. In an instance worktree, the repo's pre-commit hook blocked commits.
- **No trust prompt.** The setup marks Claude's onboarding as done, so the agent starts its task with no "Do you trust this folder?" prompt.
- **Fix: a cleanup could lose work in another repo.** It checked only the space's folder. Now it also checks every checkout of the issue's branch on the instance.
- **Fix: an instance stayed when its space closed first,** for example when the agent exited. Each poll now ends cloud machines that have no space, once their issue is closed and nothing on them would be lost.

## 1.3.0 (2026-11-17)

Each issue gets a space of its own, issues can run on cloud agents, and a new sidebar groups issue spaces by project.

- **One space for each issue.** An issue's agent now starts in a space named after the issue, in the issue's worktree, not as a tab in the project's space. Each project's issue spaces share one avatar color. When the issue is Done or Canceled, the poll closes its space and removes its worktree.
- **Polls need no project space.** A project with polling turned on polls whether or not it has a space.
- **Cloud agents.** "Run on" in the Agents box and on the issue page picks Local or Cloud, and `agentHost` in `linear-projects.json` sets the default. A cloud issue runs on its own cloud agent instance, added to Herdr as a machine. The poll terminates the instance when the issue closes, but only when nothing on it would be lost. See "Cloud agents" in the README.
- **The `project-spaces` sidebar.** An optional copy of Herdr's spaces sidebar that shows issue spaces first, under one header for each project. `install.sh` installs it.
- **`migrate.sh`.** Moves an existing setup: it switches your layouts to the new sidebar and moves your issue tabs into spaces of their own, with the agents still running. It asks before each step. The panel also offers a "Move them" button while old issue tabs are left.
- **Project spaces join their project.** The space from "Create space", or a space you link to a project, now shows first under the project's header in the project-spaces sidebar, in the project's color. "Create space" also links the new space to its project, so the space stays with the project after a rename.
- **Fix: a failed start set the issue In Progress.** Once, Herdr made no space for a started issue and reported no error. The mod still set the issue In Progress, so later polls, which start only Todo issues, skipped it. Now the mod waits up to 20 seconds for the issue's space. If no space opens, you get an error toast, and Linear does not change.
- **Fix: a failed poll gave no reason.** A failed poll now shows an error toast with the reason.
- **Fix: hidden buttons on the project page.** The row with the status, the filters and the buttons now wraps, so a narrow panel shows all the buttons.
- Removed: the separate project space for issues in another repo. Each issue has its own space now.

## 1.2.0 (2026-11-16)

Team views for issues in no project, separate status groups, SLAs, and starts that set In Progress. This version also fixes a poll that closed a project's space.

- **Team views.** A new `teamViews` setting in `linear-projects.json` lists a team's open issues that are in no project, for example `[{ "name": "Calendar Core", "team": "CAL" }]`. Each team view shows at the top of the projects list. It acts as a project: it can have a space, settings and polls.
- **Unassigned filter.** The project page has an "Unassigned" filter next to "Mine", to find issues to pick up.
- **A group for each status.** Statuses of the same type now have their own groups, in Linear's order. For example, "In Progress" and "In Review" are separate.
- **SLAs.** An issue with an SLA shows it after its status, for example "SLA 2d left" or "SLA breached 3h ago". The color follows Linear's risk level.
- **Starts set In Progress.** When an issue's agent starts, the mod assigns the issue to you and sets the team's first "started" status, for example "In Progress". This applies to Start, "Assign & start" and polls. It does not move an issue that is already started, for example "In Review". If Linear does not save the change, the agent still runs and you get an error toast.
- **Fix: a poll closed the project's space.** Herdr closes a space with its last tab. When a poll cleaned up the last issue tab in a space, the space closed, and polls for that project stopped. Now the poll first opens a shell tab in the space. In a space made on the repo's main checkout, the shell opens in the project's worktree, so the sidebar still nests the space under its repo.
- **Fix: a poll started issues in a closed space.** After the cleanup, a poll now looks up the project's space again before it starts issues.

## 1.1.0 (2026-11-16)

New issues open in the background, and polls remove old worktrees that the issue cleanup missed.

- Issue tabs now open in the background. A started issue no longer takes over the screen while you work in another tab. The tab goes last in its space. This also applies to a new space for an issue in another repo. It uses `focus: false` on `tab.new` and `space.new`, which needs Herdr 0.1.16 or later.
- Polls now sweep old worktrees, at most once every 30 minutes. A poll cleans up a finished issue through its tab, so a worktree whose tab you closed yourself stayed on disk. The sweep removes a worktree under `~/.herdr/worktrees/` only when all of these are true:
  - It is on a branch, and Linear finds a completed, canceled or duplicate issue for that branch.
  - No Herdr space or terminal is in it.
  - It has no uncommitted changes and no untracked files.
  
  The branch stays, so commits that are not pushed are safe. The poll status shows "swept N old worktrees".

## 1.0.0 (2026-11-12)

The first shared version.

- Projects list for all your Linear teams, with "Lead" and "Show all" filters.
- The panel follows Herdr: a space shows its project, and an issue tab shows its issue.
- Project page: issues grouped by status and milestone, collapsible groups, a "Mine" filter, a blocked icon, Start/Open, and Assign myself.
- Issue page: edit the title and the description, change the status, assign or unassign yourself, and read the latest comments.
- Agents settings: Max agents, and a repo for each project or issue.
- Polling settings: an interval up to 2 hours, Pause/Resume, and Poll now. Polls clean up finished issues and start your ready issues, with no tokens.
- "Ready to pick up" row with "Assign & start" for unassigned issues.
- Create space, and separate spaces for issues in other repos.
- Optional settings file: `linear-projects.json` (`codeDir`, `defaultRepo`).
- The `/start-issue` skill.
