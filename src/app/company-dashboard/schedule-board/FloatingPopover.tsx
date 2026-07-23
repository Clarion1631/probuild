"use client";

import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";

const VIEWPORT_MARGIN_PX = 8;
const ANCHOR_GAP_PX = 4;

export interface FloatingPopoverAnchorPoint {
    x: number;
    y: number;
}

export interface FloatingPopoverProps {
    open: boolean;
    /** Anchor to a trigger element's live bounding rect — the panel right-aligns to it. Ignored when `anchorPoint` is also given. */
    anchorRef?: RefObject<HTMLElement | null>;
    /** Anchor to an explicit viewport point (e.g. a `contextmenu` event's clientX/clientY) instead of an element — the panel's top-left opens at the point, like a native context menu. Takes precedence over `anchorRef` when both are given. */
    anchorPoint?: FloatingPopoverAnchorPoint | null;
    onClose: () => void;
    children: ReactNode;
    /** Panel width in px — the panel right-aligns to the trigger by default (matching the prior `absolute right-0` menus), then clamps into the viewport. */
    width?: number;
    /** Non-interactive hover card mode (schedule-board task hover notes): the panel never captures pointer events, so it can never trap the mouse mid-hover. Default false (normal click/context menu). */
    pointerEventsNone?: boolean;
}

/**
 * A portal-rendered dropdown/menu anchored to a trigger element OR an
 * explicit point (right-click / ContextMenu-key position). Fixes the
 * schedule board's popover clipping: rendered to document.body (escapes any
 * clipping/overflow ancestor and any CSS containment from a drag/scroll
 * container), positioned from the trigger's live bounding rect (or the given
 * point), flipped above the trigger when there isn't room below, and clamped
 * horizontally with an 8px viewport margin. Escape closes and returns focus
 * to the trigger; a pointerdown outside the panel and trigger also closes it.
 */
export function FloatingPopover({ open, anchorRef, anchorPoint, onClose, children, width = 224, pointerEventsNone = false }: FloatingPopoverProps) {
    const panelRef = useRef<HTMLDivElement | null>(null);
    const [position, setPosition] = useState<{ top: number; left: number; maxHeight: number } | null>(null);

    useLayoutEffect(() => {
        if (!open) {
            setPosition(null);
            return;
        }
        const anchor = anchorRef?.current ?? null;
        if (!anchorPoint && !anchor) return;

        function place() {
            const rect = anchorPoint
                ? { left: anchorPoint.x, right: anchorPoint.x, top: anchorPoint.y, bottom: anchorPoint.y }
                : anchor!.getBoundingClientRect();
            const viewportWidth = window.innerWidth;
            const viewportHeight = window.innerHeight;
            const panelWidth = panelRef.current?.offsetWidth ?? width;
            const panelHeight = panelRef.current?.offsetHeight ?? 0;

            // Clamp order matters: the left-edge floor is applied LAST so a
            // viewport narrower than the panel pins to the margin instead of
            // going negative off-screen. A point anchor opens its LEFT edge at
            // the point (native context-menu convention) instead of
            // right-aligning to it.
            let left = anchorPoint ? rect.left : rect.right - panelWidth;
            left = Math.max(Math.min(left, viewportWidth - panelWidth - VIEWPORT_MARGIN_PX), VIEWPORT_MARGIN_PX);

            const spaceBelow = viewportHeight - rect.bottom - ANCHOR_GAP_PX - VIEWPORT_MARGIN_PX;
            const spaceAbove = rect.top - ANCHOR_GAP_PX - VIEWPORT_MARGIN_PX;
            // Fit below if possible, else above if possible, else whichever
            // side has more room — capped to that room and scrollable inside.
            const fitsBelow = spaceBelow >= panelHeight;
            const fitsAbove = spaceAbove >= panelHeight;
            const openAbove = !fitsBelow && (fitsAbove || spaceAbove > spaceBelow);
            const available = Math.max(openAbove ? spaceAbove : spaceBelow, 0);
            let top: number;
            let effectiveHeight: number;
            if (available >= 40) {
                // Anchor-attached: capped to the chosen side's real room (no
                // artificial floor — a floor larger than the room overflows).
                effectiveHeight = Math.min(panelHeight, available);
                top = openAbove
                    ? Math.max(rect.top - effectiveHeight - ANCHOR_GAP_PX, VIEWPORT_MARGIN_PX)
                    : rect.bottom + ANCHOR_GAP_PX;
            } else {
                // Degenerate viewport (anchor pinned to an edge, no room either
                // side): detach from the anchor and use the full viewport.
                effectiveHeight = Math.min(panelHeight, viewportHeight - 2 * VIEWPORT_MARGIN_PX);
                top = VIEWPORT_MARGIN_PX;
            }

            setPosition({ top, left, maxHeight: effectiveHeight });
        }
        place();
        window.addEventListener("resize", place);
        window.addEventListener("scroll", place, true);
        return () => {
            window.removeEventListener("resize", place);
            window.removeEventListener("scroll", place, true);
        };
    }, [open, anchorRef, anchorPoint, width]);

    useEffect(() => {
        if (!open) return;
        function onKeyDown(event: KeyboardEvent) {
            if (event.key !== "Escape") return;
            event.preventDefault();
            onClose();
            anchorRef?.current?.focus();
        }
        function onPointerDownOutside(event: PointerEvent) {
            const target = event.target as Node;
            if (panelRef.current?.contains(target)) return;
            if (anchorRef?.current?.contains(target)) return;
            onClose();
        }
        window.addEventListener("keydown", onKeyDown);
        window.addEventListener("pointerdown", onPointerDownOutside, true);
        return () => {
            window.removeEventListener("keydown", onKeyDown);
            window.removeEventListener("pointerdown", onPointerDownOutside, true);
        };
    }, [open, onClose, anchorRef]);

    if (!open || typeof document === "undefined") return null;

    return createPortal(
        <div
            ref={panelRef}
            style={{
                position: "fixed",
                top: position?.top ?? -9999,
                left: position?.left ?? -9999,
                maxHeight: position?.maxHeight,
                overflowY: "auto",
                width,
                // Crew-picker rebuild (item 5): FloatingPopover is now the ONLY
                // scroll owner any schedule-board menu ever nests — content
                // (e.g. CrewChecklist) must never bring its own w-*/max-h-*
                // scroller, and a viewport narrower than `width` must clip
                // horizontally rather than overflow the screen.
                maxWidth: `calc(100vw - ${2 * VIEWPORT_MARGIN_PX}px)`,
                boxSizing: "border-box",
                overflowX: "hidden",
                overscrollBehaviorY: "contain",
                visibility: position ? "visible" : "hidden",
            }}
            className={`z-[200] space-y-2 rounded-md border border-hui-border bg-white p-3 text-left text-hui-textMain shadow-xl ${pointerEventsNone ? "pointer-events-none" : ""}`}
            onPointerDown={pointerEventsNone ? undefined : event => event.stopPropagation()}
        >
            {children}
        </div>,
        document.body,
    );
}
