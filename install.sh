#!/bin/sh
# Installs the Linear Projects mod and the /start-issue skill from this repo. Run it again after a pull.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
APP="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
MOD="$APP/mods/linear-projects"
SKILL="$HOME/.claude/skills/start-issue"

mkdir -p "$MOD" "$SKILL"
cp "$HERE"/mod/* "$MOD"/
echo "Mod installed:   $MOD"

if [ -f "$SKILL/SKILL.md" ] && ! cmp -s "$HERE/skills/start-issue/SKILL.md" "$SKILL/SKILL.md"; then
  cp "$SKILL/SKILL.md" "$SKILL/SKILL.md.bak"
  echo "Your old start-issue skill is saved as $SKILL/SKILL.md.bak"
fi
cp "$HERE/skills/start-issue/SKILL.md" "$SKILL/SKILL.md"
echo "Skill installed: $SKILL"

[ -f "$APP/linear.json" ] || echo "
Next: add your Linear API key to $APP/linear.json:
  { \"apiKey\": \"lin_api_...\" }"

[ -f "$APP/linear-projects.json" ] || echo "
Optional: $APP/linear-projects.json (see linear-projects.example.json)."

echo "
If the mod is not in your layout yet, add this block to your layout's panel column
(see README.md, Install):
  { \"id\": \"linear-projects\", \"type\": \"block\", \"size\": { \"weight\": 1 }, \"min\": 160, \"content\": { \"mod\": \"linear-projects\" } }"
