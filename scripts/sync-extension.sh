#!/usr/bin/env bash
set -euo pipefail

UUID="containers-manager@giaffa86"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
TARGET_DIR="${HOME}/.local/share/gnome-shell/extensions/${UUID}"

mkdir -p "${TARGET_DIR}"

rsync -av --delete \
  --exclude='.git' \
  --exclude='.gitignore' \
  --exclude='*.md' \
  --exclude='private' \
  --exclude='.agents' \
  --exclude='.codex' \
  "${SOURCE_DIR}/" \
  "${TARGET_DIR}/"

glib-compile-schemas "${TARGET_DIR}/schemas/"

gnome-extensions disable -q "${UUID}" || true

if ! gnome-extensions enable -q "${UUID}"; then
  dbus-send --session --type=method_call --dest=org.gnome.Shell \
    /org/gnome/Shell org.gnome.Shell.Extensions.ReloadExtension \
    string:"${UUID}"
fi
