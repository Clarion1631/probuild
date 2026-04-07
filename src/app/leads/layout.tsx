"use client";

import ErrorBoundary from "@/components/ErrorBoundary";

export default function LeadsLayout({ children }: { children: React.ReactNode }) {
    return (
        <ErrorBoundary fallbackTitle="Leads error">
            {children}
        </ErrorBoundary>
    );
}
