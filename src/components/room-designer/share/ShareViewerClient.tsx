"use client";

// Client entry for the public /share/room/[token] page. Wraps <ShareViewer />
// in next/dynamic (ssr:false) so Three.js never touches the Node server, and
// in an error boundary so any WebGL / HDR / model-load crash falls back to
// a mailto CTA instead of a blank page.

import dynamic from "next/dynamic";
import React from "react";
import type { ShareViewerData } from "./ShareViewer";

const ShareViewer = dynamic(
    () => import("./ShareViewer").then((m) => m.ShareViewer),
    {
        ssr: false,
        loading: () => <ShareLoading />,
    },
);

export default function ShareViewerClient({ data }: { data: ShareViewerData }) {
    return (
        <ShareErrorBoundary contractorName={data.contractor.name} roomName={data.roomName}>
            <ShareViewer data={data} />
        </ShareErrorBoundary>
    );
}

function ShareLoading() {
    return (
        <div className="flex h-dvh w-full items-center justify-center bg-slate-50 text-slate-500">
            Loading 3D view…
        </div>
    );
}

interface ErrorBoundaryState {
    error: Error | null;
}

class ShareErrorBoundary extends React.Component<
    { children: React.ReactNode; contractorName: string; roomName: string },
    ErrorBoundaryState
> {
    state: ErrorBoundaryState = { error: null };

    static getDerivedStateFromError(error: Error): ErrorBoundaryState {
        return { error };
    }

    componentDidCatch(error: Error) {
        // eslint-disable-next-line no-console
        console.error("ShareViewer crashed:", error);
    }

    render() {
        if (!this.state.error) return this.props.children;
        return (
            <div className="flex h-dvh w-full items-center justify-center bg-slate-50 p-6">
                <div className="hui-card max-w-md bg-white p-6 text-center shadow-lg">
                    <h2 className="mb-2 text-base font-semibold text-slate-900">
                        We can&apos;t load this 3D view right now
                    </h2>
                    <p className="mb-4 text-sm text-slate-500">
                        Your browser or device may not support WebGL. Please contact{" "}
                        <span className="font-medium text-slate-800">{this.props.contractorName}</span>{" "}
                        and mention you were trying to view &ldquo;{this.props.roomName}&rdquo;.
                    </p>
                </div>
            </div>
        );
    }
}
