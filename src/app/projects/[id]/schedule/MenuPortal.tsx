"use client";

import { type ReactNode } from "react";
import { createPortal } from "react-dom";

/* Renders a toolbar popover on document.body.

   The schedule toolbar lives in a `relative z-20` header, which is its own
   stacking context — so a `z-50` menu nested inside it still paints at the
   header's level, and the equally-ranked `z-20` filter row that follows in the
   DOM covers it. Portalling to the body escapes that context; the menus already
   position themselves with viewport coordinates, so nothing else changes. */
export default function MenuPortal({ children }: { children: ReactNode }) {
    if (typeof document === "undefined") return null;
    return createPortal(children, document.body);
}
