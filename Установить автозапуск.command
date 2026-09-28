#!/bin/bash
set -euo pipefail

root="$(cd "$(dirname "$0")" && pwd)"
python="$root/.venv/bin/python"
plist="$HOME/Library/LaunchAgents/com.kachalaev.dlna.plist"
label="com.kachalaev.dlna"

finish() {
  local code=$?
  echo
  if [[ $code -ne 0 ]]; then
    echo "Автозапуск не установлен."
  fi
  read -r -p "Нажмите Enter, чтобы закрыть окно..." || true
}
trap finish EXIT

if [[ ! -x "$python" ]]; then
  echo "Сначала в папке проекта выполните: python3 -m venv .venv и pip install -r requirements.txt" >&2
  exit 1
fi
if [[ ! -f "$root/config.yaml" ]]; then
  echo "Нет config.yaml. Скопируйте config.example.yaml в config.yaml." >&2
  exit 1
fi

chmod 755 "$root/scripts/run-server.sh"
support="$HOME/Library/Application Support/dlna"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs" "$support"

# Фоновый launchd не получает доступ к USB exFAT. Запуск из Terminal
# идёт с тем же доступом, что и обычная работа за этим Mac.
launcher="$support/start.applescript"
shell_cmd="export PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:\$PATH; nohup $(printf '%q' "$root/scripts/run-server.sh") >> $(printf '%q' "$HOME/Library/Logs/dlna.log") 2>&1 & disown; exit"
cat > "$launcher" <<EOF
tell application "Terminal"
  do script "${shell_cmd}"
end tell
EOF

cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/osascript</string>
    <string>${launcher}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
  <key>StandardOutPath</key>
  <string>${HOME}/Library/Logs/dlna.log</string>
  <key>StandardErrorPath</key>
  <string>${HOME}/Library/Logs/dlna.log</string>
</dict>
</plist>
EOF

if pids="$(lsof -t -iTCP:8080 -sTCP:LISTEN 2>/dev/null || true)"; then
  if [[ -n "$pids" ]]; then
    kill $pids 2>/dev/null || true
    sleep 1
  fi
fi

uid="$(id -u)"
launchctl bootout "gui/${uid}/${label}" 2>/dev/null || true
launchctl bootstrap "gui/${uid}" "$plist"
launchctl enable "gui/${uid}/${label}"
launchctl kickstart -k "gui/${uid}/${label}"

echo "Готово. Сайт запускается сам после входа в учётную запись Mac."
echo "Если система спросит разрешение управлять Terminal, нажмите OK."
echo "Окно Terminal можно закрыть: сайт останется запущенным."
echo "Сейчас он тоже должен открываться: http://127.0.0.1:8080"
echo "Журнал: $HOME/Library/Logs/dlna.log"
