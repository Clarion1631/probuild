"use client";

import { Component, type ReactNode } from "react";

interface Props {
    children: ReactNode;
    fallbackTitle?: string;
}

interface State {
    hasError: boolean;
    error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
    constructor(props: Props) {
        super(props);
        this.state = { hasError: false, error: null };
    }

    static getDerivedStateFromError(error: Error): State {
        return { hasError: true, error };
    }

    render() {
        if (!this.state.hasError) return this.props.children;

        return (
            <div className="flex items-center justify-center min-h-[50vh] p-8">
                <div className="text-center max-w-md">
                    <div className="w-14 h-14 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
                        <svg className="w-7 h-7 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
                        </svg>
                    </div>
                    <h2 className="text-lg font-bold text-hui-textMain mb-2">
                        {this.props.fallbackTitle || "Something went wrong"}
                    </h2>
                    <p className="text-sm text-slate-500 mb-4">
                        An unexpected error occurred. Please try again.
                    </p>
                    {process.env.NODE_ENV === "development" && this.state.error && (
                        <pre className="text-xs text-left bg-red-50 border border-red-200 rounded-lg p-3 mb-4 overflow-auto max-h-40 text-red-700">
                            {this.state.error.message}
                            {this.state.error.stack && `\n\n${this.state.error.stack}`}
                        </pre>
                    )}
                    <button
                        onClick={() => this.setState({ hasError: false, error: null })}
                        className="hui-btn bg-hui-primary text-white hover:bg-blue-600 text-sm px-5 py-2 rounded-lg"
                    >
                        Try again
                    </button>
                </div>
            </div>
        );
    }
}
