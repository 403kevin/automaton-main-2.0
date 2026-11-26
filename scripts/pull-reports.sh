#!/usr/bin/env bash
# Copy the daily reports from the soak server to this machine (Git Bash or WSL).
#
#   scripts/pull-reports.sh root@host "<local-dir>"
#   scripts/pull-reports.sh root@host "/path/with spaces"
#
# The reports are written to DATA_DIR/reports inside the orchestrator container (/app/data/reports), and /app/data is the
# named Docker volume automaton-data, not a folder on the server. So this runs `docker compose cp` on the server over SSH,
# sends the tar stream to standard output and unpacks it here under "<local-dir>"/reports/. Nothing is written on the server
# and nothing is deleted. It uses the SSH key and known_hosts you already have; host key checking is never turned off.
#
# The project folder on the server is $AUTOMATON_REMOTE_DIR (default: automaton, relative to the SSH home folder).
set -euo pipefail

usage() {
  echo "Usage: pull-reports.sh <user@host> \"<local-dir>\"" >&2
  echo "  Example: scripts/pull-reports.sh root@host \"/path/with spaces\"" >&2
  echo "  Copies the server's data/reports into \"<local-dir>\"/reports. Set AUTOMATON_REMOTE_DIR if the project is not in ~/automaton." >&2
}

if [ "$#" -ne 2 ] || [ -z "$1" ] || [ -z "$2" ]; then
  usage
  exit 2
fi

host="$1"
dest="$2"
remote_dir="${AUTOMATON_REMOTE_DIR:-automaton}"

case "$host" in
  -*) echo "pull-reports.sh: the host must not start with a dash." >&2; exit 2 ;;
esac
case "$remote_dir" in
  *[!A-Za-z0-9._/~-]*|"") echo "pull-reports.sh: AUTOMATON_REMOTE_DIR may only hold letters, digits and . _ / ~ -" >&2; exit 2 ;;
esac

mkdir -p "$dest"
ssh -- "$host" "cd $remote_dir && docker compose -f docker-compose.yml -f docker-compose.soak.yml -f docker-compose.safe.yml --env-file .env.soak cp orchestrator:/app/data/reports -" \
  | tar -xf - -C "$dest"
echo "Reports copied to $dest/reports"
