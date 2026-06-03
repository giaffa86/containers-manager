# Containers Manager

GNOME Shell extension (`containers-manager@giaffa86`) to manage Podman or Docker containers from the top panel.

The interface is visually inspired by Copyous, borrowing its compact modal layout and polished GNOME-oriented interaction style while remaining focused on container management.

## Requirements

- GNOME Shell 50
- Fedora 44 Workstation development environment
- Podman or Docker available on the host
- `mutter-devkit` for testing in a separate GNOME Shell session without logout

Install the debug shell helper:

```bash
sudo dnf install mutter-devkit
```

## Install or Update

The directory name is the extension UUID. GNOME Shell loads it from:

```text
~/.local/share/gnome-shell/extensions/containers-manager@giaffa86/
```

After editing files, sync the source tree and compile schemas:

```bash
rsync -av --exclude='.git' --exclude='AGENTS.md' --exclude='.agents' --exclude='.codex' \
  /path/to/containers-manager/ \
  ~/.local/share/gnome-shell/extensions/containers-manager@giaffa86/

glib-compile-schemas ~/.local/share/gnome-shell/extensions/containers-manager@giaffa86/schemas/
```

Reload the extension:

```bash
gnome-extensions disable containers-manager@giaffa86 && \
  gnome-extensions enable containers-manager@giaffa86
```

Or via D-Bus:

```bash
dbus-send --session --type=method_call --dest=org.gnome.Shell \
  /org/gnome/Shell org.gnome.Shell.Extensions.ReloadExtension \
  string:"containers-manager@giaffa86"
```

## Test Without Logout

For substantial `extension.js` changes, GNOME Shell/GJS may keep old modules loaded even after disable/enable. Use a development Shell:

```bash
dbus-run-session -- gnome-shell --devkit
```

Close and relaunch that window/session after JavaScript changes. On this system, `gnome-shell --nested` is not supported; use `--devkit`.

If you see:

```text
Failed to execute child process "/usr/libexec/mutter-devkit"
```

install `mutter-devkit`.

Warnings about `AT-SPI`, `GVFS`, geolocation, portals, and authentication agents are common in the isolated D-Bus session and are not usually blockers.

## Debug Logs

```bash
journalctl -f -o cat /usr/bin/gnome-shell
```

## Project Notes

There is no build step, package manager, test runner, linting, or CI. The `.js` files are loaded directly by GNOME Shell at runtime.

Container operations are CLI-based through `podman` or `docker`; the extension does not use REST APIs.
