"use client";

import type { ReactNode } from "react";

/**
 * Thin client boundary around the register table's Links cell. Its only job
 * is `stopPropagation` so clicking a link/button inside it doesn't also
 * toggle the row's drill-down (`ExpandableRow`'s `<tr onClick>`). Server
 * Components can't attach event handlers directly — `page.tsx` builds the
 * links themselves (including the already-client `CopyIdButton`) and passes
 * them in as `children`, same "server-rendered children into a client
 * component" pattern `ExpandableRow` uses for the rest of the row.
 */
export function LinksCell({ children }: { children: ReactNode }) {
    return (
        <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
            {children}
        </td>
    );
}
