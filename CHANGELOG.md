# Changelog

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
