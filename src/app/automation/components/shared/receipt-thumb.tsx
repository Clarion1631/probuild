"use client";

import { useState } from "react";

/** Extensions we render as an image preview — the same lightweight
 * "test the URL string" approach `ReceiptPreview` (validation-panel.tsx)
 * already uses for PDFs, extended to the raster formats receipts arrive as.
 * Anything else (PDF, no extension, a Drive view link) falls to the
 * document tile below. */
const IMAGE_URL_RE = /\.(jpe?g|png|webp|heic)(\?|#|$)/i;

function DocumentIcon() {
    return (
        <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l4.414 4.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
            />
        </svg>
    );
}

/** Compact fallback tile for a PDF/unknown-type receipt, or an image whose
 * preview failed to load — opens the receipt in a new tab, same destination
 * as the image thumbnail below. */
function DocumentTile({ url, label }: { url: string; label: string }) {
    return (
        <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            title="Open receipt ↗"
            className="inline-flex items-center gap-1.5 border border-hui-border rounded-lg px-2.5 py-2 text-xs font-medium text-hui-textMain hover:bg-slate-50 transition max-w-[180px]"
        >
            <DocumentIcon />
            <span className="truncate">{label}</span>
        </a>
    );
}

/**
 * Small receipt preview for a drill-down: a ~120px-tall thumbnail (rounded,
 * cropped to fill) for an image receipt, or the compact document tile above
 * for a PDF/unknown type — both open the full receipt in a new tab.
 * Lazy-loaded and self-healing: an image that fails to load (a stale/expired
 * URL, a format the browser can't render) falls back to the same document
 * tile rather than showing a broken-image icon.
 *
 * Callers must only render this inside an already-expanded drill-down —
 * never on a collapsed row summary — so a receipt's image request (and any
 * layout it takes up) never fires until the row is actually opened.
 */
export function ReceiptThumb({ url, fileName }: { url: string; fileName?: string | null }) {
    const [imageFailed, setImageFailed] = useState(false);
    const label = fileName || "Receipt";

    if (!IMAGE_URL_RE.test(url) || imageFailed) {
        return <DocumentTile url={url} label={label} />;
    }

    return (
        <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            title="Open receipt ↗"
            className="inline-block rounded-lg overflow-hidden border border-hui-border hover:opacity-90 transition"
        >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
                src={url}
                alt={label}
                loading="lazy"
                onError={() => setImageFailed(true)}
                className="h-[120px] w-[120px] object-cover"
            />
        </a>
    );
}
