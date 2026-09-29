"use strict";

import Clutter from "gi://Clutter";
import GObject from "gi://GObject";
import * as Dialog from "resource:///org/gnome/shell/ui/dialog.js";
import * as ModalDialog from "resource:///org/gnome/shell/ui/modalDialog.js";

export class RemoveContainerDialog extends ModalDialog.ModalDialog {
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
                container.rm().catch(() => {
                    // Runtime already reports command errors and shows the user-facing notification.
                });
            },
            label: "Remove",
        });
    }
}
