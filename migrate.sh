#!/bin/sh
# Switches your layouts to the project-spaces sidebar, which groups issue spaces by queue. It asks
# first. Run ./install.sh first, and keep Herdr open. Version 2.0 cannot move issue tabs from before 1.3:
# for that, install 1.3.0 and run its migrate.sh first.
set -e
APP="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
MOD="$APP/mods/linear-queues"

# Reads the answer from the terminal; with no terminal (answers piped in), from standard input.
ask() {
  printf "%s [y/N] " "$1"
  if { true < /dev/tty; } 2>/dev/null; then read -r answer < /dev/tty; else read -r answer || answer=""; fi
  echo
  case "$answer" in [yY]*) return 0 ;; *) return 1 ;; esac
}

command -v herdr-app >/dev/null 2>&1 || { echo "herdr-app is not on your PATH."; exit 1; }
herdr-app status >/dev/null 2>&1 || { echo "Herdr is not open. Open it, then run this again."; exit 1; }
[ -f "$MOD/queues.js" ] || { echo "The installed mod is too old. Run ./install.sh first."; exit 1; }
[ -f "$APP/mods/project-spaces/main.js" ] || { echo "The project-spaces sidebar is not installed. Run ./install.sh first."; exit 1; }

echo "Sidebar"
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
