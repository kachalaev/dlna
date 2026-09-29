#!/bin/bash
# После входа Terminal часто ещё не готов. Пробуем несколько раз,
# но не открываем новое окно, если сервер уже запускается.
launcher="${1:-}"
if [[ -z "$launcher" || ! -f "$launcher" ]]; then
  echo "Нет скрипта запуска: ${launcher}" >&2
  exit 1
fi

listening() {
  /usr/sbin/lsof -nP -iTCP:8080 -sTCP:LISTEN >/dev/null 2>&1
}

coming_up() {
  /usr/bin/pgrep -f "[s]cripts/run-server.sh" >/dev/null 2>&1 && return 0
  /usr/bin/pgrep -f "[p]ython -m app" >/dev/null 2>&1 && return 0
  return 1
}

sleep 12
attempts=0
for _ in $(seq 1 10); do
  if listening; then
    exit 0
  fi
  if coming_up; then
    sleep 12
    continue
  fi
  if [[ "$attempts" -ge 4 ]]; then
    echo "Не удалось запустить сайт после входа." >&2
    exit 1
  fi
  attempts=$((attempts + 1))
  echo "Запуск сайта, попытка ${attempts}." >&2
  /usr/bin/osascript "$launcher" || true
  sleep 12
done

if listening; then
  exit 0
fi
echo "Сайт не открылся после входа." >&2
exit 1
