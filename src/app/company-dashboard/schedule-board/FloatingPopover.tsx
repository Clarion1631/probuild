"use client";

import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";

const VIEWPORT_MARGIN_PX = 8;
const ANCHOR_GAP_PX = 4;

export interface FloatingPopoverProps {
    open: boolean;
    anchorRef: RefObject<HTMLElement | null>;
    onClose: () => void;
    children: ReactNode;
    /** Panel width in px — the panel right-aligns to the trigger by default (matching the prior `absolute right-0` menus), then clamps into the viewport. */
    width?: number;
}

/**
 * A portal-rendered dropdown/menu anchored to a trigger element. Fixes the
 * schedule board's popover clipping: rendered to document.body (escapes any
 * clipping/overflow ancestor and any CSS containment from a drag/scroll
 * container), positioned from the trigger's live bounding rect, flipped
 * above the trigger when there isn't room below, and clamped horizontally
 * with an 8px viewport margin. Escape closes and returns focus to the
 * trigger; a pointerdown outside the panel and trigger also closes it.
 */
export function FloatingPopover({ open, anchorRef, onClose, children, width = 224 }: FloatingPopoverProps) {
    const panelRef = useRef<HTMLDivElement | null>(null);
    const [position, setPosition] = useState<{ top: number; left: number; maxHeight: number } | null>(null);

    useLayoutEffect(() => {
        if (!open) {
            setPosition(null);
            return;
        }
        const anchor = anchorRef.current;
        if (!anchor) return;

        function place() {
            const rect = anchor!.getBoundingClientRect();
            const viewportWidth = window.innerWidth;
            const viewportHeight = window.innerHeight;
            const panelWidth = panelRef.current?.offsetWidth ?? width;
            const panelHeight = panelRef.current?.offsetHeight ?? 0;

            // Clamp order matters: the left-edge floor is applied LAST so a
            // viewport narrower than the panel pins to the margin instead of
            // going negative off-screen.
            let left = rect.right - panelWidth;
            left = Math.max(Math.min(left, viewportWidth - panelWidth - VIEWPORT_MARGIN_PX), VIEWPORT_MARGIN_PX);

            const spaceBelow = viewportHeight - rect.bottom - ANCHOR_GAP_PX - VIEWPORT_MARGIN_PX;
            const spaceAbove = rect.top - ANCHOR_GAP_PX - VIEWPORT_MARGIN_PX;
            // Fit below if possible, else above if possible, else whichever
            // side has more room — capped to that room and scrollable inside.
            const fitsBelow = spaceBelow >= panelHeight;
            const fitsAbove = spaceAbove >= panelHeight;
            const openAbove = !fitsBelow && (fitsAbove || spaceAbove > spaceBelow);
            const available = Math.max(openAbove ? spaceAbove : spaceBelow, 120);
            const effectiveHeight = Math.min(panelHeight, available);
            const top = openAbove
                ? Math.max(rect.top - effectiveHeight - ANCHOR_GAP_PX, VIEWPORT_MARGIN_PX)
                : rect.bottom + ANCHOR_GAP_PX;

            setPosition({ top, left, maxHeight: effectiveHeight });
        }
        place();
        window.addEventListener("resize", place);
        window.addEventListener("scroll", place, true);
        return () => {
            window.removeEventListener("resize", place);
            window.removeEventListener("scroll", place, true);
        };
    }, [open, anchorRef, width]);

    useEffect(() => {
        if (!open) return;
        function onKeyDown(event: KeyboardEvent) {
            if (event.key !== "Escape") return;
            event.preventDefault();
            onClose();
            anchorRef.current?.focus();
        }
        function onPointerDownOutside(event: PointerEvent) {
            const target = event.target as Node;
            if (panelRef.current?.contains(target)) return;
            if (anchorRef.current?.contains(target)) return;
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
                visibility: position ? "visible" : "hidden",
            }}
            className="z-[200] space-y-2 rounded-md border border-hui-border bg-white p-3 text-left text-hui-textMain shadow-xl"
            onPointerDown={event => event.stopPropagation()}
        >
            {children}
        </div>,
        document.body,
    );
}
