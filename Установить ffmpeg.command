#!/bin/bash
set -euo pipefail

workdir=""

finish() {
  local code=$?
  if [[ -n "$workdir" && -d "$workdir" ]]; then
    rm -rf "$workdir"
  fi
  echo
  if [[ $code -ne 0 ]]; then
    echo "Установка не завершилась."
  fi
  read -r -p "Нажмите Enter, чтобы закрыть окно..." || true
}
trap finish EXIT

echo "Скачиваю ffmpeg и ffprobe..."
workdir="$(mktemp -d)"
cd "$workdir"

curl -fL --retry 3 -o ffmpeg.zip "https://evermeet.cx/ffmpeg/getrelease/zip"
curl -fL --retry 3 -o ffprobe.zip "https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip"

echo "Распаковываю..."
unzip -o -q ffmpeg.zip
unzip -o -q ffprobe.zip

ffmpeg_bin="$(find . -type f -name ffmpeg ! -name '*.zip' -print -quit)"
ffprobe_bin="$(find . -type f -name ffprobe ! -name '*.zip' -print -quit)"
if [[ -z "$ffmpeg_bin" || -z "$ffprobe_bin" ]]; then
  echo "В архиве не нашлись файлы ffmpeg и ffprobe." >&2
  exit 1
fi

chmod 755 "$ffmpeg_bin" "$ffprobe_bin"
xattr -dr com.apple.quarantine "$ffmpeg_bin" "$ffprobe_bin" 2>/dev/null || true

echo "Устанавливаю в /usr/local/bin. Сейчас macOS попросит пароль."
sudo mkdir -p /usr/local/bin
sudo cp -f "$ffmpeg_bin" /usr/local/bin/ffmpeg
sudo cp -f "$ffprobe_bin" /usr/local/bin/ffprobe
sudo chmod 755 /usr/local/bin/ffmpeg /usr/local/bin/ffprobe
sudo xattr -dr com.apple.quarantine /usr/local/bin/ffmpeg /usr/local/bin/ffprobe 2>/dev/null || true

echo
echo "Готово."
/usr/local/bin/ffmpeg -version 2>&1 | head -n 1 || true
/usr/local/bin/ffprobe -version 2>&1 | head -n 1 || true
