"use strict";

import Clutter from "gi://Clutter";
import Gio from "gi://Gio";
import Meta from "gi://Meta";
import Shell from "gi://Shell";
import St from "gi://St";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";

import {Extension} from "resource:///org/gnome/shell/extensions/extension.js";

import * as Runtime from "./modules/runtime.js";
import {ContainerDialog} from "./modules/containerDialog.js";
import {normalizeStatusFilter, statusCategory} from "./modules/utils.js";

export default class ContainersManagerExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._favoriteIds = new Set();
        this._hiddenIds = new Set();
        this._selectedContainerId = null;
        this._syncProcess = null;
        this._syncGeneration = 0;

        Runtime.setRuntime(this._settings.get_string("container-runtime"));
        this._loadDialogStateFromSettings();
        this._loadFavoriteStateFromSettings();
        this._loadHiddenStateFromSettings();

        this._dialog = new ContainerDialog(this);

        this._indicator = new PanelMenu.Button(0.0, this.metadata.name, true);

        const iconFile = Gio.File.new_for_path(`${this.path}/icons/containers-manager-symbolic.svg`);
        const icon = new St.Icon({
            gicon: new Gio.FileIcon({file: iconFile}),
            icon_size: 16,
            style_class: "system-status-icon",
        });
        this._indicatorIcon = icon;
        this._indicatorCountLabel = new St.Label({
            text: "",
            y_align: Clutter.ActorAlign.CENTER,
            style_class: "system-status-icon",
        });
        this._indicatorBox = new St.BoxLayout({style_class: "panel-status-menu-box"});
        this._indicatorBox.add_child(this._indicatorIcon);
        this._indicatorBox.add_child(this._indicatorCountLabel);
        this._indicator.add_child(this._indicatorBox);

        this._indicator.connectObject("button-press-event", (_actor, event) => {
            if (event.get_button() === Clutter.BUTTON_PRIMARY) {
                this._dialog.toggle();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        }, this);

        this._indicator.connectObject("touch-event", (_actor, event) => {
            if (event.type() === Clutter.EventType.TOUCH_BEGIN) {
                this._dialog.toggle();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        }, this);

        Main.panel.addToStatusArea(this.uuid, this._indicator);
        this._addKeybinding();
        this._connectSettings();
        this._syncIndicatorDisplay();
        this._refreshIndicatorCount();
    }

    disable() {
        this._removeKeybinding();
        this._stopSync();
        this._settings.disconnectObject(this);
        this._indicator.disconnectObject(this);
        this._dialog.destroy();
        this._dialog = null;
        this._indicatorIcon.destroy();
        this._indicatorCountLabel.destroy();
        this._indicatorBox.destroy();
        this._indicator.destroy();
        this._indicator = null;
        this._indicatorIcon = null;
        this._indicatorCountLabel = null;
        this._indicatorBox = null;
        this._settings = null;
    }

    _connectSettings() {
        this._settings.connectObject("changed::container-runtime", () => {
            Runtime.setRuntime(this._settings.get_string("container-runtime"));
            if (this._dialog.opened) {
                // The old events listener belongs to the previous runtime.
                this._stopSync();
                this._dialog._refresh();
                this._startSync();
            } else {
                this._refreshIndicatorCount();
            }
        }, this);
        this._settings.connectObject("changed::indicator-display", () => {
            this._syncIndicatorDisplay();
        }, this);
        this._settings.connectObject("changed::default-status-filter", () => {
            if (!this._settings.get_boolean("remember-dialog-state")) {
                this._statusFilter = normalizeStatusFilter(this._settings.get_string("default-status-filter"));
                this._dialog._syncFilterMenu();
                this._dialog._applyFilters();
            }
        }, this);
        this._settings.connectObject("changed::remember-dialog-state", () => {
            this._loadDialogStateFromSettings();
            this._dialog._syncControlsFromState();
            this._dialog._applyFilters();
        }, this);
        this._settings.connectObject("changed::show-hidden", () => {
            this._showHidden = this._settings.get_boolean("show-hidden");
            this._dialog._syncFilterMenu();
            this._dialog._applyFilters();
        }, this);
        this._settings.connectObject("changed::hidden-container-ids", () => {
            this._hiddenIds = new Set(this._settings.get_strv("hidden-container-ids"));
            this._dialog._applyFilters();
        }, this);
        this._settings.connectObject("changed::favorite-container-ids", () => {
            this._loadFavoriteStateFromSettings();
            this._dialog._refreshVisibleFavoriteState();
            this._dialog._applyFilters();
        }, this);
    }

    _addKeybinding() {
        Main.wm.addKeybinding(
            "open-dialog-shortcut",
            this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.ALL,
            () => this._dialog.toggle()
        );
    }

    _removeKeybinding() {
        Main.wm.removeKeybinding("open-dialog-shortcut");
    }

    _loadDialogStateFromSettings() {
        const remember = this._settings.get_boolean("remember-dialog-state");
        this._showStopped = remember ? this._settings.get_boolean("show-stopped") : true;
        this._statusFilter = normalizeStatusFilter(remember
            ? this._settings.get_string("status-filter")
            : this._settings.get_string("default-status-filter"));
        this._favoritesOnly = remember ? this._settings.get_boolean("favorites-only") : false;
        this._searchText = remember ? this._settings.get_string("search-text").toLowerCase() : "";
    }

    _loadFavoriteStateFromSettings() {
        this._favoriteIds = new Set(this._settings.get_strv("favorite-container-ids"));
    }

    _loadHiddenStateFromSettings() {
        this._showHidden = this._settings.get_boolean("show-hidden");
        this._hiddenIds = new Set(this._settings.get_strv("hidden-container-ids"));
    }

    _persistDialogState() {
        if (!this._settings.get_boolean("remember-dialog-state"))
            return;

        this._settings.set_boolean("show-stopped", this._showStopped);
        this._settings.set_string("status-filter", this._statusFilter);
        this._settings.set_boolean("favorites-only", this._favoritesOnly);
        this._settings.set_string("search-text", this._searchText);
    }

    _persistHiddenState() {
        this._settings.set_boolean("show-hidden", this._showHidden);
        this._settings.set_strv("hidden-container-ids", [...this._hiddenIds]);
    }

    _persistFavoriteState() {
        this._settings.set_strv("favorite-container-ids", [...this._favoriteIds]);
    }

    _resetTransientDialogState() {
        this._showStopped = true;
        this._statusFilter = normalizeStatusFilter(this._settings.get_string("default-status-filter"));
        this._favoritesOnly = false;
        this._searchText = "";
    }

    _syncIndicatorDisplay() {
        const display = this._settings.get_string("indicator-display");
        this._indicator.visible = true;
        this._indicatorCountLabel.visible = display === "icon-count";
    }

    _refreshIndicatorCount() {
        Runtime.getContainers(this._settings).then(containers => {
            this._updateIndicatorCount(containers);
        }).catch(() => {
            if (this._indicatorCountLabel)
                this._indicatorCountLabel.text = "";
        });
    }

    _updateIndicatorCount(containers) {
        if (!this._indicatorCountLabel)
            return;

        const running = containers.filter(c => statusCategory(c.status) === "running").length;
        this._indicatorCountLabel.text = running > 0 ? `${running}` : "";
    }

    _startSync() {
        const generation = ++this._syncGeneration;
        Runtime.newEventsProcess(() => {
            if (this._dialog?.opened)
                this._dialog._refresh();
        }).then(handle => {
            if (generation !== this._syncGeneration || !this._dialog?.opened) {
                handle.cancel();
                return;
            }

            this._syncProcess = handle;
        }).catch(e => {
            if (generation === this._syncGeneration && this._dialog?.opened)
                Main.notify("Container events unavailable", e.message);
        });
    }

    _stopSync() {
        this._syncGeneration++;
        this._syncProcess?.cancel();
        this._syncProcess = null;
    }

    _sortFavoritesFirst(containers) {
        return [...containers].sort((a, b) => {
            const aP = this._favoriteIds.has(a.id);
            const bP = this._favoriteIds.has(b.id);
            if (aP && !bP) return -1;
            if (!aP && bP) return 1;
            return 0;
        });
    }

    _toggleHidden(containerId) {
        if (this._hiddenIds.has(containerId))
            this._hiddenIds.delete(containerId);
        else
            this._hiddenIds.add(containerId);

        this._persistHiddenState();
        return this._hiddenIds.has(containerId);
    }
}
