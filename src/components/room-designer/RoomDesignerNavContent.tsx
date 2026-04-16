"use client";

// Sidebar content shown while editing a single room. Replaces the default
// project-nav (Planning/Management/Finance) or fills the standalone lead
// sidebar. Contains a back link to the room list plus the full AssetPanel
// (search, category tabs, asset grid) so placement happens from the left rail
// rather than a second right-side panel.

import Link from "next/link";
import { AssetPanel } from "./AssetPanel";

interface Props {
    backHref: string;
}

export function RoomDesignerNavContent({ backHref }: Props) {
    return (
        <div className="flex h-full w-full flex-col bg-hui-background">
            <div className="flex items-center border-b border-hui-border px-2 py-2 shrink-0 bg-white">
                <Link
                    href={backHref}
                    className="group flex w-full items-center gap-2 rounded px-2 py-1 text-sm text-slate-600 transition hover:bg-slate-100 hover:text-hui-primary"
                >
                    <svg className="h-4 w-4 transition group-hover:-translate-x-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                    </svg>
                    <span className="font-medium">Back to Rooms</span>
                </Link>
            </div>

            <div className="min-h-0 flex-1">
                <AssetPanel />
            </div>
        </div>
    );
}
