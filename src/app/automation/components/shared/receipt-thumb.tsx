"use client";

import { useState } from "react";

/** Extensions we render as an image preview — the same lightweight
 * "test the URL string" approach `ReceiptPreview` (validation-panel.tsx)
 * already uses for PDFs, extended to the raster formats receipts arrive as.
 * Anything else (PDF, no extension, a Drive view link) falls to the
 * document tile below. */
const IMAGE_URL_RE = /\.(jpe?g|png|webp|heic)(\?|#|$)/i;

/** Hosts a receipt URL is trusted to come from, beyond this app's own
 * Supabase storage (see `isSupabaseStorageHost` below): Drive/Docs view
 * links and Google's image CDN, the non-Supabase sources a journey's
 * `driveFileId` fallback or a synced Expense's `receiptUrl` can carry. */
const ALLOWED_EXACT_HOSTS = new Set([
    "drive.google.com",
    "docs.google.com",
    "lh3.googleusercontent.com",
    "drive.usercontent.google.com",
]);

/** This app's Supabase Storage host is `SUPABASE_URL` — a server-only env
 * var (not `NEXT_PUBLIC_`-prefixed), so this client component has no way to
 * read the exact configured value at runtime. Falls back to the documented
 * `*.supabase.co` suffix check instead of trusting an arbitrary host. */
function isSupabaseStorageHost(hostname: string): boolean {
    return hostname === "supabase.co" || hostname.endsWith(".supabase.co");
}

/**
 * Codex round 1 finding 9: only render a clickable preview (or an `<img
 * src>`) for a URL we actually trust enough to open/embed — https, and a
 * host either in the explicit allowlist or this app's Supabase storage.
 * Anything else (a malformed URL, a non-https scheme, an unrecognized host)
 * is untrusted: `ReceiptThumb` renders the non-clickable "Unavailable" tile
 * for it instead of a link or an image request.
 */
function isTrustedReceiptUrl(url: string): boolean {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return false;
    }
    if (parsed.protocol !== "https:") return false;
    return ALLOWED_EXACT_HOSTS.has(parsed.hostname) || isSupabaseStorageHost(parsed.hostname);
}

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

/** Non-clickable fallback for a URL `isTrustedReceiptUrl` refused — gray,
 * no href, no image request. */
function UnavailableTile() {
    return (
        <div
            className="inline-flex items-center gap-1.5 border border-hui-border rounded-lg px-2.5 py-2 text-xs font-medium text-hui-textMuted max-w-[180px]"
            title="This receipt link isn't from a trusted source"
        >
            <DocumentIcon />
            <span className="truncate">Unavailable</span>
        </div>
    );
}

/**
 * Small receipt preview for a drill-down: a ~120px-tall thumbnail (rounded,
 * cropped to fill) for an image receipt, or the compact document tile above
 * for a PDF/unknown type — both open the full receipt in a new tab. A URL
 * that isn't from a trusted source (see `isTrustedReceiptUrl`) never becomes
 * a link or an `<img src>` — it renders the non-clickable gray "Unavailable"
 * tile instead. Lazy-loaded and self-healing: a trusted image URL that fails
 * to load (a stale/expired URL, a format the browser can't render) falls
 * back to the document tile rather than showing a broken-image icon.
 *
 * Callers must only render this inside an already-expanded drill-down —
 * never on a collapsed row summary — so a receipt's image request (and any
 * layout it takes up) never fires until the row is actually opened.
 */
export function ReceiptThumb({ url, fileName }: { url: string; fileName?: string | null }) {
    // Keyed by the URL itself (not a plain boolean) so a previous receipt's
    // load failure doesn't stick around and hide a DIFFERENT, never-yet-tried
    // url once the caller swaps which receipt this component is showing.
    const [failedUrl, setFailedUrl] = useState<string | null>(null);
    const label = fileName || "Receipt";

    if (!isTrustedReceiptUrl(url)) {
        return <UnavailableTile />;
    }

    if (!IMAGE_URL_RE.test(url) || failedUrl === url) {
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
                onError={() => setFailedUrl(url)}
                className="h-[120px] w-[120px] object-cover"
            />
        </a>
    );
}
