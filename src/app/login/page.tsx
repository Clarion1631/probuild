"use client";

import { signIn } from "next-auth/react";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import Image from "next/image";

function LoginForm() {
    const searchParams = useSearchParams();
    const error = searchParams.get('error');

    return (
        <div className="relative min-h-screen flex items-center justify-center overflow-hidden bg-slate-900 w-full">
            {/* Background Image */}
            <div className="absolute inset-0 w-full h-full">
                <Image
                    src="/login-bg.png"
                    alt="Luxury Interior Background"
                    fill
                    className="object-cover opacity-50"
                    priority
                />
            </div>

            {/* Glassmorphism Card */}
            <div className="relative z-10 w-full max-w-md p-8 md:p-12 mx-4 bg-black/40 backdrop-blur-xl border border-white/10 rounded-2xl shadow-2xl flex flex-col items-center justify-center text-center">
                <div className="w-16 h-16 bg-white/10 rounded-2xl flex items-center justify-center mb-6 shadow-inner border border-white/5">
                    <svg className="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" /></svg>
                </div>

                <h1 className="text-3xl font-bold text-white tracking-tight mb-2">ProBuild</h1>
                <p className="text-slate-300 text-sm mb-8">Sign in to your dashboard or client portal.</p>

                {error === 'AccessDenied' && (
                    <div className="mb-6 w-full p-4 bg-red-500/20 border border-red-500/30 rounded-xl">
                        <p className="text-red-200 text-sm font-medium">Access Blocked. Your email is not authorized to access this portal.</p>
                    </div>
                )}

                <button
                    onClick={() => signIn("google", { callbackUrl: "/" })}
                    className="w-full relative flex items-center justify-center gap-3 bg-white text-slate-900 px-6 py-3.5 rounded-xl font-medium shadow-[0_0_40px_rgba(255,255,255,0.15)] hover:shadow-[0_0_60px_rgba(255,255,255,0.3)] hover:-translate-y-0.5 transition-all duration-300 group"
                >
                    <svg className="w-5 h-5 flex-shrink-0" viewBox="0 0 24 24">
                        <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
                        <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
                        <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
                        <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
                    </svg>
                    Continue with Google
                </button>

                <p className="mt-8 text-xs text-white/40 font-medium">
                    Secure login powered by Google
                </p>
            </div>
        </div>
    );
}

export default function LoginPage() {
    return (
        <Suspense fallback={<div className="min-h-screen bg-slate-900 flex flex-col items-center justify-center text-white/50">Loading...</div>}>
            <LoginForm />
        </Suspense>
    );
}
