#!/bin/bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

# После входа в систему диск может появиться не сразу.
for _ in $(seq 1 30); do
  if [[ -d /Volumes/lib2 ]]; then
    break
  fi
  sleep 2
done

exec "$root/.venv/bin/python" -m app
