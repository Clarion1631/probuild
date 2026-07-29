"use client";

import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";

export const FLOATING_VIEWPORT_MARGIN_PX = 8;
export const FLOATING_ANCHOR_GAP_PX = 4;

export interface FloatingAnchorPoint {
    x: number;
    y: number;
}

export interface FloatingLayerProps {
    open: boolean;
    /** Anchor to a trigger element's live bounding rect. Ignored when `anchorPoint` is also given. */
    anchorRef?: RefObject<HTMLElement | null>;
    /** Anchor to an explicit viewport point (e.g. a `contextmenu` event's clientX/clientY). Takes precedence over `anchorRef`. */
    anchorPoint?: FloatingAnchorPoint | null;
    onClose: () => void;
    children: ReactNode;
    /** Which panel edge lines up with the anchor. Default "right" (matches the `absolute right-0` menus this replaced). A point anchor always opens its left edge at the point. */
    align?: "left" | "right";
    /** Fixed panel width in px. Omit to size to content — the panel still clamps into the viewport. */
    width?: number;
    /** Cap the panel to the room available on its side and scroll inside. Default true. */
    constrainHeight?: boolean;
    /** Non-interactive hover-card mode: the panel never captures pointer events, so it can't trap the mouse mid-hover. */
    pointerEventsNone?: boolean;
    /**
     * Close on a pointerdown outside the panel and anchor. Default true.
     *
     * Set false when this panel hosts another FloatingLayer: the nested panel
     * is a sibling portal on document.body, so a pointerdown inside it reads as
     * "outside" here and would dismiss the parent out from under it.
     */
    dismissOnOutsidePointerDown?: boolean;
    /** Classes for the positioned wrapper. Children supply their own chrome (border, background, padding). */
    className?: string;
    /** Stacking order within the portal root. Default 200. */
    zIndex?: number;
}

/**
 * Headless portal-positioned layer: renders `children` to document.body,
 * anchored to a trigger element or an explicit point.
 *
 * This exists because a popover nested in the page can be hidden two different
 * ways, and only portalling fixes both:
 *   1. Painted under — an ancestor with its own z-index caps the popover's
 *      z-index to the ancestor's rank, so a later equal-z sibling covers it.
 *   2. Clipped — an ancestor with `overflow: hidden/auto` cuts the popover off
 *      at its edge, which no z-index change can fix.
 *
 * Positioning: measured from the anchor's live rect, flipped above when there
 * isn't room below, clamped into the viewport with an 8px margin, and (by
 * default) capped to the room on its side with internal scroll. Escape closes
 * and returns focus to the anchor; a pointerdown outside the panel and anchor
 * also closes.
 *
 * Chrome is deliberately NOT included — callers keep their own panel styling.
 * `FloatingPopover` (schedule board) wraps this with its own chrome.
 */
