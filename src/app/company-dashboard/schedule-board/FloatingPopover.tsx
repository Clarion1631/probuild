"use client";

import { type ReactNode, type RefObject } from "react";
import { FloatingLayer, type FloatingAnchorPoint } from "@/components/FloatingLayer";

export type FloatingPopoverAnchorPoint = FloatingAnchorPoint;

export interface FloatingPopoverProps {
    open: boolean;
    /** Anchor to a trigger element's live bounding rect — the panel right-aligns to it. Ignored when `anchorPoint` is also given. */
    anchorRef?: RefObject<HTMLElement | null>;
    /** Anchor to an explicit viewport point (e.g. a `contextmenu` event's clientX/clientY) instead of an element — the panel's top-left opens at the point, like a native context menu. Takes precedence over `anchorRef` when both are given. */
    anchorPoint?: FloatingPopoverAnchorPoint | null;
    onClose: () => void;
    children: ReactNode;
    /** Panel width in px — the panel right-aligns to the trigger by default, then clamps into the viewport. */
    width?: number;
    /** Non-interactive hover card mode (schedule-board task hover notes): the panel never captures pointer events, so it can never trap the mouse mid-hover. Default false (normal click/context menu). */
    pointerEventsNone?: boolean;
}

/**
 * The schedule board's card-styled popover: chrome (border, white panel,
 * padding, shadow, close button) over the shared `FloatingLayer`.
 *
 * All positioning and dismissal behaviour — portal to document.body, anchor
 * measurement, flip-above, viewport clamping, height capping with internal
 * scroll, re-place on scroll/resize/content-resize, Escape, outside
 * pointerdown — now lives in FloatingLayer, which the project schedule page's
 * popovers share. This component's public API is unchanged.
 *
 * FloatingLayer's wrapper is `position: fixed`, which is a containing block, so
 * the absolutely-positioned close button still anchors to the panel.
 */
export function FloatingPopover({ open, anchorRef, anchorPoint, onClose, children, width = 224, pointerEventsNone = false }: FloatingPopoverProps) {
    return (
        <FloatingLayer
            open={open}
            anchorRef={anchorRef}
            anchorPoint={anchorPoint}
            onClose={onClose}
            width={width}
            pointerEventsNone={pointerEventsNone}
            className="rounded-md border border-hui-border bg-white p-3 text-left text-hui-textMain shadow-xl"
        >
            {!pointerEventsNone && (
                <button
                    type="button"
                    aria-label="Close"
                    onClick={onClose}
                    className="absolute right-1 top-1 inline-flex h-6 w-6 items-center justify-center rounded text-base leading-none text-slate-400 transition hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hui-primary"
                >
                    ×
                </button>
            )}
            {/* Content must never bring its own width or max-height scroller —
                the FloatingLayer panel is the only scroll owner in this stack. */}
            <div className={pointerEventsNone ? undefined : "pr-6"}>{children}</div>
        </FloatingLayer>
    );
}
