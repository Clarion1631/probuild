"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Expand-in-place wrapper for one register table row (Unified Money
 * Register plan §3/§5 step 9). The only client-side piece of the
 * drill-down — everything it renders (`summary`, `children`) is built
 * server-side and passed in as already-rendered JSX, so this component owns
 * nothing but the open/closed toggle and the `?focus=<qbTxnId>` deep link
 * (start expanded + scroll into view).
 *
 * Renders as a `<tr>` pair (`colSpan` detail row) rather than nesting
 * interactive elements inside `<td>`s, so it stays valid table markup. The
 * summary row's own links (QuickBooks / Copy ID / Receipt / Project) stop
 * their click from toggling the row via `stopPropagation` at the call site
 * in `page.tsx`.
 */
export function ExpandableRow({
    qbTxnId,
    focusTxnId,
    columnCount,
    summary,
    children,
}: {
    qbTxnId: string | null;
    focusTxnId: string | null;
    columnCount: number;
    summary: ReactNode;
    children: ReactNode;
}) {
    const isFocusTarget = Boolean(qbTxnId && focusTxnId && qbTxnId === focusTxnId);
    const [open, setOpen] = useState(isFocusTarget);
    const rowRef = useRef<HTMLTableRowElement>(null);

    useEffect(() => {
        // `open`'s initial value already accounts for `isFocusTarget` (state
        // initializers only run once, on mount) — the effect's only job is
        // the scroll, an external-system side effect React state can't do
        // on its own. Not calling setOpen here avoids the cascading-render
        // pattern of setting state synchronously inside an effect body.
        if (isFocusTarget) {
            rowRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
        }
    }, [isFocusTarget]);

    return (
        <>
            <tr
                ref={rowRef}
                onClick={() => setOpen((v) => !v)}
                role="button"
                tabIndex={0}
                aria-expanded={open}
                onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setOpen((v) => !v);
                    }
                }}
                className="hover:bg-slate-50 transition cursor-pointer"
            >
                {summary}
            </tr>
            {open && (
                <tr className="bg-slate-50/60">
                    <td colSpan={columnCount} className="px-4 py-4 border-t border-b border-hui-border">
                        {children}
                    </td>
                </tr>
            )}
        </>
    );
}
