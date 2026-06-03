"use strict";

import Clutter from "gi://Clutter";
import GObject from "gi://GObject";
import Gio from "gi://Gio";
import Meta from "gi://Meta";
import Shell from "gi://Shell";
import St from "gi://St";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";
import * as Dialog from "resource:///org/gnome/shell/ui/dialog.js";
import * as ModalDialog from "resource:///org/gnome/shell/ui/modalDialog.js";

import {Extension} from "resource:///org/gnome/shell/extensions/extension.js";

import * as Runtime from "./modules/runtime.js";

export default class ContainersManagerExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._settingsConnections = [];
        this._favoriteIds = new Set();
        this._selectedContainerId = null;
        this._syncProcess = null;
        this._syncGeneration = 0;
        this._indicatorSignals = [];

        Runtime.setRuntime(this._settings.get_string("container-runtime"));
        this._loadDialogStateFromSettings();

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

        this._indicatorSignals.push(this._indicator.connect("button-press-event", (_actor, event) => {
            if (event.get_button() === Clutter.BUTTON_PRIMARY) {
                this._dialog.toggle();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        }));

        this._indicatorSignals.push(this._indicator.connect("touch-event", (_actor, event) => {
            if (event.type() === Clutter.EventType.TOUCH_BEGIN) {
                this._dialog.toggle();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        }));

        Main.panel.addToStatusArea(this.uuid, this._indicator);
        this._addKeybinding();
        this._connectSettings();
        this._syncIndicatorDisplay();
        this._refreshIndicatorCount();
    }

    disable() {
        this._removeKeybinding();
        this._stopSync();
        if (this._settings && this._settingsConnections) {
            for (const id of this._settingsConnections)
                this._settings.disconnect(id);
        }
        this._settingsConnections = [];
        this._dialog?.destroy();
        this._dialog = null;
        if (this._indicator && this._indicatorSignals) {
            for (const id of this._indicatorSignals)
                this._indicator.disconnect(id);
        }
        this._indicatorSignals = [];
        this._indicatorIcon?.destroy();
        this._indicatorCountLabel?.destroy();
        this._indicatorBox?.destroy();
        this._indicator?.destroy();
        this._indicator = null;
        this._indicatorIcon = null;
        this._indicatorCountLabel = null;
        this._indicatorBox = null;
        this._settings = null;
    }

    _connectSettings() {
        this._settingsConnections.push(this._settings.connect("changed::container-runtime", () => {
            Runtime.setRuntime(this._settings.get_string("container-runtime"));
            if (this._dialog.opened)
                this._dialog._refresh();
            else
                this._refreshIndicatorCount();
        }));
        this._settingsConnections.push(this._settings.connect("changed::indicator-display", () => {
            this._syncIndicatorDisplay();
        }));
        this._settingsConnections.push(this._settings.connect("changed::default-status-filter", () => {
            if (!this._settings.get_boolean("remember-dialog-state")) {
                this._statusFilter = normalizeStatusFilter(this._settings.get_string("default-status-filter"));
                this._dialog._syncFilterMenu();
                this._dialog._applyFilters();
            }
        }));
        this._settingsConnections.push(this._settings.connect("changed::remember-dialog-state", () => {
            this._loadDialogStateFromSettings();
            this._dialog._syncControlsFromState();
            this._dialog._applyFilters();
        }));
    }

    _addKeybinding() {
        try {
            Main.wm.addKeybinding(
                "open-dialog-shortcut",
                this._settings,
                Meta.KeyBindingFlags.NONE,
                Shell.ActionMode.ALL,
                () => this._dialog.toggle()
            );
        } catch (e) {
            logError(e, "Error adding shortcut");
        }
    }

    _removeKeybinding() {
        try {
            Main.wm.removeKeybinding("open-dialog-shortcut");
        } catch (e) {
            logError(e, "Error removing shortcut");
        }
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

    _persistDialogState() {
        if (!this._settings.get_boolean("remember-dialog-state"))
            return;

        this._settings.set_boolean("show-stopped", this._showStopped);
        this._settings.set_string("status-filter", this._statusFilter);
        this._settings.set_boolean("favorites-only", this._favoritesOnly);
        this._settings.set_string("search-text", this._searchText);
    }

    _resetTransientDialogState() {
        this._showStopped = true;
        this._statusFilter = normalizeStatusFilter(this._settings.get_string("default-status-filter"));
        this._favoritesOnly = false;
        this._searchText = "";
    }

    _syncIndicatorDisplay() {
        if (!this._indicator || !this._indicatorCountLabel)
            return;

        const display = this._settings.get_string("indicator-display");
        this._indicator.visible = true;
        this._indicatorCountLabel.visible = display === "icon-count";
    }

    _refreshIndicatorCount() {
        if (!this._indicatorCountLabel)
            return;

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
        }).then(process => {
            if (generation !== this._syncGeneration || !this._dialog?.opened) {
                process.force_exit();
                return;
            }

            this._syncProcess = process;
        }).catch(e => {
            if (generation === this._syncGeneration && this._dialog?.opened)
                Main.notify("Container events unavailable", e.message);
        });
    }

    _stopSync() {
        this._syncGeneration++;
        this._syncProcess?.force_exit();
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
}


class ContainerDialog extends St.Widget {
    static {
        GObject.registerClass({Signals: {}}, this);
    }

