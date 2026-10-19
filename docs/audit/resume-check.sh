#!/bin/sh
# crust audit — recovery check. Run this as step 2 of the Recovery procedure
# in docs/audit/resume-prompt.md (fresh session / failed compaction / no context).
# Prints live disk state for the three recovery checks + the audit STATUS line.
# Trust the output (the disk), not any position block that disagrees with it.
# POSIX sh on purpose: no zsh `=word` expansion traps (a bare `echo ====` fails).
set -u

CRUST=/home/lario/Projects/personal/crust
SITE=/home/lario/Projects/static-websites/crust-website
AUDIT="$CRUST/docs/audit"

for d in "$CRUST" "$SITE"; do
  echo "== $d"
  git -C "$d" log --oneline -1
  dirty=$(git -C "$d" status --porcelain)
  if [ -n "$dirty" ]; then
    n=$(printf '%s\n' "$dirty" | wc -l)
    echo "DIRTY ($n paths — a killed unit's partial work may be on disk; see Recovery step 4):"
    printf '%s\n' "$dirty"
  else
    echo "clean"
  fi
done

echo "== full-audit.md"
last=$(grep -oE '^\| W[0-9]+ \|' "$AUDIT/full-audit.md" | tail -1 | tr -d '| ')
total=$(grep -cE '^\| W[0-9]+ \|' "$AUDIT/full-audit.md")
echo "last W row: $last (W-row count: $total)"
maxg=$(ls "$AUDIT/gaps" 2>/dev/null | grep -oE '^G[0-9]+' | grep -oE '[0-9]+' | sort -n | tail -1)
echo "next free G: G$(( ${maxg:-0} + 1 ))"
echo "audit STATUS line: $(sed -n '17p' "$AUDIT/full-audit.md" | cut -c1-160)"
