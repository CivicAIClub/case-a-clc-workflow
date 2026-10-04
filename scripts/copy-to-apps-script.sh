#!/usr/bin/env bash
# Copies AutoPlanner's Apps Script files to the clipboard one at a time, so you can paste each
# into the Apps Script editor (clasp is blocked for under-18 school accounts).
# It never prints file contents: only each file's name, size and a short fingerprint.
#
#   scripts/copy-to-apps-script.sh               all files, in order
#   scripts/copy-to-apps-script.sh App.gs        only the files you name (for small fixes)
set -euo pipefail

cd "$(dirname "$0")/../apps_script"
ALL=(appsscript.json Code.gs Canvas.gs App.gs Index.html)
if [ $# -gt 0 ]; then FILES=("$@"); else FILES=("${ALL[@]}"); fi
COPY_CMD=${COPY_CMD:-pbcopy} # tests set COPY_CMD to avoid touching the clipboard

for f in "${FILES[@]}"; do
  if [ ! -f "$f" ]; then echo "No file apps_script/$f. Choose from: ${ALL[*]}" >&2; exit 1; fi
done

total=${#FILES[@]}
n=0
for f in "${FILES[@]}"; do
  n=$((n + 1))
  if [ ! -f "$f" ]; then
    echo "No file apps_script/$f. Choose from: ${ALL[*]}" >&2
    exit 1
  fi
  $COPY_CMD < "$f"
  lines=$(wc -l < "$f" | tr -d ' ')
  print=$(shasum "$f" | cut -c1-7)
  echo
  echo "[$n of $total] $f is on your clipboard ($lines lines, fingerprint $print)."
  case "$f" in
    appsscript.json)
      echo "  In the editor's Files list, click appsscript.json."
      echo "  (Not there? Click Project Settings (gear icon, left), tick"
      echo "   'Show \"appsscript.json\" manifest file in editor', then click Editor (<> icon).)"
      ;;
    Code.gs)
      echo "  In the Files list, click Code.gs."
      ;;
    *.gs)
      echo "  In the Files list, click ${f}."
      echo "  Not there yet? Click + next to Files, choose Script, type ${f%.gs} (no .gs) and press Enter."
      ;;
    *.html)
      echo "  In the Files list, click ${f}."
      echo "  Not there yet? Click + next to Files, choose HTML, type ${f%.html} (no .html) and press Enter."
      ;;
  esac
  echo "  Click inside the code, press Cmd+A, then Cmd+V, then Cmd+S."
  if [ "$n" -lt "$total" ]; then
    read -r -p "  Press Enter when it's saved, for the next file... " _
  fi
done
echo
echo "Done: all $total file(s) pasted. Check that the Files list has no other .gs or .html files"
echo "(delete any extra one: click its ⋮ menu, then Delete)."
