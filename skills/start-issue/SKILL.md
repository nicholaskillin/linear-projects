---
name: start-issue
description: Start work on a Linear issue in its own git worktree, from the issue's acceptance criteria to passing tests, then report what changed. Use when the user runs /start-issue <ISSUE-ID>, for example /start-issue CAL-2195.
argument-hint: <ISSUE-ID>
---

Work on a Linear issue from start to passing tests, in its own git worktree. The first word of `$ARGUMENTS` is the issue ID, for example `CAL-2195`.

Do not stop for approval of a plan. The issue description holds the acceptance criteria. Ask the user only when you have a real question that the issue, its comments, and the code do not answer.

Do not commit, push, open a pull request, or change the issue in Linear. The user does those.

## 1. Read the issue

When the linear-projects mod starts you, the issue's title, branch, description, and latest comments follow the ID in `$ARGUMENTS`. Use them, and do not get the issue again from Linear. Read older comments with the Linear MCP tools only when the text says that there are more and you need them.

When `$ARGUMENTS` holds only the ID, use the Linear MCP tools:

1. Get the issue. Note its title, description, acceptance criteria, milestone, and suggested git branch name.
2. List its comments. Later comments can change or add to the description.

If the issue does not exist, stop and tell the user.

## 2. Use the worktree

When the mod starts you, your current folder is already the issue's worktree, on the issue's branch. Use it:

```sh
WORKTREE=$(pwd)
```

When you run by hand, check with `git branch --show-current`. If the current folder is not on the issue's branch, make or reuse the worktree. It follows Herdr's convention, `~/.herdr/worktrees/<repo>/<branch, with each run of characters other than A-Z a-z 0-9 . _ - changed to ->`:

```sh
MAIN=$(git worktree list --porcelain | awk 'NR==1 {print $2}')
BRANCH="<the issue's branch name>"
SLUG=$(printf %s "$BRANCH" | sed -E 's/[^A-Za-z0-9._-]+/-/g; s/^-+|-+$//g')
WORKTREE="$HOME/.herdr/worktrees/$(basename "$MAIN")/$SLUG"
```

1. If `git -C "$MAIN" worktree list --porcelain` shows a worktree on `refs/heads/$BRANCH`, use that folder as `$WORKTREE`.
2. Else, if the branch exists locally, run `git -C "$MAIN" worktree add "$WORKTREE" "$BRANCH"`.
3. Else, run `git -C "$MAIN" fetch origin`, then `git -C "$MAIN" worktree add -b "$BRANCH" "$WORKTREE" origin/HEAD`.

In that case the worktree is outside the session's start folder. Start every shell command with `cd "$WORKTREE" &&`, and give file tools absolute paths under `$WORKTREE`. Never edit files in `$MAIN`.

### When the work belongs in another repo

If the issue's code is in a different repo, do not stop. Make the worktree in that repo with the steps above, with `MAIN` set to that repo's main checkout, for example `MAIN="$HOME/Code/people"`. Then use that worktree for all the work. Leave the first worktree as it is: the mod removes it when the issue is Done. Say so in the report.

## 3. Set up only what the work needs

This is a Planning Center app that runs in PCO Box:

- Before you run tests, run `box worktree setup` in `$WORKTREE`. It installs the worktree's gems, node packages, and keys.
- When you must see the app in a browser or call it over HTTP, run `box worktree server` in `$WORKTREE`, in the background. It runs setup first if the worktree is not set up.

If `box` says that it does not know `worktree`, tell the user to update pco-box, and continue with the work that does not need it.

## 4. Do the work

1. Read the code that the issue touches, and the tests near it.
2. Make the change so that it meets each acceptance criterion.
3. Add or update tests for the new behavior.
4. Follow the repo's own instructions (`CLAUDE.md`, `AGENTS.md`) and its existing patterns.

## 5. Run the tests

Run the tests that relate to the change, and fix the failures. If a failure is not related to your change, do not fix it. Note it in the report.

## 6. Report

End with a short report in this shape:

```
## <ISSUE-ID>: <title>

Worktree: <path> (branch <branch>)
Moved to <repo>: <why the work is in that repo>   (only when you moved)

### What changed
- <each change, and why>

### Acceptance criteria
- [x] <criterion>: <how it is met>
- [ ] <criterion>: <why it is not met>

### Tests
<what you ran, and the result>

### Double check
- <anything a reviewer should look at closely>

### Open questions
- <anything you could not decide>
```

Leave out the "Double check" and "Open questions" sections when they have nothing in them.
