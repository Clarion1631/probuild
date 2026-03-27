"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

function LoginForm() {
    const [email, setEmail] = useState("");
    const [sent, setSent] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const params = useSearchParams();

    const errorParam = params.get("error");
    const errorMessages: Record<string, string> = {
        missing_token: "No login token provided. Please request a new link.",
        invalid_token: "Invalid login token. Please request a new link.",
        expired_token: "Your login link has expired. Please request a new one.",
    };

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        setLoading(true);
        setError("");
        try {
            const res = await fetch("/api/sub-portal/login", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ email: email.trim().toLowerCase() }),
            });
            if (!res.ok) throw new Error("Failed to send login link");
            setSent(true);
        } catch {
            setError("Something went wrong. Please try again.");
        } finally {
            setLoading(false);
        }
    }

    if (sent) {
        return (
            <div className="min-h-screen bg-hui-background flex items-center justify-center p-4">
                <div className="w-full max-w-md">
                    <div className="bg-white rounded-2xl shadow-lg border border-hui-border p-8 text-center">
                        <div className="w-16 h-16 bg-emerald-50 rounded-full flex items-center justify-center mx-auto mb-6">
                            <svg className="w-8 h-8 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                            </svg>
                        </div>
                        <h1 className="text-2xl font-bold text-hui-textMain mb-3">Check your email</h1>
                        <p className="text-hui-textMuted mb-6">
                            If an account exists for <strong className="text-hui-textMain">{email}</strong>,
                            we&apos;ve sent a login link that&apos;s valid for 24 hours.
                        </p>
                        <button onClick={() => setSent(false)} className="text-sm text-hui-primary hover:underline font-medium">
                            Try a different email
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-hui-background flex items-center justify-center p-4">
            <div className="w-full max-w-md">
                <div className="bg-white rounded-2xl shadow-lg border border-hui-border p-8">
                    <div className="text-center mb-8">
                        <div className="w-14 h-14 bg-hui-primary rounded-xl flex items-center justify-center mx-auto mb-4 shadow-md">
                            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#ffffff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M2 20a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8l-7 5V8l-7 5V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/>
                            </svg>
                        </div>
                        <h1 className="text-2xl font-bold text-hui-textMain tracking-tight">Subcontractor Portal</h1>
                        <p className="text-hui-textMuted text-sm mt-2">Enter your email to receive a login link</p>
                    </div>

                    {(errorParam || error) && (
                        <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-6 text-sm text-red-700">
                            {error || errorMessages[errorParam!] || "An error occurred."}
                        </div>
                    )}

                    <form onSubmit={handleSubmit} className="space-y-5">
                        <div>
                            <label className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider mb-1.5 block">Email Address</label>
                            <input
                                type="email"
                                required
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                placeholder="your@email.com"
                                className="hui-input w-full"
                            />
                        </div>
                        <button
                            type="submit"
                            disabled={loading}
                            className="hui-btn hui-btn-green w-full py-3 text-sm font-semibold disabled:opacity-50"
                        >
                            {loading ? (
                                <span className="flex items-center justify-center gap-2">
                                    <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                                    </svg>
                                    Sending...
                                </span>
                            ) : "Send Login Link"}
                        </button>
                    </form>
                </div>
                <p className="text-center text-xs text-hui-textMuted mt-6">
                    Only registered subcontractors can access this portal.<br />
                    Contact your project manager for access.
                </p>
            </div>
        </div>
    );
}

export default function SubPortalLoginPage() {
    return (
        <Suspense fallback={<div className="min-h-screen bg-hui-background flex items-center justify-center"><p className="text-hui-textMuted">Loading...</p></div>}>
            <LoginForm />
        </Suspense>
    );
}
