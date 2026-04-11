"use client";

import { useEffect } from "react";

export default function GlobalError({
    error,
    reset,
}: {
    error: Error & { digest?: string };
    reset: () => void;
}) {
    useEffect(() => {
        console.error(error);
    }, [error]);

    return (
        <div className="min-h-screen flex items-center justify-center bg-slate-50">
            <div className="text-center max-w-md px-6">
                <div className="text-4xl mb-4">⚠️</div>
                <h2 className="text-xl font-semibold text-slate-800 mb-2">Something went wrong</h2>
                <p className="text-slate-500 text-sm mb-6">
                    An unexpected error occurred. Please try again, or contact support if the problem persists.
                </p>
                <button
                    onClick={reset}
                    className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 transition"
                >
                    Try again
                </button>
            </div>
        </div>
    );
}
