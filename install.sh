#!/bin/sh
# Installs the Linear Queues mod and the /start-issue skill from this repo. Run it again after a pull.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
APP="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
MOD="$APP/mods/linear-queues"
OLD_MOD="$APP/mods/linear-projects" # the name before Linear Queues
SKILL="$HOME/.claude/skills/start-issue"

mkdir -p "$MOD" "$SKILL"
cp "$HERE"/mod/* "$MOD"/
cp "$HERE/VERSION" "$MOD/VERSION"
echo "Mod installed:   $MOD (version $(cat "$HERE/VERSION"))"

# The mod was named linear-projects before. Layouts that use it switch to the new name, each saved as
# <name>.json.bak first. The mod moves your settings and queues files when it first loads.
if [ -d "$OLD_MOD" ]; then
  for f in $(grep -l '"mod": *"linear-projects"' "$APP"/layouts/*.json 2>/dev/null); do
    cp "$f" "$f.bak"
    sed -i.tmp 's/"mod": *"linear-projects"/"mod": "linear-queues"/; s/"id": *"linear-projects"/"id": "linear-queues"/' "$f" && rm -f "$f.tmp"
    echo "Switched $(basename "$f") to linear-queues (the old file is $(basename "$f").bak)"
  done
  echo "
Linear Projects is now Linear Queues. When Herdr shows the new panel, delete the old mod folder:
  rm -r \"$OLD_MOD\""
fi

# The project-spaces sidebar is a mod of its own. It shows only once a layout uses it (see ./migrate.sh).
SIDEBAR="$APP/mods/project-spaces"
mkdir -p "$SIDEBAR"
cp "$HERE"/sidebar/project-spaces/* "$SIDEBAR"/
echo "Sidebar installed: $SIDEBAR"

if [ -f "$SKILL/SKILL.md" ] && ! cmp -s "$HERE/skills/start-issue/SKILL.md" "$SKILL/SKILL.md"; then
  cp "$SKILL/SKILL.md" "$SKILL/SKILL.md.bak"
  echo "Your old start-issue skill is saved as $SKILL/SKILL.md.bak"
fi
cp "$HERE/skills/start-issue/SKILL.md" "$SKILL/SKILL.md"
echo "Skill installed: $SKILL"

[ -f "$APP/linear.json" ] || echo "
Next: add your Linear API key to $APP/linear.json:
  { \"apiKey\": \"lin_api_...\" }"

[ -f "$APP/linear-queues-settings.json" ] || [ -f "$APP/linear-projects.json" ] || echo "
Optional: $APP/linear-queues-settings.json (see linear-queues-settings.example.json), or use the
panel's Settings page."

grep -q '"mod": *"project-spaces"' "$APP"/layouts/*.json 2>/dev/null || echo "
Optional: the project-spaces sidebar groups issue spaces by queue. To switch your layout to it,
run ./migrate.sh while Herdr is open."

echo "
If the mod is not in your layout yet, add this block to your layout's panel column
(see README.md, Install):
  { \"id\": \"linear-queues\", \"type\": \"block\", \"size\": { \"weight\": 1 }, \"min\": 160, \"content\": { \"mod\": \"linear-queues\" } }"
