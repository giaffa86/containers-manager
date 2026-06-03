import Adw from "gi://Adw";
import Gio from "gi://Gio";
import Gtk from "gi://Gtk";

import {ExtensionPreferences, gettext as _} from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";

const STATUS_FILTERS = ["all", "running", "stopped", "paused", "other"];

function addResetButton(row, settings, ...keys) {
    const button = new Gtk.Button({
        icon_name: "edit-undo-symbolic",
        valign: Gtk.Align.CENTER,
        tooltip_text: _("Reset to default"),
    });

    const updateSensitive = () => {
        button.sensitive = keys.some(key => settings.get_user_value(key) !== null);
    };

    button.connect("clicked", () => {
        for (const key of keys)
            settings.reset(key);
        updateSensitive();
    });

    for (const key of keys)
        settings.connect(`changed::${key}`, updateSensitive);

    row.add_suffix(button);
    updateSensitive();
}

function createComboRow(settings, key, title, values, labels = values) {
    const model = new Gtk.StringList({strings: labels});
    const row = new Adw.ComboRow({title, model});

    const syncFromSettings = () => {
        const index = values.indexOf(settings.get_string(key));
        row.set_selected(index >= 0 ? index : 0);
    };

    syncFromSettings();
    row.connect("notify::selected-item", () => {
        const selected = row.get_selected();
        if (selected >= 0 && selected < values.length)
            settings.set_string(key, values[selected]);
    });
    settings.connect(`changed::${key}`, syncFromSettings);

    addResetButton(row, settings, key);
    return row;
}

function createShortcutRow(settings, key, title) {
    const row = new Adw.EntryRow({
        title,
        show_apply_button: true,
    });

    const syncFromSettings = () => {
        const shortcuts = settings.get_strv(key);
        row.text = shortcuts[0] || "";
    };

    syncFromSettings();
    row.connect("notify::text", () => {
        const text = row.text.trim();
        settings.set_strv(key, text ? [text] : []);
    });
    settings.connect(`changed::${key}`, syncFromSettings);

    addResetButton(row, settings, key);
    return row;
}

export default class ContainersManagerPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        window._settings = this.getSettings();
        window.search_enabled = true;

        const generalPage = new Adw.PreferencesPage({
            title: _("General"),
            icon_name: "dialog-information-symbolic",
        });
        window.add(generalPage);

        const runtimeGroup = new Adw.PreferencesGroup({
            title: _("Container Runtime"),
            description: _("Choose the container runtime to manage"),
        });
        generalPage.add(runtimeGroup);

        runtimeGroup.add(createComboRow(
            window._settings,
            "container-runtime",
            _("Runtime"),
            ["podman", "docker"]
        ));

        const behaviourGroup = new Adw.PreferencesGroup({
            title: _("Behaviour"),
            description: _("Configure how the dialog opens and remembers state"),
        });
        generalPage.add(behaviourGroup);

        behaviourGroup.add(createComboRow(
            window._settings,
            "default-status-filter",
            _("Default status filter"),
            STATUS_FILTERS,
            [_("All"), _("Running"), _("Stopped"), _("Paused"), _("Other states")]
        ));

        const rememberStateRow = new Adw.SwitchRow({
            title: _("Remember dialog state"),
            subtitle: _("Keep search, status filter, stopped visibility, and favorites-only mode"),
        });
        behaviourGroup.add(rememberStateRow);
        window._settings.bind("remember-dialog-state", rememberStateRow, "active", Gio.SettingsBindFlags.DEFAULT);
        addResetButton(rememberStateRow, window._settings, "remember-dialog-state");

        const terminalGroup = new Adw.PreferencesGroup({
            title: _("Terminal"),
            description: _("Configure the terminal used for shell, logs, stats, and top"),
        });
        generalPage.add(terminalGroup);

        const terminalRow = new Adw.EntryRow({
            title: _("Terminal program with arguments"),
            show_apply_button: true,
        });
        terminalGroup.add(terminalRow);
        window._settings.bind("terminal", terminalRow, "text", Gio.SettingsBindFlags.DEFAULT);
        addResetButton(terminalRow, window._settings, "terminal");

        const appearancePage = new Adw.PreferencesPage({
            title: _("Appearance"),
            icon_name: "applications-graphics-symbolic",
        });
        window.add(appearancePage);

        const indicatorGroup = new Adw.PreferencesGroup({
            title: _("Panel Indicator"),
            description: _("Configure the top panel indicator"),
        });
        appearancePage.add(indicatorGroup);

        indicatorGroup.add(createComboRow(
            window._settings,
            "indicator-display",
            _("Indicator display"),
            ["icon-only", "icon-count"],
            [_("Icon only"), _("Icon with running count")]
        ));

        const containerListGroup = new Adw.PreferencesGroup({
            title: _("Container List"),
            description: _("Configure the container cards"),
        });
        appearancePage.add(containerListGroup);

        containerListGroup.add(createComboRow(
            window._settings,
            "sort-by",
            _("Sort containers by"),
            ["command", "created", "id", "image", "names", "runningfor", "size", "status"]
        ));

        const shortcutsPage = new Adw.PreferencesPage({
            title: _("Shortcuts"),
            icon_name: "input-keyboard-symbolic",
        });
        window.add(shortcutsPage);

        const dialogShortcutsGroup = new Adw.PreferencesGroup({
            title: _("Dialog"),
            description: _("Keyboard shortcuts for the containers dialog"),
        });
        shortcutsPage.add(dialogShortcutsGroup);
        dialogShortcutsGroup.add(createShortcutRow(
            window._settings,
            "open-dialog-shortcut",
            _("Open or close dialog")
        ));
    }
}
