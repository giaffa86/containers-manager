"use strict";

import Clutter from "gi://Clutter";
import GObject from "gi://GObject";
import St from "gi://St";
import * as Main from "resource:///org/gnome/shell/ui/main.js";

import {statusCategory} from "./utils.js";

export class ContainerActionMenu extends St.BoxLayout {
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
        if (parent)
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
        const isHidden = this._opts.isHidden(this._container.id);

        if (isRunning)
            this._addAction("Pause", "media-playback-pause-symbolic", () => this._runCommand(() => this._container.pause()));
        if (isPaused)
            this._addAction("Unpause", "media-playback-start-symbolic", () => this._runCommand(() => this._container.unpause()));

        if (isRunning || isPaused)
            this._addSeparator();

        this._addAction(
            isHidden ? "Show" : "Hide",
            isHidden ? "view-reveal-symbolic" : "view-conceal-symbolic",
            () => this._opts.onToggleHidden(this._container)
        );
        this._addSeparator();

        this._addAction("Top Resources", "view-list-symbolic", () => this._container.watchTop());
        this._addAction("Open Shell", "utilities-terminal-symbolic", () => this._container.shell());
        this._addAction("Live Stats", "utilities-system-monitor-symbolic", () => this._container.stats());
        this._addAction("Show Logs", "text-x-generic-symbolic", () => this._container.logs());
        this._addAction("Copy inspect data", "edit-copy-symbolic", async () => {
            try {
                const details = await this._container.details();
                const clipboard = St.Clipboard.get_default();
                clipboard.set_text(St.ClipboardType.CLIPBOARD, details);
                clipboard.set_text(St.ClipboardType.PRIMARY, details);
                Main.notify("Inspect data copied");
            } catch (e) {
                Main.notify("Unable to copy inspect data", e.message);
            }
        });

        if (category === "stopped") {
            this._addSeparator();
            this._addAction("Remove", "user-trash-symbolic",
                () => this._opts.onDelete(this._container), "danger");
        }
    }

    _addAction(label, iconName, callback, variant = "") {
        const btn = new St.Button({
            style_class: `container-action-menu-item${variant ? ` ${variant}` : ""}`,
            x_expand: true,
            can_focus: true,
        });
        btn.set_accessible_name(label);
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
            this._opts.onClose();
        });
        this.add_child(btn);
    }

    _addSeparator() {
        this.add_child(new St.Bin({style_class: "container-action-menu-separator"}));
    }

    _runCommand(callback) {
        callback().catch(() => {
            // Runtime already reports command errors and shows the user-facing notification.
        });
    }
}
