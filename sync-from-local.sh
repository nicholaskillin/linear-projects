#!/bin/sh
# Copies your installed mod and skill back into this clone, so a change you made there can go in a pull request.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
APP="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
MOD="$APP/mods/linear-projects"
for f in "$HERE"/mod/*; do cp "$MOD/$(basename "$f")" "$f"; done
cp "$HOME/.claude/skills/start-issue/SKILL.md" "$HERE/skills/start-issue/SKILL.md"
NEW=$(cd "$MOD" && ls | grep -v -x -e gpui-kit.d.ts -e jsconfig.json | while read -r f; do [ -e "$HERE/mod/$f" ] || echo "$f"; done)
[ -z "$NEW" ] || echo "New files in the installed mod that this repo does not have (copy them if they belong):
$NEW"
git -C "$HERE" status --short
