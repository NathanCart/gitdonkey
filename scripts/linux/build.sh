#!/bin/bash
# Build the Linux packages (AppImage and .deb, x64 and arm64) inside a Linux
# container: electron-builder's AppImage tools don't run on Apple Silicon.
# Run with `npm run dist:linux`; the packages land in dist/linux.
set -euo pipefail
apt-get update -qq >/dev/null
apt-get install -y -qq ruby ruby-dev build-essential rpm squashfs-tools >/dev/null 2>&1
gem install --no-document fpm >/dev/null
mkdir -p /build /out/linux
cd /src
tar --exclude=./node_modules --exclude=./dist --exclude=./test/e2e/shots --exclude=./.git -cf - . | (cd /build && tar -xf -)
cd /build
npm ci --no-audit --no-fund --loglevel=error
USE_SYSTEM_FPM=true npx electron-builder --linux AppImage deb --x64 --arm64 --publish never
rm -f /out/linux/*.AppImage /out/linux/*.deb
cp dist/release/*.AppImage dist/release/*.deb /out/linux/
ls -la /out/linux
