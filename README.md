# Linear Queues

A Herdr panel that runs Claude Code agents on your Linear issues. A queue is a Linear issue filter plus the settings for its agents. On a timer, the mod starts one agent for each ready issue, in its own space and git worktree, on this computer or on a cloud instance. It also cleans up finished issues. The timer is plain code, so it spends no tokens.

The panel is for settings only. To read and change issues in Herdr, use the `linear` mod from planningcenter/herdr-mods.

## How it works

- **Queues.** "+ New queue" starts from a Linear project or team, or from scratch. A queue's page edits its conditions (Project, Team, Label, Assignee, Status, Priority, Milestone, Blocked) and shows the issues they match now. New queues start with "Assignee is No one, Me", "Status is To Do" and "Blocked is not".
- **Polls.** Each poll closes the spaces of Done and Canceled issues, then starts ready issues in the free slots. Ready means the queue matches the issue and the issue has no space yet. Your issues start first, then unassigned ones. A start assigns the issue to you and sets it In Progress.
- **Moves.** "Move ▾" on a running issue starts it again on the other host, in another repo, or both, from its pushed branch. It refuses while any work is not pushed.
- **Settings.** The gear opens the agent command, the skill and its `SKILL.md`, the first-message template, and the cloud setup.

Queues are saved in `~/.config/herdr-app/linear-queues.json`. For a filter the conditions cannot express, edit its `filter` there: it takes any Linear [IssueFilter](https://studio.apollographql.com/public/Linear-API/variant/current/schema/reference/inputs/IssueFilter).

## Install

You need Herdr and Claude Code.

1. Clone the repo and run the install script. It installs the mod, the `project-spaces` sidebar, and the `start-issue` skill (it saves an existing skill as `SKILL.md.bak`).
   ```sh
   git clone git@github.com:nicholaskillin/linear-projects.git
   cd linear-projects && ./install.sh
   ```
2. Put your Linear API key in `~/.config/herdr-app/linear.json`, or set `LINEAR_API_KEY`. The `linear` mod uses the same file.
   ```json
   { "apiKey": "lin_api_..." }
   ```
3. Add the panel to a column of your layout in `~/.config/herdr-app/layouts/`:
   ```json
   { "id": "linear-queues", "type": "block", "size": { "weight": 1 }, "min": 160, "content": { "mod": "linear-queues" } }
   ```
4. Optional: run `./migrate.sh` while Herdr is open to switch your layouts to the `project-spaces` sidebar, which groups issue spaces by queue.
5. Optional: copy `linear-queues-settings.example.json` to `~/.config/herdr-app/linear-queues-settings.json` to set `codeDir`, `defaultRepo` or `agentHost`.

To update, run `git pull && ./install.sh`. Coming from 1.x, the install script switches your layouts, and the mod turns your projects into queues the first time it runs. See the [2.0.0 notes](CHANGELOG.md).

## Cloud agents

Set a queue's "Run on" to Cloud to give each issue its own Planning Center cloud instance. You need the [cloud-agent CLI](https://github.com/planningcenter/cloud-agent-cli) and a current `pco aws-login`. The agent works on the issue's branch in the instance's main checkout. When the issue is done, the poll ends the instance, unless a checkout on it has work that is not pushed.

An instance costs money while it runs. If you close a cloud issue's space by hand, end its instance with `cloud-agent hc delete -s <issue ID in lower case>`.

## Notes

- Polls run only while Herdr is open.
- Cleanup runs `git worktree remove --force`, so changes that are not committed in a finished issue's worktree are lost.
- The `/start-issue` skill reads the acceptance criteria, makes the change, runs the tests and reports. It does not commit, push or change Linear. You can also run it by hand.
- Tests: `node --test mod/*.test.js`.
- `api.js`, `env.js`, `open.js` and `urls.js` come from the `linear` mod (MIT, `LICENSE.linear-mod`). `sidebar/project-spaces` is a changed copy of Herdr's `spaces` mod (Apache 2.0, `sidebar/project-spaces/LICENSE.herdr`).

## Contributing

Send changes as a pull request from a branch. Run `./install.sh` to try them in Herdr. If you changed your installed copy instead, `./sync-from-local.sh` copies it back into your clone. Do not change `VERSION` or `CHANGELOG.md`: the owner sets them at release time, with a `v<version>` tag and a GitHub release.
