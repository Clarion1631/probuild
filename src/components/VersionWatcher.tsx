"use client";

import { useEffect, useRef, useState } from "react";

const CHECK_INTERVAL_MS = 4 * 60 * 1000;

/**
 * Stale-tab detector. Remembers which deployment served this page, re-checks
 * /api/version whenever the tab regains focus (the moment day-old tabs bite)
 * plus every few minutes, and shows a refresh banner once production has moved
 * to a newer build. Self-contained — no toast library dependency, so it works
 * on every layout including the client portal.
 */
export default function VersionWatcher() {
    const [stale, setStale] = useState(false);
    const [dismissed, setDismissed] = useState(false);
    const baseline = useRef<string | null>(null);

    useEffect(() => {
        let cancelled = false;

        async function check() {
            try {
                const res = await fetch("/api/version", { cache: "no-store" });
                if (!res.ok || cancelled) return;
                const data = await res.json();
                const v = typeof data?.v === "string" ? data.v : null;
                if (!v || v === "dev") return;
                if (baseline.current === null) {
                    baseline.current = v;
                } else if (v !== baseline.current) {
                    setStale(true);
                }
            } catch {
                // Offline or transient error — never bother the user about it.
            }
        }

        check();
        const timer = setInterval(check, CHECK_INTERVAL_MS);
        const onFocus = () => check();
        const onVisibility = () => {
            if (document.visibilityState === "visible") check();
        };
        window.addEventListener("focus", onFocus);
        document.addEventListener("visibilitychange", onVisibility);
        return () => {
            cancelled = true;
            clearInterval(timer);
            window.removeEventListener("focus", onFocus);
            document.removeEventListener("visibilitychange", onVisibility);
        };
    }, []);

    if (!stale || dismissed) return null;

    return (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[200] flex items-center gap-3 bg-slate-900 text-white pl-4 pr-2 py-2 rounded-full shadow-xl shadow-slate-900/20 text-sm animate-in fade-in slide-in-from-bottom-2">
            <span className="font-medium">ProBuild has been updated</span>
            <button
                onClick={() => window.location.reload()}
                className="bg-white text-slate-900 font-semibold text-xs px-3 py-1.5 rounded-full hover:bg-slate-100 transition"
            >
                Refresh
            </button>
            <button
                onClick={() => setDismissed(true)}
                aria-label="Dismiss"
                className="text-slate-400 hover:text-white transition px-1"
            >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
            </button>
        </div>
    );
}
