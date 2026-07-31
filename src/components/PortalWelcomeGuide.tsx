"use client";

import { useState } from "react";

/**
 * "How your portal works" guide for the client portal overview tab — a slim
 * row near the top, collapsed by default; clients expand it when they want
 * the walkthrough. Items are driven by the project's portal visibility flags
 * so the guide never advertises a section the client can't see.
 */
export default function PortalWelcomeGuide({
    projectId,
    companyName,
    features,
}: {
    projectId: string;
    companyName: string;
    features: {
        schedule: boolean;
        updates: boolean;
        estimates: boolean;
        invoices: boolean;
        selections: boolean;
        files: boolean;
    };
}) {
    const [open, setOpen] = useState(false);
    const contentId = `portal-guide-${projectId}`;

    const items: Array<{ icon: React.ReactNode; title: string; text: string }> = [];

    if (features.schedule) {
        items.push({
            icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />,
            title: "Follow the schedule",
            text: "See what's happening now and what comes next as your project moves along.",
        });
    }
    if (features.updates) {
        items.push({
            icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9zM15 13a3 3 0 11-6 0 3 3 0 016 0z" />,
            title: "Photos and updates",
            text: "The crew posts progress photos and notes so you can watch the work happen.",
        });
    }
    if (features.estimates) {
        items.push({
            icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />,
            title: "Review and approve",
            text: "Estimates and change orders come to you here for review and online signature.",
        });
    }
    if (features.invoices) {
        items.push({
            icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />,
            title: "Pay online",
            text: "When a payment is requested, you'll get an email with a secure Pay Now link for card or bank transfer. Only requested amounts are ever due.",
        });
    }
    if (features.selections) {
        items.push({
            icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485" />,
            title: "Make selections",
            text: "Choose products and finishes, and leave comments on the options we've lined up.",
        });
    }
    if (features.files) {
        items.push({
            icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />,
            title: "Your documents",
            text: "Plans, contracts, and shared files are always here when you need them.",
        });
    }

    return (
        <div className="hui-card border-emerald-200 bg-gradient-to-br from-emerald-50/60 to-white">
            <button
                onClick={() => setOpen((value) => !value)}
                aria-expanded={open}
                aria-controls={contentId}
                className="w-full flex items-center gap-3 p-4 text-left"
            >
                <span className="shrink-0 w-8 h-8 rounded-md bg-emerald-100 text-emerald-700 flex items-center justify-center">
                    <svg className="w-4.5 h-4.5" width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                </span>
                <span className="min-w-0 flex-1">
                    <span className="block text-sm font-bold text-hui-textMain">How your portal works</span>
                    <span className="block text-xs text-hui-textMuted">A quick walkthrough of what you can do here.</span>
                </span>
                <svg
                    className={`shrink-0 w-4 h-4 text-hui-textMuted transition-transform ${open ? "rotate-180" : ""}`}
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
            </button>
            {open && (
                <div id={contentId} className="px-4 pb-5 md:px-5">
                    <p className="text-sm text-hui-textMuted mb-4">
                        {companyName} keeps everything about your project in one place. Here&apos;s what you can do:
                    </p>
                    <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
                        {items.map(item => (
                            <div key={item.title} className="flex gap-3 bg-white rounded-lg border border-slate-200 p-3.5">
                                <div className="shrink-0 w-8 h-8 rounded-md bg-emerald-100 text-emerald-700 flex items-center justify-center">
                                    <svg className="w-4.5 h-4.5" width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24">{item.icon}</svg>
                                </div>
                                <div className="min-w-0">
                                    <p className="text-sm font-semibold text-hui-textMain">{item.title}</p>
                                    <p className="text-xs text-hui-textMuted mt-0.5 leading-relaxed">{item.text}</p>
                                </div>
                            </div>
                        ))}
                    </div>
                    <p className="text-xs text-hui-textMuted mt-4">
                        Your email link signs you in automatically, so there is no password to remember. Bookmark this page, and if you ever need a fresh link just ask us.
                    </p>
                </div>
            )}
        </div>
    );
}
