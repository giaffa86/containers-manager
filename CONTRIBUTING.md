# Contributing

Thanks for considering a contribution to Containers Manager.

## Development

This project is a GNOME Shell extension with no build toolchain. The JavaScript files are loaded directly by GNOME Shell.

After editing source files, sync and reload the local extension:

```bash
./scripts/sync-extension.sh
```

For substantial `extension.js` changes, test in a development Shell to avoid GJS module cache issues:

```bash
dbus-run-session -- gnome-shell --devkit
```

## Before Submitting Changes

- Keep changes focused.
- Do not include local/private notes, generated zip bundles, or editor state.
- Preserve compatibility with the `containers-manager@giaffa86` extension UUID.
- Validate upload packages with `shexli` when changing review-sensitive code.

## License

By contributing, you agree that your contributions are licensed under the GNU General Public License v3.0 or later.