export function FloatingLayer({
    open,
    anchorRef,
    anchorPoint,
    onClose,
    children,
    align = "right",
    width,
    constrainHeight = true,
    pointerEventsNone = false,
    dismissOnOutsidePointerDown = true,
    className,
    zIndex = 200,
}: FloatingLayerProps) {
    const panelRef = useRef<HTMLDivElement | null>(null);
    const contentRef = useRef<HTMLDivElement | null>(null);
    const [position, setPosition] = useState<{ top: number; left: number; maxHeight?: number } | null>(null);

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
            const panelWidth = panelRef.current?.offsetWidth ?? width ?? 0;
            // scrollHeight, not offsetHeight: once a maxHeight is applied the box
            // stops growing, so a panel switching to taller content would keep
            // measuring the SHORT view and never re-place.
            const panelHeight = Math.max(panelRef.current?.scrollHeight ?? 0, panelRef.current?.offsetHeight ?? 0);

            // Clamp order matters: the left-edge floor is applied LAST so a
            // viewport narrower than the panel pins to the margin instead of
            // going negative off-screen.
            let left = anchorPoint
                ? rect.left
                : align === "left"
                    ? rect.left
                    : rect.right - panelWidth;
            left = Math.max(
                Math.min(left, viewportWidth - panelWidth - FLOATING_VIEWPORT_MARGIN_PX),
                FLOATING_VIEWPORT_MARGIN_PX,
            );

            const spaceBelow = viewportHeight - rect.bottom - FLOATING_ANCHOR_GAP_PX - FLOATING_VIEWPORT_MARGIN_PX;
            const spaceAbove = rect.top - FLOATING_ANCHOR_GAP_PX - FLOATING_VIEWPORT_MARGIN_PX;
            // Fit below if possible, else above if possible, else whichever side
            // has more room — capped to that room and scrollable inside.
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
                    ? Math.max(rect.top - effectiveHeight - FLOATING_ANCHOR_GAP_PX, FLOATING_VIEWPORT_MARGIN_PX)
                    : rect.bottom + FLOATING_ANCHOR_GAP_PX;
            } else {
                // Degenerate viewport (anchor pinned to an edge, no room either
                // side): detach from the anchor and use the full viewport.
                effectiveHeight = Math.min(panelHeight, viewportHeight - 2 * FLOATING_VIEWPORT_MARGIN_PX);
                top = FLOATING_VIEWPORT_MARGIN_PX;
            }

            setPosition({ top, left, maxHeight: constrainHeight ? effectiveHeight : undefined });
        }
        place();
        window.addEventListener("resize", place);
        window.addEventListener("scroll", place, true);
        // Re-measure when the PANEL's content changes size. Observe the CONTENT
        // wrapper, not the panel: a maxHeight-capped panel box never changes
        // size when its content grows, so panel observation misses the switch.
        const observed = contentRef.current ?? panelRef.current;
        const panelObserver = typeof ResizeObserver !== "undefined" && observed
            ? new ResizeObserver(() => place())
            : null;
        if (panelObserver && observed) panelObserver.observe(observed);
        return () => {
            window.removeEventListener("resize", place);
            window.removeEventListener("scroll", place, true);
            panelObserver?.disconnect();
        };
    }, [open, anchorRef, anchorPoint, align, width, constrainHeight]);

    useEffect(() => {
        if (!open) return;
        function onKeyDown(event: KeyboardEvent) {
            if (event.key !== "Escape") return;
            event.preventDefault();
            onClose();
            // Hover cards open on focus — restoring focus to the anchor would
            // immediately reopen the card Escape just dismissed.
            if (!pointerEventsNone) anchorRef?.current?.focus();
        }
        function onPointerDownOutside(event: PointerEvent) {
            const target = event.target as Node;
            if (panelRef.current?.contains(target)) return;
            if (anchorRef?.current?.contains(target)) return;
            onClose();
        }
        window.addEventListener("keydown", onKeyDown);
        if (dismissOnOutsidePointerDown) window.addEventListener("pointerdown", onPointerDownOutside, true);
        return () => {
            window.removeEventListener("keydown", onKeyDown);
            window.removeEventListener("pointerdown", onPointerDownOutside, true);
        };
    }, [open, onClose, anchorRef, pointerEventsNone, dismissOnOutsidePointerDown]);

    if (!open || typeof document === "undefined") return null;

    return createPortal(
        <div
            ref={panelRef}
            style={{
                position: "fixed",
                top: position?.top ?? -9999,
                left: position?.left ?? -9999,
                maxHeight: position?.maxHeight,
                overflowY: constrainHeight ? "auto" : undefined,
                width,
                maxWidth: `calc(100vw - ${2 * FLOATING_VIEWPORT_MARGIN_PX}px)`,
                boxSizing: "border-box",
                overflowX: "hidden",
                overscrollBehaviorY: "contain",
                zIndex,
                // Hidden until measured so the panel never flashes at -9999.
                visibility: position ? "visible" : "hidden",
            }}
            className={`${pointerEventsNone ? "pointer-events-none " : ""}${className ?? ""}`}
            onPointerDown={pointerEventsNone ? undefined : event => event.stopPropagation()}
        >
            <div ref={contentRef}>{children}</div>
        </div>,
        document.body,
    );
}
