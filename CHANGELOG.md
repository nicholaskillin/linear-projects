# Changelog

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
