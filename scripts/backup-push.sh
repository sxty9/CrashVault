#!/usr/bin/env bash
# Snapshot the CrashVault data dir into its private backup git repo.
#
# Since the move off GitHub-as-database, /var/lib/crashvault is the ONLY live
# copy of all user data. This script — driven by a systemd timer (every 15 min)
# — commits any change and pushes it to a separate private repo over SSH, so a
# disk failure can't wipe everything. No-op when nothing changed and already in
# sync; never touches the code repo.
#
# One-time setup (create repo + first push) is in docs/SELFHOST.md.

set -euo pipefail

DATA_DIR="${CRASHVAULT_DATA_DIR:-/var/lib/crashvault}"
cd "$DATA_DIR"

if [ ! -d .git ]; then
  echo "backup-push: no git repo in $DATA_DIR — run the one-time setup first" >&2
  exit 1
fi

git add -A
if ! git diff --cached --quiet; then
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  git -c user.name="crashvault-backup" -c user.email="backup@crashvault.local" \
      commit -q -m "data snapshot $ts"
fi

# Push any unpushed commits (no-op when already in sync).
git push -q origin main
