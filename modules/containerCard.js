"use strict";

import Clutter from "gi://Clutter";
import GObject from "gi://GObject";
import St from "gi://St";

import {ellipsizeLabel, focusDirectionIsBackward, statusCategory} from "./utils.js";

export class ContainerCard extends St.BoxLayout {
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
        this._selected = opts.selected;
        this._hidden = opts.hidden;
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

        const topRow = new St.BoxLayout({style_class: "card-top-row", x_expand: true});

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
            x_expand: true,
        });
        ellipsizeLabel(this._nameLabel);
        topRow.add_child(this._nameLabel);
        preview.add_child(topRow);

        this._imageLabel = new St.Label({
            text: container.image || "",
            style_class: "card-subtitle",
            x_expand: true,
        });
        ellipsizeLabel(this._imageLabel);
        preview.add_child(this._imageLabel);

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
        this._deleteBtn.set_accessible_name(`Remove ${container.name}`);
        this._deleteBtn.connect("clicked", () => {
            this._select();
            this._opts.onDelete(this._container);
        });
        this._deleteBtn.connect("key-focus-in", () => this._select());
        this._deleteBtn.connect("key-press-event", (_actor, event) => this._handleKeyPress(event));
        actionsRow.add_child(this._deleteBtn);

        this._favoriteBtn = new St.Button({
            style_class: "card-icon-button card-favorite-button",
            toggle_mode: true,
            checked: opts.favorite,
            can_focus: true,
            y_align: Clutter.ActorAlign.START,
            y_expand: false,
            child: new St.Icon({icon_name: "starred-symbolic", icon_size: 14}),
        });
        this._favoriteBtn.set_accessible_name(`Add ${container.name} to favorites`);
        this._favoriteBtn.connect("clicked", () => {
            this._select();
            this.setFavorite(this._opts.onToggleFavorite(this._container.id));
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
        this._kebabBtn.set_accessible_name(`More actions for ${container.name}`);
        this._kebabBtn.connect("clicked", () => {
            this._select();
            this._opts.onOpenMenu(this, this._kebabBtn);
        });
        this._kebabBtn.connect("key-focus-in", () => this._select());
        this._kebabBtn.connect("key-press-event", (_actor, event) => this._handleKeyPress(event));
        actionsRow.add_child(this._kebabBtn);

        const previewRow = new St.BoxLayout({x_expand: true, y_expand: false});
        previewRow.add_child(preview);
        previewRow.add_child(actionsRow);
        this.add_child(previewRow);

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
            x_expand: true,
        });
        ellipsizeLabel(this._statusLabel);
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
        ellipsizeLabel(this._createdLabel);
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
        const backward = focusDirectionIsBackward(direction);
        if (backward !== null)
            return this._opts.onMoveFocus(backward, global.stage.get_key_focus() || from);

        return super.vfunc_navigate_focus(from, direction);
    }

    _handleKeyPress(event) {
        const symbol = event.get_key_symbol();
        if (symbol === Clutter.KEY_Return || symbol === Clutter.KEY_KP_Enter) {
            this._select();
            this._opts.onToggleRunState(this._container);
            return Clutter.EVENT_STOP;
        }

        if (symbol !== Clutter.KEY_Tab && symbol !== Clutter.KEY_ISO_Left_Tab)
            return Clutter.EVENT_PROPAGATE;

        return this._opts.onMoveFocus(symbol === Clutter.KEY_ISO_Left_Tab, global.stage.get_key_focus());
    }

    _isStopped() {
        return statusCategory(this._container.status) === "stopped";
    }

    get statusCategory() {
        return statusCategory(this._container.status);
    }

    update(container, favorite, hidden, selected) {
        this._container = container;
        this.setFavorite(favorite);
        this._hidden = hidden;
        this._selected = selected;
        this._updateFromContainer(container);
    }

    setFavorite(favorite) {
        this._favoriteBtn.checked = favorite;
        this._favoriteBtn.set_accessible_name(favorite
            ? `Remove ${this._container.name} from favorites`
            : `Add ${this._container.name} to favorites`);
    }

    setSelected(selected) {
        this._selected = selected;
        this._updateStyleClass();
    }

    setHidden(hidden) {
        this._hidden = hidden;
        this._updateStyleClass();
    }

    _select() {
        this._opts.onSelect(this);
    }

    _updateFromContainer(container) {
        this._container = container;

        this._nameLabel.text = container.name;
        this._imageLabel.text = container.image || "";
        this.set_accessible_name(`${container.name}, ${container.status}`);

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
        this._deleteBtn.set_accessible_name(`Remove ${container.name}`);
        this._favoriteBtn.set_accessible_name(this._favoriteBtn.checked
            ? `Remove ${container.name} from favorites`
            : `Add ${container.name} to favorites`);
        this._kebabBtn.set_accessible_name(`More actions for ${container.name}`);

        if (container.createdAt) {
            const d = new Date(container.createdAt);
            if (!isNaN(d.getTime()))
                this._createdLabel.text = d.toLocaleDateString("en-US", {month: "short", day: "numeric"});
            else
                this._createdLabel.text = container.createdAt;
        } else {
            this._createdLabel.text = "";
        }

        this._deleteBtn.visible = category === "stopped";
    }

    _updateStyleClass() {
        const selectedClass = this._selected ? " selected" : "";
        const hiddenClass = this._hidden ? " hidden-card" : "";
        this.style_class = `dialog-card ${this._cardClass || ""}${hiddenClass}${selectedClass}`;
    }
}
