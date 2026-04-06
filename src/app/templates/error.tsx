"use client";

import { useEffect } from "react";

export default function TemplatesError({
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
        <div className="flex items-center justify-center p-12">
            <div className="text-center max-w-md">
                <h2 className="text-xl font-semibold text-slate-800 mb-2">Something went wrong</h2>
                <p className="text-slate-500 text-sm mb-6">
                    Could not load templates. Please try again.
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
