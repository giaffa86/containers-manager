"use strict";

import Clutter from "gi://Clutter";
import GLib from "gi://GLib";
import GObject from "gi://GObject";
import Shell from "gi://Shell";
import St from "gi://St";
import * as Main from "resource:///org/gnome/shell/ui/main.js";

import * as Runtime from "./runtime.js";
import {ContainerActionMenu} from "./containerActionMenu.js";
import {ContainerCard} from "./containerCard.js";
import {RemoveContainerDialog} from "./removeContainerDialog.js";
import {focusDirectionIsBackward, isGrabRevoked, statusCategory} from "./utils.js";

export class ContainerDialog extends St.Widget {
    static {
        GObject.registerClass(this);
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
        this._grab = null;
        this._containerCards = new Map();
        this._renderRequestId = 0;
        this._positionRequestId = 0;
        this._openMenuCard = null;
        this._removeDialog = null;

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
        this._filterToggleBtn.set_accessible_name("Filter containers");
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
        searchFavoriteBtn.set_accessible_name("Show favorite containers only");
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
        this._filterMenu.add_child(new St.Bin({style_class: "container-action-menu-separator"}));
        this._addHiddenFilterOption();
        this._syncFilterMenu();

        const headerSep = new St.Bin({style_class: "dialog-separator"});
        this._box.add_child(headerSep);

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
            isHidden: (containerId) => this._ext._hiddenIds.has(containerId),
            onToggleHidden: (container) => {
                this._ext._toggleHidden(container.id);
                this._applyFilters();
            },
            onDelete: (container) => this._openRemoveDialog(container),
        });
        this.add_child(this._actionMenu);

        this._noContainersLabel = new St.Label({
            text: "No containers found",
            style_class: "dialog-no-containers",
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._box.add_child(this._noContainersLabel);

        const footerSep = new St.Bin({style_class: "dialog-separator"});
        this._box.add_child(footerSep);

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
        this._eyeBtn.set_accessible_name("Show stopped containers");
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
            () => this._restartSelectedContainer()
        );
        toolbar.add_child(this._restartActionBtn);
        this._syncSelectionActions();

        this._box.add_child(toolbar);
    }

    get opened() {
        return this._open;
    }

    destroy() {
        // Bump the request id so any in-flight refresh is discarded.
        this._renderRequestId++;
        this._dismissRemoveDialog();
        if (this._open)
            this.close();
        this._cancelQueuedPositionBox();
        super.destroy();
    }

    toggle() {
        if (!this._open)
            this.open();
        else
            this.close();
    }

    open() {
        if (this._open) return;

        this._grab = Main.pushModal(this, {actionMode: Shell.ActionMode.SYSTEM_MODAL});
        if (isGrabRevoked(this._grab)) {
            Main.popModal(this._grab);
            this._grab = null;
            return;
        }

        this._open = true;
        this._setFilterMenuOpen(false);
        this._closeContextMenu();
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

        this._open = false;
        this._renderRequestId++;
        this._setFilterMenuOpen(false);
        this._closeContextMenu();
        this._scrollView.set_height(0);
        this._cancelQueuedPositionBox();

        Main.popModal(this._grab);
        this._grab = null;
        this.hide();

        this._ext._stopSync();
    }

    _refresh() {
        if (!this._open)
            return;

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
            this._noContainersLabel.text = `Unable to load containers: ${err.message}`;
            this._noContainersLabel.visible = true;
            this._positionBox();
        });
    }

    _renderContainers(containers) {
        let sorted = this._ext._sortFavoritesFirst(containers);
        this._ext._updateIndicatorCount(containers);
        const currentIds = new Set(sorted.map(c => c.id));
        let hiddenChanged = false;
        for (const id of this._ext._hiddenIds) {
            if (!currentIds.has(id)) {
                this._ext._hiddenIds.delete(id);
                hiddenChanged = true;
            }
        }
        if (hiddenChanged)
            this._ext._persistHiddenState();

        let favoritesChanged = false;
        for (const id of this._ext._favoriteIds) {
            if (!currentIds.has(id)) {
                this._ext._favoriteIds.delete(id);
                favoritesChanged = true;
            }
        }
        if (favoritesChanged)
            this._ext._persistFavoriteState();

        if (this._ext._selectedContainerId && !currentIds.has(this._ext._selectedContainerId))
            this._ext._selectedContainerId = null;

        for (const [id, card] of this._containerCards) {
            if (!currentIds.has(id)) {
                if (this._openMenuCard === card)
                    this._closeContextMenu();
                card.destroy();
                this._containerCards.delete(id);
            }
        }

        let index = 0;
        for (const container of sorted) {
            if (this._containerCards.has(container.id)) {
                const card = this._containerCards.get(container.id);
                card.update(
                    container,
                    this._ext._favoriteIds.has(container.id),
                    this._ext._hiddenIds.has(container.id),
                    this._ext._selectedContainerId === container.id
                );
                this._cardList.set_child_at_index(card, index);
            } else {
                const card = new ContainerCard(container, {
                    favorite: this._ext._favoriteIds.has(container.id),
                    hidden: this._ext._hiddenIds.has(container.id),
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
                        this._ext._persistFavoriteState();
                        this._renderContainers([...this._containerCards.values()].map(card => card._container));
                        return favorite;
                    },
                    onDelete: (container) => this._openRemoveDialog(container),
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

    _refreshVisibleFavoriteState() {
        for (const [, card] of this._containerCards)
            card.setFavorite(this._ext._favoriteIds.has(card._container.id));
    }

    _applyFilters() {
        const searchText = this._ext._searchText;
        const showStopped = this._ext._showStopped;
        const statusFilter = this._ext._statusFilter;
        const favoritesOnly = this._ext._favoritesOnly;
        const showHidden = this._ext._showHidden;
        let visibleCount = 0;

        for (const [, card] of this._containerCards) {
            let visible = true;
            const hidden = this._ext._hiddenIds.has(card._container.id);
            card.setHidden(hidden);
            if (!showHidden && hidden)
                visible = false;
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
            ? "No matching containers"
            : "No containers found";
        this._noContainersLabel.visible = !hasContainers || visibleCount === 0;

        if (this._open)
            this._queuePositionBox();
    }

    _addFilterOption(value, label, iconName) {
        const btn = new St.Button({
            style_class: "dialog-filter-option",
            toggle_mode: true,
            x_expand: true,
            can_focus: true,
        });
        btn.set_accessible_name(label);
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

    _addHiddenFilterOption() {
        const btn = new St.Button({
            style_class: "dialog-filter-option",
            toggle_mode: true,
            x_expand: true,
            can_focus: true,
        });
        btn.set_accessible_name("Show hidden containers");
        const row = new St.BoxLayout({style_class: "dialog-filter-option-row"});
        row.add_child(new St.Icon({icon_name: "view-reveal-symbolic", icon_size: 14, style_class: "popup-menu-icon"}));
        row.add_child(new St.Label({
            text: "Show hidden",
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
            this._ext._showHidden = btn.checked;
            this._ext._persistHiddenState();
            this._syncFilterMenu();
            this._applyFilters();
        });
        this._filterMenu.add_child(btn);
        this._showHiddenBtn = btn;
        this._showHiddenCheckIcon = checkIcon;
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
            if (parent)
                parent.set_child_above_sibling(this._filterMenu, null);
            this._positionFilterMenu();
            this._statusFilterButtons.get(this._ext._statusFilter).grab_key_focus();
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
        this._showHiddenBtn.checked = this._ext._showHidden;
        this._showHiddenCheckIcon.visible = this._ext._showHidden;
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
        if (iconName === "emblem-system-symbolic")
            btn.set_accessible_name("Open preferences");
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
        const container = this._selectedContainer();
        const category = container ? statusCategory(container.status) : null;
        const canStart = category === "stopped";
        const canStop = category === "running";

        this._toggleRunActionIcon.icon_name = canStop
            ? "media-playback-stop-symbolic"
            : "media-playback-start-symbolic";
        this._toggleRunActionBtn.set_accessible_name(canStop
            ? "Stop selected container"
            : "Start selected container");
        this._setActionButtonEnabled(this._toggleRunActionBtn, canStart || canStop);
        this._restartActionBtn.set_accessible_name("Restart selected container");
        this._setActionButtonEnabled(this._restartActionBtn, category === "running" || category === "paused");
    }

    _setActionButtonEnabled(btn, enabled) {
        btn.reactive = enabled;
        btn.can_focus = enabled;
        btn.opacity = enabled ? 255 : 96;
    }

    _restartSelectedContainer() {
        const container = this._selectedContainer();
        if (!container)
            return;

        const category = statusCategory(container.status);
        if (category === "running" || category === "paused")
            this._runContainerCommand(() => container.restart());
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
            this._runContainerCommand(() => container.start());
        else if (category === "running")
            this._runContainerCommand(() => container.stop());
    }

    async _runContainerCommand(callback) {
        await callback().catch(() => {
            // Runtime already reports command errors and shows the user-facing notification.
        });
        this._refresh();
    }

    _updateEyeButton() {
        this._eyeIcon.icon_name = this._ext._showStopped
            ? "view-reveal-symbolic"
            : "view-conceal-symbolic";
        this._eyeBtn.set_accessible_name(this._ext._showStopped
            ? "Hide stopped containers"
            : "Show stopped containers");
    }

    _positionBox() {
        this._cancelQueuedPositionBox();
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
        const maxScrollHeight = Math.max(96, availableHeight - chromeHeight);
        const preferredScrollHeight = Math.min(420, maxScrollHeight);
        const scrollHeight = Math.max(Math.min(180, maxScrollHeight), preferredScrollHeight);
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

    _queuePositionBox() {
        if (this._positionRequestId)
            return;

        this._positionRequestId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._positionRequestId = 0;
            if (this._open)
                this._positionBox();
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelQueuedPositionBox() {
        if (!this._positionRequestId)
            return;

        GLib.source_remove(this._positionRequestId);
        this._positionRequestId = 0;
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
        if (event.get_key_symbol() !== Clutter.KEY_Escape)
            return Clutter.EVENT_PROPAGATE;

        this.close();
        return Clutter.EVENT_STOP;
    }

    vfunc_navigate_focus(from, direction) {
        const backward = focusDirectionIsBackward(direction);
        if (backward !== null)
            return this._moveKeyboardFocus(backward, global.stage.get_key_focus() || from);

        return super.vfunc_navigate_focus(from, direction);
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

        const adjustment = this._scrollView.get_vadjustment();
        const box = card.get_allocation_box();
        const pageSize = adjustment.get_page_size();
        const upper = adjustment.get_upper();
        if (!pageSize)
            return;

        let value = box.y1 + box.get_height() * 0.5 - pageSize * 0.5;
        value = Math.max(0, Math.min(value, Math.max(0, upper - pageSize)));
        adjustment.set_value(value);
    }

    _actorHasFocus(actor, current) {
        if (!actor || !current)
            return false;
        if (actor === current)
            return true;
        let parent = current.get_parent();
        while (parent) {
            if (parent === actor)
                return true;
            parent = parent.get_parent();
        }
        return false;
    }

    _focusableActors() {
        if (this._filterMenu.visible)
            return [...this._statusFilterButtons.values(), this._showHiddenBtn].filter(actor =>
                actor.visible &&
                actor.mapped &&
                actor.reactive &&
                actor.opacity !== 0
            );

        if (this._actionMenu.visible)
            return this._actionMenu.focusableControls.filter(actor =>
                actor.visible &&
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

        actors.push(this._settingsBtn, this._eyeBtn, this._toggleRunActionBtn, this._restartActionBtn);

        return actors.filter(actor =>
            actor.visible &&
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
        this._actionMenu.open(card._container);
        this._positionActionMenu(sourceActor);
        this._actionMenu.focusableControls[0].grab_key_focus();
    }

    _closeContextMenu() {
        this._actionMenu.close();
        this._openMenuCard = null;
    }

    _openRemoveDialog(container) {
        this._closeContextMenu();
        this._dismissRemoveDialog();
        const dialog = new RemoveContainerDialog(container);
        this._removeDialog = dialog;
        dialog.connect("closed", () => {
            if (this._removeDialog === dialog)
                this._removeDialog = null;
        });
        if (!dialog.open()) {
            this._removeDialog = null;
            dialog.destroy();
        }
    }

    _dismissRemoveDialog() {
        const dialog = this._removeDialog;
        this._removeDialog = null;
        // close() pops the modal grab synchronously; destroyOnClose then
        // destroys the dialog once its fade-out completes.
        dialog?.close();
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
