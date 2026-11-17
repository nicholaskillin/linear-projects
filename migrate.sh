#!/bin/sh
# Moves an existing setup to one space per issue: your layouts switch to the project-spaces sidebar,
# and your issue tabs move into spaces of their own, with their agents still running. It asks before
# each step. Run ./install.sh first, and keep Herdr open.
set -e
APP="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
MOD="$APP/mods/linear-projects"

# Reads the answer from the terminal; with no terminal (answers piped in), from standard input.
ask() {
  printf "%s [y/N] " "$1"
  if { true < /dev/tty; } 2>/dev/null; then read -r answer < /dev/tty; else read -r answer || answer=""; fi
  echo
  case "$answer" in [yY]*) return 0 ;; *) return 1 ;; esac
}

command -v herdr-app >/dev/null 2>&1 || { echo "herdr-app is not on your PATH."; exit 1; }
herdr-app status >/dev/null 2>&1 || { echo "Herdr is not open. Open it, then run this again."; exit 1; }
grep -q "move-issue-tabs" "$MOD/main.js" 2>/dev/null || { echo "The installed mod is too old. Run ./install.sh first."; exit 1; }
[ -f "$APP/mods/project-spaces/main.js" ] || { echo "The project-spaces sidebar is not installed. Run ./install.sh first."; exit 1; }

echo "1. Sidebar"
layouts=$(grep -l '"mod": *"spaces"' "$APP"/layouts/*.json 2>/dev/null || true)
if [ -z "$layouts" ]; then
  echo "   No layout uses the stock spaces sidebar. Nothing to switch."
else
  echo "$layouts" | sed 's/^/   /'
  if ask "   Switch these layouts to the project-spaces sidebar? Each one is saved as <name>.json.bak first."; then
    echo "$layouts" | while IFS= read -r f; do
      cp "$f" "$f.bak"
      sed -i.tmp 's/"mod": *"spaces"/"mod": "project-spaces"/' "$f" && rm -f "$f.tmp"
      echo "   Switched $(basename "$f")"
    done
  else
    echo "   Layouts unchanged."
  fi
fi

echo "2. Issue tabs"
echo "   Each issue tab in a project space moves into a space of its own. The agents keep running."
if ask "   Move them now?"; then
  herdr-app do linear-projects.move-issue-tabs >/dev/null
  echo "   Started. The Linear Projects panel shows a toast with what moved, or what could not move."
else
  echo "   Not moved. Run this again later, or click \"Move them\" in the Linear Projects panel."
fi

echo "
After the move, a project space that holds only a shell tab is no longer needed: polls do not use
it. This script does not close any space. Close the ones you do not need."
