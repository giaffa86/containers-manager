"use strict";

import Pango from "gi://Pango";
import St from "gi://St";

export function ellipsizeLabel(label) {
    label.clutter_text.line_wrap = false;
    label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
}

export function isGrabRevoked(grab) {
    return !grab || grab.is_revoked();
}

export function focusDirectionIsBackward(direction) {
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

export function statusCategory(statusText) {
    const status = statusText.split(" ")[0];
    if (["Exited", "exited", "Created", "created", "configured", "stopped"].includes(status))
        return "stopped";
    if (["Up", "running"].includes(status))
        return "running";
    if (["Paused", "paused"].includes(status))
        return "paused";
    return "other";
}

export function normalizeStatusFilter(value) {
    return ["all", "running", "stopped", "paused", "other"].includes(value) ? value : "all";
}
