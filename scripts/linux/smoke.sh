#!/bin/bash
# Install a Linux build in a clean Debian container, open a repository with it,
# and ask the window what it shows. `npm run test:linux` (arm64, natively).
# x64 under emulation crashes in Chromium itself, so it is not a useful test here.
set -uo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null
apt-get install -y -qq xvfb xauth curl ca-certificates >/dev/null 2>&1
kind="$1"; arch="${2:-arm64}"; deb_arch=$([ "$arch" = x64 ] && echo amd64 || echo arm64); img_arch=$([ "$arch" = x64 ] && echo x86_64 || echo arm64)
if [ "$kind" = deb ]; then
  apt-get install -y -qq /out/linux/GitDonkey-*-linux-${deb_arch}.deb >/dev/null 2>&1 || { echo "deb install failed"; exit 1; }
  run=(gitdonkey)
  echo "installed: $(dpkg -s gitdonkey | grep -E '^(Version|Depends)' | tr '\n' ' ')"
else
  apt-get install -y -qq git libgtk-3-0 libnss3 libxss1 libxtst6 libasound2 libgbm1 libdrm2 libsecret-1-0 >/dev/null 2>&1
  cp /out/linux/GitDonkey-*-linux-${img_arch}.AppImage /tmp/GitDonkey.AppImage && chmod +x /tmp/GitDonkey.AppImage
  export APPIMAGE_EXTRACT_AND_RUN=1
  run=(/tmp/GitDonkey.AppImage)
fi
git config --global user.name Smoke; git config --global user.email smoke@example.dev; git config --global init.defaultBranch main
mkdir -p /tmp/demo && cd /tmp/demo && git init -q && echo hi > README.md && git add -A && git commit -qm "First commit from Linux"
export GITDONKEY_USER_DATA=/tmp/ud GITDONKEY_OFFLINE=1
xvfb-run -a "${run[@]}" --no-sandbox --remote-debugging-port=9333 /tmp/demo > /tmp/app.log 2>&1 &
for i in $(seq 1 60); do
  t=$(curl -s http://127.0.0.1:9333/json/list 2>/dev/null | grep -o '"title": *"[^"]*"' | head -1)
  case "$t" in *demo*) echo "window: $t"; break;; esac
  sleep 1
done
if ! echo "$t" | grep -q demo; then echo "FAILED: no window with the repository"; tail -30 /tmp/app.log; exit 1; fi
echo "app log:"; grep -viE "dbus|libva|Fontconfig|GLib-GIO|gpu_init|viz_main|ui/gl|command_buffer|Exiting GPU" /tmp/app.log | tail -8