    constructor(ext) {
        super({
            layout_manager: new Clutter.FixedLayout(),
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.FILL,
            x_expand: true,
            y_expand: true,
            visible: false,
            reactive: true,
            style_class: "container-dialog-bg",
        });

        this._ext = ext;
        this._open = false;
        this._closing = false;
        this._grab = null;
        this._containerCards = new Map();
        this._renderRequestId = 0;
        this._openMenuCard = null;

        Main.layoutManager.modalDialogGroup.add_child(this);
        global.focus_manager.add_group(this);
        this.connect("captured-event", (_actor, event) => this._onCapturedEvent(event));

        this._box = new St.BoxLayout({
            vertical: true,
            style_class: "container-dialog-box popup-menu-content",
            x_expand: false,
            y_expand: false,
        });
        this.add_child(this._box);

        // --- Search Bar ---
        const searchWrap = new St.BoxLayout({
            vertical: true,
            style_class: "dialog-search-wrap",
            x_expand: true,
        });

        const searchRow = new St.BoxLayout({
            style_class: "dialog-search-row",
            x_expand: true,
        });
        this._searchRow = searchRow;

        this._filterToggleIcon = new St.Icon({
            icon_name: "view-list-symbolic",
            style_class: "dialog-search-icon",
            icon_size: 16,
        });
        this._filterToggleArrow = new St.Icon({
            icon_name: "pan-down-symbolic",
            style_class: "dialog-search-arrow",
            icon_size: 10,
        });
        this._filterToggleBtn = new St.Button({
            style_class: "dialog-search-button dialog-search-filter-button",
            can_focus: true,
            child: new St.BoxLayout({
                style_class: "dialog-search-filter-content",
            }),
        });
        this._filterToggleBtn.child.add_child(this._filterToggleIcon);
        this._filterToggleBtn.child.add_child(this._filterToggleArrow);
        this._filterToggleBtn.connect("clicked", () => this._toggleFilterMenu());
        searchRow.add_child(this._filterToggleBtn);

        this._searchEntry = new St.Entry({
            hint_text: "Type to search...",
            style_class: "dialog-search-entry",
            can_focus: true,
            x_expand: true,
        });
        this._searchEntry.clutter_text.connect("text-changed", () => {
            this._ext._searchText = this._searchEntry.text.toLowerCase();
            this._ext._persistDialogState();
            this._applyFilters();
        });
        this._searchEntry.clutter_text.connect("key-focus-in", () => {
            searchRow.add_style_class_name("focused");
        });
        this._searchEntry.clutter_text.connect("key-focus-out", () => {
            searchRow.remove_style_class_name("focused");
        });
        searchRow.add_child(this._searchEntry);

        const searchFavoriteBtn = new St.Button({
            style_class: "dialog-search-button dialog-search-favorite-button",
            toggle_mode: true,
            checked: this._ext._favoritesOnly,
            can_focus: true,
            x_expand: false,
            y_expand: false,
            child: new St.Icon({
                icon_name: "starred-symbolic",
                style_class: "dialog-search-icon",
                icon_size: 16,
            }),
        });
        this._searchFavoriteBtn = searchFavoriteBtn;
        searchFavoriteBtn.connect("clicked", () => {
            this._ext._favoritesOnly = searchFavoriteBtn.checked;
            this._ext._persistDialogState();
            this._applyFilters();
        });
        searchRow.add_child(searchFavoriteBtn);
        searchWrap.add_child(searchRow);

        this._filterMenu = new St.BoxLayout({
            vertical: true,
            style_class: "dialog-filter-menu search-popup-menu",
            visible: false,
            reactive: true,
        });
        this.add_child(this._filterMenu);
        this._box.add_child(searchWrap);
        this._statusFilterButtons = new Map();
        this._statusFilterIcons = new Map();
        this._addFilterOption("all", "All containers", "view-list-symbolic");
        this._addFilterOption("running", "Running", "media-playback-start-symbolic");
        this._addFilterOption("stopped", "Stopped", "media-playback-stop-symbolic");
        this._addFilterOption("paused", "Paused", "media-playback-pause-symbolic");
        this._addFilterOption("other", "Other states", "action-unavailable-symbolic");
        this._syncFilterMenu();

        // --- Separator ---
        const headerSep = new St.Bin({style_class: "dialog-separator"});
        this._box.add_child(headerSep);

        // --- Container Cards ---
        this._cardList = new St.BoxLayout({
            vertical: true,
            style_class: "dialog-card-list",
            x_expand: true,
        });

        this._scrollView = new St.ScrollView({
            style_class: "dialog-scroll-view",
        });
        this._scrollView.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        this._scrollView.add_child(this._cardList);
        this._box.add_child(this._scrollView);

        this._actionMenu = new ContainerActionMenu({
            onClose: () => this._closeContextMenu(),
            onInspectCopied: (details) => this._showInspectDetails(details),
            onDelete: (container) => {
                this._closeContextMenu();
                new RemoveContainerDialog(container).open(1, true);
            },
        });
        this.add_child(this._actionMenu);

        this._inspectPanel = new St.BoxLayout({
            vertical: true,
            style_class: "dialog-inspect-panel",
            x_expand: true,
            visible: false,
        });
        const inspectHeader = new St.BoxLayout({
            style_class: "dialog-inspect-header",
            x_expand: true,
        });
        inspectHeader.add_child(new St.Icon({
            icon_name: "edit-copy-symbolic",
            icon_size: 14,
            style_class: "dialog-inspect-icon",
        }));
        inspectHeader.add_child(new St.Label({
            text: "Copied Inspect",
            style_class: "dialog-inspect-title",
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        const inspectCloseBtn = new St.Button({
            style_class: "dialog-inspect-close-button",
            can_focus: true,
            child: new St.Icon({icon_name: "window-close-symbolic", icon_size: 14}),
        });
        inspectCloseBtn.connect("clicked", () => this._hideInspectDetails());
        this._inspectCloseBtn = inspectCloseBtn;
        inspectHeader.add_child(inspectCloseBtn);
        this._inspectPanel.add_child(inspectHeader);

        this._inspectText = new St.Label({
            text: "",
            style_class: "dialog-inspect-text",
            x_expand: true,
        });
        this._inspectText.clutter_text.line_wrap = true;
        this._inspectPanel.add_child(this._inspectText);
        this._box.add_child(this._inspectPanel);

        // --- No containers fallback ---
        this._noContainersLabel = new St.Label({
            text: "No containers detected",
            style_class: "dialog-no-containers",
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._box.add_child(this._noContainersLabel);

        // --- Separator ---
        const footerSep = new St.Bin({style_class: "dialog-separator"});
        this._box.add_child(footerSep);

        // --- Bottom Toolbar ---
        const toolbar = new St.BoxLayout({
            style_class: "dialog-toolbar",
            x_expand: true,
        });

        const settingsBtn = this._createToolbarButton(
            "emblem-system-symbolic",
            () => ext.openPreferences()
        );
        this._settingsBtn = settingsBtn;
        toolbar.add_child(settingsBtn);

        this._eyeIcon = new St.Icon({
            icon_name: "view-reveal-symbolic",
            icon_size: 16,
        });
        this._eyeBtn = new St.Button({
            style_class: "dialog-toolbar-button",
            toggle_mode: true,
            checked: this._ext._showStopped,
            can_focus: true,
            child: this._eyeIcon,
        });
        this._eyeBtn.connect("clicked", () => {
            this._ext._showStopped = !this._ext._showStopped;
            this._eyeBtn.checked = this._ext._showStopped;
            this._ext._persistDialogState();
            this._updateEyeButton();
            this._applyFilters();
        });
        this._updateEyeButton();
        toolbar.add_child(this._eyeBtn);

        const toolbarSpacer = new St.Bin({x_expand: true});
        toolbar.add_child(toolbarSpacer);

        this._toggleRunActionIcon = new St.Icon({
            icon_name: "media-playback-start-symbolic",
            icon_size: 16,
        });
        this._toggleRunActionBtn = this._createActionToolbarButton(
            this._toggleRunActionIcon,
            () => this._runSelectedContainerStartStop()
        );
        toolbar.add_child(this._toggleRunActionBtn);

        this._restartActionBtn = this._createActionToolbarButton(
            new St.Icon({icon_name: "system-reboot-symbolic", icon_size: 16}),
            () => this._runSelectedContainerAction("restart")
        );
        toolbar.add_child(this._restartActionBtn);
        this._syncSelectionActions();

        this._box.add_child(toolbar);
    }

    get opened() {
        return this._open;
    }

    destroy() {
        if (this._open)
            this.close();
        this._filterMenu?.destroy();
        this._filterMenu = null;
        super.destroy();
    }

    toggle() {
        if (!this._open)
            this.open();
        else
            this.close();
    }

    open() {
        if (this._open || this._closing) return;

        this._grab = Main.pushModal(this, {actionMode: Shell.ActionMode.SYSTEM_MODAL});
        if (isGrabRevoked(this._grab)) {
            Main.popModal(this._grab);
            this._grab = null;
            return;
        }

        this._open = true;
        this._setFilterMenuOpen(false);
        this._closeContextMenu();
        this._inspectPanel.visible = false;
        this._selectCard(null);
        if (!this._ext._settings.get_boolean("remember-dialog-state"))
            this._ext._resetTransientDialogState();
        this._syncControlsFromState();
        this.show();
        this._positionBox();
        this._searchEntry.grab_key_focus();

        this._ext._startSync();
        this._refresh();
    }

    close() {
        if (!this._open) return;

        this._closing = true;
        this._open = false;
        this._setFilterMenuOpen(false);
        this._closeContextMenu();
        this._inspectPanel.visible = false;
        this._scrollView.set_height(0);

        Main.popModal(this._grab);
        this._grab = null;
        this._closing = false;
        this.hide();

        this._ext._stopSync();
    }

    _refresh() {
        this._renderRequestId++;
        const reqId = this._renderRequestId;

        Runtime.getContainers(this._ext._settings).then(containers => {
            if (reqId !== this._renderRequestId) return;
            this._renderContainers(containers);
        }).catch(err => {
            if (reqId !== this._renderRequestId) return;
            this._cardList.destroy_all_children();
            this._containerCards.clear();
            this._scrollView.visible = false;
            this._noContainersLabel.text = `Error: ${err.message}`;
            this._noContainersLabel.visible = true;
            this._positionBox();
        });
    }

    _renderContainers(containers) {
        let sorted = this._ext._sortFavoritesFirst(containers);
        this._ext._updateIndicatorCount(containers);
        const currentIds = new Set(sorted.map(c => c.id));

        if (this._ext._selectedContainerId && !currentIds.has(this._ext._selectedContainerId))
            this._ext._selectedContainerId = null;

        // Remove stale cards
        for (const [id, card] of this._containerCards) {
            if (!currentIds.has(id)) {
                if (this._openMenuCard === card)
                    this._closeContextMenu();
                card.destroy();
                this._containerCards.delete(id);
            }
        }

        // Update / create cards
        let index = 0;
        for (const container of sorted) {
            if (this._containerCards.has(container.id)) {
                const card = this._containerCards.get(container.id);
                card.update(
                    container,
                    this._ext._favoriteIds.has(container.id),
                    this._ext._selectedContainerId === container.id
                );
                this._cardList.set_child_at_index(card, index);
            } else {
                const card = new ContainerCard(container, {
                    favorite: this._ext._favoriteIds.has(container.id),
                    selected: this._ext._selectedContainerId === container.id,
                    onSelect: (selectedCard) => this._selectCard(selectedCard),
                    onMoveFocus: (backward, current) => this._moveKeyboardFocus(backward, current),
                    onToggleRunState: (container) => this._toggleContainerRunState(container),
                    onOpenMenu: (openedCard, sourceActor) => this._toggleContextMenu(openedCard, sourceActor),
                    onToggleFavorite: (id) => {
                        if (this._ext._favoriteIds.has(id))
                            this._ext._favoriteIds.delete(id);
                        else
                            this._ext._favoriteIds.add(id);
                        const favorite = this._ext._favoriteIds.has(id);
                        this._renderContainers([...this._containerCards.values()].map(card => card._container));
                        return favorite;
                    },
                    onDelete: (container) => {
                        new RemoveContainerDialog(container).open(1, true);
                    },
                });
                this._cardList.insert_child_at_index(card, index);
                this._containerCards.set(container.id, card);
            }
            index++;
        }

        this._noContainersLabel.visible = sorted.length === 0;
        this._scrollView.visible = sorted.length > 0;
        this._applyFilters();
        this._syncSelectionActions();
        this._positionBox();
    }

    _applyFilters() {
        const searchText = this._ext._searchText;
        const showStopped = this._ext._showStopped;
        const statusFilter = this._ext._statusFilter;
        const favoritesOnly = this._ext._favoritesOnly;
        let visibleCount = 0;

        for (const [, card] of this._containerCards) {
            let visible = true;
            if (searchText && !card._container.name.toLowerCase().includes(searchText))
                visible = false;
            if (!showStopped && card._isStopped())
                visible = false;
            if (statusFilter !== "all" && card.statusCategory !== statusFilter)
                visible = false;
            if (favoritesOnly && !this._ext._favoriteIds.has(card._container.id))
                visible = false;
            card.visible = visible;
            if (!visible && this._ext._selectedContainerId === card._container.id)
                this._selectCard(null);
            if (visible)
                visibleCount++;
        }

        const hasContainers = this._containerCards.size > 0;
        this._scrollView.visible = hasContainers && visibleCount > 0;
        this._noContainersLabel.text = hasContainers
            ? "No containers match filters"
            : "No containers detected";
        this._noContainersLabel.visible = !hasContainers || visibleCount === 0;

        if (this._open)
            this._positionBox();
    }

    _addFilterOption(value, label, iconName) {
        const btn = new St.Button({
            style_class: "dialog-filter-option",
            toggle_mode: true,
            x_expand: true,
            can_focus: true,
        });
        const row = new St.BoxLayout({style_class: "dialog-filter-option-row"});
        row.add_child(new St.Icon({icon_name: iconName, icon_size: 14, style_class: "popup-menu-icon"}));
        row.add_child(new St.Label({
            text: label,
            style_class: "dialog-filter-option-label",
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        }));
        const checkIcon = new St.Icon({
            icon_name: "object-select-symbolic",
            icon_size: 14,
            style_class: "dialog-filter-check",
            visible: false,
        });
        row.add_child(checkIcon);
        btn.child = row;
        btn.connect("clicked", () => {
            this._ext._statusFilter = value;
            this._ext._persistDialogState();
            this._syncFilterMenu();
            this._setFilterMenuOpen(false);
            this._applyFilters();
        });
        this._filterMenu.add_child(btn);
        this._statusFilterButtons.set(value, btn);
        this._statusFilterIcons.set(value, {iconName, checkIcon});
    }

    _toggleFilterMenu() {
        this._setFilterMenuOpen(!this._filterMenu.visible);
        if (this._filterMenu.visible)
            this._closeContextMenu();
        this._applyFilters();
        this._positionBox();
    }

    _setFilterMenuOpen(open) {
        this._filterMenu.visible = open;
        if (open)
            this._filterToggleBtn.add_style_class_name("open");
        else
            this._filterToggleBtn.remove_style_class_name("open");
        if (open) {
            const parent = this._filterMenu.get_parent();
            if (parent && typeof parent.set_child_above_sibling === "function")
                parent.set_child_above_sibling(this._filterMenu, null);
            this._positionFilterMenu();
            this._statusFilterButtons.get(this._ext._statusFilter)?.grab_key_focus();
        }
    }

    _syncFilterMenu() {
        for (const [value, btn] of this._statusFilterButtons) {
            const active = value === this._ext._statusFilter;
            btn.checked = active;
            const option = this._statusFilterIcons.get(value);
            if (option)
                option.checkIcon.visible = active;
        }

        const selected = this._statusFilterIcons.get(this._ext._statusFilter);
        this._filterToggleIcon.icon_name = selected?.iconName ?? "view-list-symbolic";
    }

    _syncControlsFromState() {
        this._searchEntry.text = this._ext._searchText;
        this._searchFavoriteBtn.checked = this._ext._favoritesOnly;
        this._eyeBtn.checked = this._ext._showStopped;
        this._updateEyeButton();
        this._syncFilterMenu();
    }

    _createToolbarButton(iconName, callback) {
        const btn = new St.Button({
            style_class: "dialog-toolbar-button",
            can_focus: true,
            child: new St.Icon({icon_name: iconName, icon_size: 16}),
        });
        btn.connect("clicked", callback);
        return btn;
    }

    _createActionToolbarButton(icon, callback) {
        const btn = new St.Button({
            style_class: "dialog-toolbar-button dialog-toolbar-action",
            can_focus: true,
            child: icon,
        });
        btn.connect("clicked", callback);
        return btn;
    }

    _selectCard(card) {
        const selectedId = card?._container?.id ?? null;
        this._ext._selectedContainerId = selectedId;

        for (const [, existingCard] of this._containerCards)
            existingCard.setSelected(existingCard._container.id === selectedId);

        this._syncSelectionActions();
    }

    _selectedContainer() {
        if (!this._ext._selectedContainerId)
            return null;
        return this._containerCards.get(this._ext._selectedContainerId)?._container ?? null;
    }

    _syncSelectionActions() {
        if (!this._toggleRunActionBtn || !this._restartActionBtn)
            return;

        const container = this._selectedContainer();
        const category = container ? statusCategory(container.status) : null;
        const canStart = category === "stopped";
        const canStop = category === "running";

        this._toggleRunActionIcon.icon_name = canStop
            ? "media-playback-stop-symbolic"
            : "media-playback-start-symbolic";
        this._setActionButtonEnabled(this._toggleRunActionBtn, canStart || canStop);
        this._setActionButtonEnabled(this._restartActionBtn, category === "running" || category === "paused");
    }

    _setActionButtonEnabled(btn, enabled) {
        btn.reactive = enabled;
        btn.can_focus = enabled;
        btn.opacity = enabled ? 255 : 96;
    }

    _runSelectedContainerAction(action) {
        const container = this._selectedContainer();
        if (!container)
            return;

        const category = statusCategory(container.status);
        if (action === "start" && category === "stopped")
            container.start();
        else if (action === "stop" && category === "running")
            container.stop();
        else if (action === "restart" && (category === "running" || category === "paused"))
            container.restart();
    }

    _runSelectedContainerStartStop() {
        const container = this._selectedContainer();
        if (!container)
            return;

        this._toggleContainerRunState(container);
    }

    _toggleContainerRunState(container) {
        const category = statusCategory(container.status);
        if (category === "stopped")
            container.start();
        else if (category === "running")
            container.stop();
    }

    _showInspectDetails(details) {
        this._inspectText.text = details;
        this._inspectPanel.visible = true;
        this._positionBox();
    }

    _hideInspectDetails() {
        this._inspectPanel.visible = false;
        this._positionBox();
    }

    _updateEyeButton() {
        this._eyeIcon.icon_name = this._ext._showStopped
            ? "view-reveal-symbolic"
            : "view-conceal-symbolic";
    }

    _positionBox() {
        const indicator = this._ext._indicator;
        const [indicatorX, indicatorY] = indicator.get_transformed_position();
        const [indicatorWidth, indicatorHeight] = indicator.get_transformed_size();
        const monitor = Main.layoutManager.findMonitorForActor(indicator) ??
            Main.layoutManager.primaryMonitor;
        const [, boxWidth] = this._box.get_preferred_width(-1);
        const margin = 8;
        const gap = 6;
        const belowY = indicatorY + indicatorHeight + gap;
        const availableBelow = monitor.y + monitor.height - belowY - margin;
        const availableAbove = indicatorY - monitor.y - gap - margin;
        const openBelow = availableBelow >= availableAbove || availableBelow >= 280;
        const availableHeight = Math.max(180, openBelow ? availableBelow : availableAbove);

        const [, boxNaturalHeight] = this._box.get_preferred_height(boxWidth);
        const [, scrollMinHeight] = this._scrollView.get_preferred_height(boxWidth);
        const chromeHeight = Math.max(0, boxNaturalHeight - scrollMinHeight);
        const maxScrollHeight = Math.max(180, availableHeight - chromeHeight);
        const preferredScrollHeight = Math.min(420, maxScrollHeight);
        const scrollHeight = Math.max(240, preferredScrollHeight);
        this._scrollView.set_height(Math.floor(scrollHeight));

        const [, boxHeight] = this._box.get_preferred_height(boxWidth);

        let x = indicatorX + indicatorWidth - boxWidth;
        x = Math.max(monitor.x + margin, x);
        x = Math.min(monitor.x + monitor.width - boxWidth - margin, x);

        let y = openBelow ? belowY : indicatorY - boxHeight - gap;
        y = Math.max(monitor.y + margin, y);
        y = Math.min(monitor.y + monitor.height - boxHeight - margin, y);

        this._box.set_position(Math.round(x), Math.round(y));
        if (this._filterMenu.visible)
            this._positionFilterMenu();
    }

    _positionFilterMenu() {
        const [buttonX, buttonY] = this._filterToggleBtn.get_transformed_position();
        const [, buttonHeight] = this._filterToggleBtn.get_transformed_size();
        const monitor = Main.layoutManager.findMonitorForActor(this._box) ??
            Main.layoutManager.primaryMonitor;
        const margin = 8;

        this._filterMenu.set_width(224);

        const [, menuWidth] = this._filterMenu.get_preferred_width(-1);
        const [, menuHeight] = this._filterMenu.get_preferred_height(menuWidth);
        let x = buttonX - 14;
        x = Math.max(monitor.x + margin, x);
        x = Math.min(monitor.x + monitor.width - menuWidth - margin, x);

        let y = buttonY + buttonHeight + 8;
        const bottomLimit = monitor.y + monitor.height - menuHeight - margin;
        if (y > bottomLimit)
            y = buttonY - menuHeight - 8;

        this._filterMenu.set_position(Math.round(x), Math.round(y));
    }

    vfunc_key_press_event(event) {
        const symbol = event.get_key_symbol();

        if (symbol === Clutter.KEY_Escape) {
            this.close();
            return Clutter.EVENT_STOP;
        }

        if (symbol === Clutter.KEY_Tab || symbol === Clutter.KEY_ISO_Left_Tab)
            return this._moveKeyboardFocus(symbol === Clutter.KEY_ISO_Left_Tab);

        return Clutter.EVENT_PROPAGATE;
    }

    vfunc_navigate_focus(from, direction) {
        const backward = this._focusDirectionIsBackward(direction);
        if (backward !== null)
            return this._moveKeyboardFocus(backward, global.stage.get_key_focus() || from);

        return super.vfunc_navigate_focus(from, direction);
    }

    vfunc_button_press_event(event) {
        const [x, y] = event.get_coords();
        if (this._filterMenu.visible && this._pointInsideFilterMenu(x, y))
            return Clutter.EVENT_PROPAGATE;

        const [ok, localX, localY] = this._box.transform_stage_point(x, y);
        const insideBox = ok &&
            localX >= 0 && localX <= this._box.width &&
            localY >= 0 && localY <= this._box.height;

        if (!insideBox) {
            this.close();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _onCapturedEvent(event) {
        if (!this._open)
            return Clutter.EVENT_PROPAGATE;

        if (event.type() === Clutter.EventType.KEY_PRESS) {
            const symbol = event.get_key_symbol();
            if (symbol === Clutter.KEY_Tab || symbol === Clutter.KEY_ISO_Left_Tab)
                return this._moveKeyboardFocus(symbol === Clutter.KEY_ISO_Left_Tab, global.stage.get_key_focus());
            return Clutter.EVENT_PROPAGATE;
        }

        if (event.type() !== Clutter.EventType.BUTTON_PRESS)
            return Clutter.EVENT_PROPAGATE;

        const [x, y] = event.get_coords();
        const insideFilterMenu = this._filterMenu.visible && this._pointInsideFilterMenu(x, y);
        if (insideFilterMenu) {
            this._closeContextMenu();
            return Clutter.EVENT_PROPAGATE;
        }

        const [ok, localX, localY] = this._box.transform_stage_point(x, y);
        const insideBox = ok &&
            localX >= 0 && localX <= this._box.width &&
            localY >= 0 && localY <= this._box.height;

        if (!insideBox) {
            this.close();
            return Clutter.EVENT_STOP;
        }

        if (!this._pointInsideOpenMenu(x, y))
            this._closeContextMenu();
        if (this._filterMenu.visible && !this._pointInsideFilterMenu(x, y)) {
            this._setFilterMenuOpen(false);
            this._applyFilters();
        }

        return Clutter.EVENT_PROPAGATE;
    }

    _moveKeyboardFocus(backward, current = null) {
        const focusables = this._focusableActors();
        if (focusables.length === 0)
            return Clutter.EVENT_STOP;

        current = current || global.stage.get_key_focus();
        let index = focusables.findIndex(actor => actor === current);
        if (index < 0)
            index = focusables.findIndex(actor => this._actorHasFocus(actor, current));
        if (index < 0)
            index = backward ? 0 : -1;

        const next = focusables[(index + (backward ? -1 : 1) + focusables.length) % focusables.length];
        next.grab_key_focus();
        if (next instanceof ContainerCard) {
            this._selectCard(next);
            this._scrollCardIntoView(next);
        }
        return Clutter.EVENT_STOP;
    }

    _scrollCardIntoView(card) {
        if (card.get_parent() !== this._cardList)
            return;

        const adjustment = typeof this._scrollView.get_vadjustment === "function"
            ? this._scrollView.get_vadjustment()
            : this._scrollView.vadjustment;
        if (!adjustment)
            return;

        const box = card.get_allocation_box();
        const pageSize = adjustment.page_size ?? adjustment.pageSize;
        const upper = adjustment.upper ?? adjustment.get_upper?.();
        if (!pageSize || upper === undefined)
            return;

        let value = box.y1 + box.get_height() * 0.5 - pageSize * 0.5;
        value = Math.max(0, Math.min(value, Math.max(0, upper - pageSize)));
        adjustment.value = value;
    }

    _focusDirectionIsBackward(direction) {
        if (direction === St.DirectionType.TAB_FORWARD ||
            direction === St.DirectionType.DOWN ||
            direction === St.DirectionType.RIGHT)
            return false;
        if (direction === St.DirectionType.TAB_BACKWARD ||
            direction === St.DirectionType.UP ||
            direction === St.DirectionType.LEFT)
            return true;
        return null;
    }

    _actorHasFocus(actor, current) {
        if (!actor || !current)
            return false;
        if (actor === current)
            return true;
        let parent = current.get_parent?.();
        while (parent) {
            if (parent === actor)
                return true;
            parent = parent.get_parent?.();
        }
        return false;
    }

    _focusableActors() {
        if (this._filterMenu.visible)
            return [...this._statusFilterButtons.values()].filter(actor =>
                actor?.visible &&
                actor.mapped &&
                actor.reactive &&
                actor.opacity !== 0
            );

        if (this._actionMenu.visible)
            return this._actionMenu.focusableControls.filter(actor =>
                actor?.visible &&
                actor.mapped &&
                actor.reactive &&
                actor.opacity !== 0
            );

        const actors = [
            this._filterToggleBtn,
            this._searchEntry,
            this._searchFavoriteBtn,
        ];

        for (const [, card] of this._containerCards) {
            if (!card.visible)
                continue;
            actors.push(card, ...card.focusableControls);
        }

        if (this._inspectPanel.visible)
            actors.push(this._inspectCloseBtn);

        actors.push(this._settingsBtn, this._eyeBtn, this._toggleRunActionBtn, this._restartActionBtn);

        return actors.filter(actor =>
            actor?.visible &&
            actor.mapped &&
            actor.reactive &&
            actor.opacity !== 0
        );
    }

    _pointInsideFilterMenu(x, y) {
        return this._isPointInsideActor(this._filterMenu, x, y) ||
            this._isPointInsideActor(this._filterToggleBtn, x, y);
    }

    _pointInsideOpenMenu(x, y) {
        if (!this._actionMenu.visible)
            return false;

        return this._isPointInsideActor(this._actionMenu, x, y) ||
            (this._openMenuCard && this._isPointInsideActor(this._openMenuCard.menuButton, x, y));
    }

    _toggleContextMenu(card, sourceActor) {
        if (this._openMenuCard === card && this._actionMenu.visible) {
            this._closeContextMenu();
            return;
        }

        this._setFilterMenuOpen(false);
        this._applyFilters();
        this._openMenuCard = card;
        this._actionMenu.open(card._container, sourceActor);
        this._positionActionMenu(sourceActor);
        this._actionMenu.focusableControls[0]?.grab_key_focus();
    }

    _closeContextMenu() {
        this._actionMenu.close();
        this._openMenuCard = null;
    }

    _positionActionMenu(sourceActor) {
        const [buttonX, buttonY] = sourceActor.get_transformed_position();
        const [buttonWidth, buttonHeight] = sourceActor.get_transformed_size();
        const [boxX, boxY] = this._box.get_transformed_position();
        const [boxWidth] = this._box.get_transformed_size();
        const [, menuWidth] = this._actionMenu.get_preferred_width(-1);
        const [, menuHeight] = this._actionMenu.get_preferred_height(-1);
        const margin = 8;

        let x = buttonX + buttonWidth - menuWidth;
        x = Math.max(boxX + margin, x);
        x = Math.min(boxX + boxWidth - menuWidth - margin, x);

        let y = buttonY + buttonHeight + 4;
        const bottomLimit = boxY + this._box.height - menuHeight - margin;
        if (y > bottomLimit)
            y = buttonY - menuHeight - 4;
        y = Math.max(boxY + margin, y);

        this._actionMenu.set_position(Math.round(x), Math.round(y));
    }

    _isPointInsideActor(actor, x, y) {
        const [ok, localX, localY] = actor.transform_stage_point(x, y);
        return ok &&
            localX >= 0 && localX <= actor.width &&
            localY >= 0 && localY <= actor.height;
    }
}


class ContainerActionMenu extends St.BoxLayout {
    static {
        GObject.registerClass(this);
    }

    constructor(opts) {
        super({
            vertical: true,
            style_class: "container-action-menu",
            visible: false,
            reactive: true,
        });

        this._opts = opts;
        this._container = null;
    }

    open(container) {
        this._container = container;
        this._rebuild();
        this.show();
        const parent = this.get_parent();
        if (parent && typeof parent.set_child_above_sibling === "function")
            parent.set_child_above_sibling(this, null);
    }

    close() {
        this.hide();
        this._container = null;
        this.destroy_all_children();
    }

    get focusableControls() {
        return this.get_children().filter(actor => actor.can_focus);
    }

    _rebuild() {
        this.destroy_all_children();

        const category = statusCategory(this._container.status);
        const isRunning = category === "running";
        const isPaused = category === "paused";

        if (isRunning)
            this._addAction("Pause", "media-playback-pause-symbolic", () => this._container.pause());
        if (isPaused)
            this._addAction("Unpause", "media-playback-start-symbolic", () => this._container.unpause());

        if (isRunning || isPaused)
            this._addSeparator();

        this._addAction("Top Resources", "view-list-symbolic", () => this._container.watchTop());
        this._addAction("Open Shell", "utilities-terminal-symbolic", () => this._container.shell());
        this._addAction("Live Stats", "utilities-system-monitor-symbolic", () => this._container.stats());
        this._addAction("Show Logs", "text-x-generic-symbolic", () => this._container.logs());
        this._addAction("Copy Inspect", "edit-copy-symbolic", async () => {
            try {
                const details = await this._container.details();
                const clipboard = St.Clipboard.get_default();
                clipboard.set_text(St.ClipboardType.CLIPBOARD, details);
                clipboard.set_text(St.ClipboardType.PRIMARY, details);
                if (this._opts.onInspectCopied)
                    this._opts.onInspectCopied(details);
                Main.notify("Container details copied");
            } catch (e) {
                Main.notify("Unable to copy container details", e.message);
            }
        });

        if (category === "stopped") {
            this._addSeparator();
            this._addAction("Remove", "user-trash-symbolic", () => {
                if (this._opts.onDelete)
                    this._opts.onDelete(this._container);
            }, "danger");
        }
    }

    _addAction(label, iconName, callback, variant = "") {
        const btn = new St.Button({
            style_class: `container-action-menu-item${variant ? ` ${variant}` : ""}`,
            x_expand: true,
            can_focus: true,
        });
        const row = new St.BoxLayout({style_class: "container-action-menu-row"});
        row.add_child(new St.Icon({icon_name: iconName, icon_size: 14, style_class: "popup-menu-icon"}));
        row.add_child(new St.Label({
            text: label,
            style_class: "container-action-menu-label",
            y_align: Clutter.ActorAlign.CENTER,
        }));
        btn.child = row;
        btn.connect("clicked", () => {
            callback();
            if (this._opts.onClose)
                this._opts.onClose();
        });
        this.add_child(btn);
    }

    _addSeparator() {
        this.add_child(new St.Bin({style_class: "container-action-menu-separator"}));
    }
}


class ContainerCard extends St.BoxLayout {
    static {
        GObject.registerClass(this);
    }

    constructor(container, opts) {
        super({
            vertical: true,
            style_class: "dialog-card",
            x_expand: true,
            reactive: true,
            can_focus: true,
            visible: true,
        });

        this._container = container;
        this._opts = opts;
        this._selected = opts.selected || false;
        this.connect("enter-event", () => {
            this.add_style_pseudo_class("hover");
            return Clutter.EVENT_PROPAGATE;
        });
        this.connect("leave-event", () => {
            this.remove_style_pseudo_class("hover");
            return Clutter.EVENT_PROPAGATE;
        });
        this.connect("key-focus-in", () => this._select());
        this.connect("key-press-event", (_actor, event) => this._handleKeyPress(event));

        const preview = new St.BoxLayout({
            vertical: true,
            style_class: "card-preview",
            x_expand: true,
            reactive: true,
        });
        preview.connect("button-press-event", () => {
            this._select();
            return Clutter.EVENT_STOP;
        });

        // --- Preview Header ---
        const topRow = new St.BoxLayout({style_class: "card-top-row"});

        this._statusIcon = new St.Icon({
            icon_name: "action-unavailable-symbolic",
            icon_size: 14,
            style_class: "card-status-icon status-undefined",
        });
        topRow.add_child(this._statusIcon);

        this._nameLabel = new St.Label({
            text: container.name,
            style_class: "card-name",
            y_align: Clutter.ActorAlign.CENTER,
        });
        topRow.add_child(this._nameLabel);
        preview.add_child(topRow);

        // --- Image Line ---
        this._imageLabel = new St.Label({
            text: container.image || "",
            style_class: "card-subtitle",
        });
        preview.add_child(this._imageLabel);

        // Action buttons
        const actionsRow = new St.BoxLayout({
            style_class: "card-actions-row",
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.START,
        });

        this._deleteBtn = new St.Button({
            style_class: "card-icon-button card-delete-button",
            can_focus: true,
            y_align: Clutter.ActorAlign.START,
            y_expand: false,
            child: new St.Icon({icon_name: "user-trash-symbolic", icon_size: 14}),
        });
        this._deleteBtn.connect("clicked", () => {
            this._select();
            if (this._opts.onDelete)
                this._opts.onDelete(this._container);
        });
        this._deleteBtn.connect("key-focus-in", () => this._select());
        this._deleteBtn.connect("key-press-event", (_actor, event) => this._handleKeyPress(event));
        actionsRow.add_child(this._deleteBtn);

        this._favoriteBtn = new St.Button({
            style_class: "card-icon-button card-favorite-button",
            toggle_mode: true,
            checked: opts.favorite || false,
            can_focus: true,
            y_align: Clutter.ActorAlign.START,
            y_expand: false,
            child: new St.Icon({icon_name: "starred-symbolic", icon_size: 14}),
        });
        this._favoriteBtn.connect("clicked", () => {
            this._select();
            if (this._opts.onToggleFavorite)
                this._favoriteBtn.checked = this._opts.onToggleFavorite(this._container.id);
        });
        this._favoriteBtn.connect("key-focus-in", () => this._select());
        this._favoriteBtn.connect("key-press-event", (_actor, event) => this._handleKeyPress(event));
        actionsRow.add_child(this._favoriteBtn);

        this._kebabBtn = new St.Button({
            style_class: "card-icon-button",
            can_focus: true,
            y_align: Clutter.ActorAlign.START,
            y_expand: false,
            child: new St.Icon({icon_name: "view-more-symbolic", icon_size: 14}),
        });
        this._kebabBtn.connect("clicked", () => {
            this._select();
            if (this._opts.onOpenMenu)
                this._opts.onOpenMenu(this, this._kebabBtn);
        });
        this._kebabBtn.connect("key-focus-in", () => this._select());
        this._kebabBtn.connect("key-press-event", (_actor, event) => this._handleKeyPress(event));
        actionsRow.add_child(this._kebabBtn);

        const previewRow = new St.BoxLayout({x_expand: true, y_expand: false});
        previewRow.add_child(preview);
        previewRow.add_child(actionsRow);
        this.add_child(previewRow);

        // --- Metadata Row ---
        const metaRow = new St.BoxLayout({
            style_class: "card-meta",
            reactive: true,
        });
        metaRow.connect("button-press-event", () => {
            this._select();
            return Clutter.EVENT_STOP;
        });

        this._statusLabel = new St.Label({
            style_class: "card-meta-item",
            y_align: Clutter.ActorAlign.CENTER,
        });
        metaRow.add_child(this._statusLabel);

        const metaSpacer = new St.Bin({x_expand: true});
        metaRow.add_child(metaSpacer);

        this._createdBin = new St.Bin({
            style_class: "card-date-bin",
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: false,
        });
        this._createdBin.set_width(108);

        this._createdLabel = new St.Label({
            style_class: "card-meta-item card-meta-right",
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._createdBin.child = this._createdLabel;
        metaRow.add_child(this._createdBin);

        this.add_child(metaRow);

        this._updateFromContainer(container);
    }

    get menuButton() {
        return this._kebabBtn;
    }

    get focusableControls() {
        return [this._deleteBtn, this._favoriteBtn, this._kebabBtn];
    }

    vfunc_navigate_focus(from, direction) {
        const backward = this._focusDirectionIsBackward(direction);
        if (backward !== null) {
            if (this._opts.onMoveFocus)
                return this._opts.onMoveFocus(backward, global.stage.get_key_focus() || from);
            return Clutter.EVENT_STOP;
        }

        return super.vfunc_navigate_focus(from, direction);
    }

    _focusDirectionIsBackward(direction) {
        if (direction === St.DirectionType.TAB_FORWARD ||
            direction === St.DirectionType.DOWN ||
            direction === St.DirectionType.RIGHT)
            return false;
        if (direction === St.DirectionType.TAB_BACKWARD ||
            direction === St.DirectionType.UP ||
            direction === St.DirectionType.LEFT)
            return true;
        return null;
    }

    _handleKeyPress(event) {
        const symbol = event.get_key_symbol();
        if (symbol === Clutter.KEY_Return || symbol === Clutter.KEY_KP_Enter) {
            this._select();
            if (this._opts.onToggleRunState)
                this._opts.onToggleRunState(this._container);
            return Clutter.EVENT_STOP;
        }

        if (symbol !== Clutter.KEY_Tab && symbol !== Clutter.KEY_ISO_Left_Tab)
            return Clutter.EVENT_PROPAGATE;

        if (this._opts.onMoveFocus)
            return this._opts.onMoveFocus(symbol === Clutter.KEY_ISO_Left_Tab, global.stage.get_key_focus());
        return Clutter.EVENT_PROPAGATE;
    }

    _isStopped() {
        return statusCategory(this._container.status) === "stopped";
    }

    get statusCategory() {
        return statusCategory(this._container.status);
    }

    update(container, favorite, selected) {
        this._container = container;
        this._favoriteBtn.checked = favorite;
        this._selected = selected;
        this._updateFromContainer(container);
    }

    setSelected(selected) {
        this._selected = selected;
        this._updateStyleClass();
    }

    _select() {
        if (this._opts.onSelect)
            this._opts.onSelect(this);
    }

    _updateFromContainer(container) {
        this._container = container;

        this._nameLabel.text = container.name;
        this._imageLabel.text = container.image || "";

        const category = statusCategory(container.status);
        let iconName, styleClass, cardClass;

        switch (category) {
            case "stopped":
                iconName = "media-playback-stop-symbolic";
                styleClass = "status-stopped";
                cardClass = "status-stopped-card";
                break;
            case "running":
                iconName = "media-playback-start-symbolic";
                styleClass = "status-running";
                cardClass = "status-running-card";
                break;
            case "paused":
                iconName = "media-playback-pause-symbolic";
                styleClass = "status-paused";
                cardClass = "status-paused-card";
                break;
            default:
                iconName = "action-unavailable-symbolic";
                styleClass = "status-undefined";
                cardClass = "status-undefined-card";
        }

        this._cardClass = cardClass;
        this._updateStyleClass();
        this._statusIcon.icon_name = iconName;
        this._statusIcon.style_class = `card-status-icon ${styleClass}`;
        this._statusLabel.text = container.status;

        if (container.createdAt) {
            try {
                const d = new Date(container.createdAt);
                if (!isNaN(d.getTime())) {
                    const opts = {month: "short", day: "numeric"};
                    this._createdLabel.text = d.toLocaleDateString("en-US", opts);
                } else {
                    this._createdLabel.text = container.createdAt.slice(0, 10);
                }
            } catch (e) {
                this._createdLabel.text = container.createdAt.slice(0, 10);
            }
        } else {
            this._createdLabel.text = "";
        }

        this._deleteBtn.visible = category === "stopped";
    }

    _updateStyleClass() {
        const selectedClass = this._selected ? " selected" : "";
        this.style_class = `dialog-card ${this._cardClass || ""}${selectedClass}`;
    }
}


function isGrabRevoked(grab) {
    if (!grab) return true;
    if (typeof grab.is_revoked === "function")
        return grab.is_revoked();
    if (typeof grab.get_seat_state === "function")
        return grab.get_seat_state() !== 2; // Clutter.GrabState.ALL
    return false;
}


function statusCategory(statusText) {
    const status = statusText.split(" ")[0];
    if (["Exited", "exited", "Created", "created", "configured", "stopped"].includes(status))
        return "stopped";
    if (["Up", "running"].includes(status))
        return "running";
    if (["Paused", "paused"].includes(status))
        return "paused";
    return "other";
}


function normalizeStatusFilter(value) {
    return ["all", "running", "stopped", "paused", "other"].includes(value) ? value : "all";
}


class RemoveContainerDialog extends ModalDialog.ModalDialog {
    static {
        GObject.registerClass(this);
    }

    constructor(container) {
        super();
        const content = new Dialog.MessageDialogContent({
            title: "Remove Container",
            description: `Are you sure you want to remove container ${container.name}?`,
        });
        this.contentLayout.add_child(content);
        this.addButton({
            action: () => this.close(),
            label: "Cancel",
            key: Clutter.KEY_Escape,
        });
        this.addButton({
            action: () => {
                this.close();
                container.rm();
            },
            label: "Remove",
        });
    }
}
