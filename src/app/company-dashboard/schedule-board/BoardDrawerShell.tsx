"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import { activateExclusiveMenu, deactivateExclusiveMenu } from "./menuCoordinator";

interface BoardDrawerShellProps {
    open: boolean;
    ariaLabel: string;
    onClose: () => void;
    children: ReactNode;
}

export function BoardDrawerShell({ open, ariaLabel, onClose, children }: BoardDrawerShellProps) {
    const drawerRef = useRef<HTMLElement | null>(null);

    useEffect(() => {
        if (!open) return;
        const close = () => onClose();
        activateExclusiveMenu(close);
        return () => deactivateExclusiveMenu(close);
    }, [open, onClose]);

    useEffect(() => {
        if (!open) return;
        function onKeyDown(event: KeyboardEvent) {
            if (event.key === "Escape") {
                event.preventDefault();
                onClose();
            }
        }
        function onPointerDown(event: PointerEvent) {
            // Let right-click reach a board item's context-menu path; its
            // exclusive registration closes this drawer in the same turn.
            if (event.button !== 0) return;
            const target = event.target;
            if (!(target instanceof Node) || drawerRef.current?.contains(target)) return;
            const activeElement = document.activeElement;
            if (activeElement instanceof HTMLElement && drawerRef.current?.contains(activeElement)) {
                activeElement.blur();
            }
            event.preventDefault();
            event.stopPropagation();
            window.setTimeout(onClose, 0);
        }
        document.addEventListener("keydown", onKeyDown);
        document.addEventListener("pointerdown", onPointerDown, true);
        return () => {
            document.removeEventListener("keydown", onKeyDown);
            document.removeEventListener("pointerdown", onPointerDown, true);
        };
    }, [open, onClose]);

    if (!open || typeof document === "undefined") return null;

    return createPortal(
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.16 }}
            className="pointer-events-none fixed inset-0 z-[180] bg-slate-950/15"
            aria-hidden={false}
        >
            <motion.aside
                ref={drawerRef}
                initial={{ x: 20, opacity: 0 }}
                animate={{ x: 0, opacity: 1 }}
                transition={{ duration: 0.18, ease: "easeOut" }}
                role="dialog"
                aria-modal="false"
                aria-label={ariaLabel}
                className="pointer-events-auto fixed inset-y-0 right-0 w-[min(420px,calc(100vw-1rem))] bg-white shadow-[-18px_0_45px_rgba(15,23,42,0.22)]"
            >
                {children}
            </motion.aside>
        </motion.div>,
        document.body,
    );
}
