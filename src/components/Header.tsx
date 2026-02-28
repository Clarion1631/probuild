"use client";

import { useSession, signIn, signOut } from "next-auth/react";

export default function Header() {
    const { data: session } = useSession();

    return (
        <header className="bg-white border-b border-slate-200 h-16 flex items-center justify-between px-6 shadow-sm">
            <div className="flex items-center">
                <h2 className="text-xl font-semibold text-slate-800">Overview</h2>
            </div>
            <div className="flex items-center gap-4">
                {session ? (
                    <div className="flex items-center gap-4">
                        <span className="text-sm font-medium text-slate-700">
                            {session.user?.name}
                        </span>
                        {session.user?.image && (
                            <img src={session.user.image} alt="User Avatar" className="w-8 h-8 rounded-full border border-slate-300" />
                        )}
                        <button
                            onClick={() => signOut({ callbackUrl: '/login' })}
                            className="text-sm font-medium text-red-600 hover:text-red-700 transition"
                        >
                            Sign out
                        </button>
                    </div>
                ) : (
                    <button
                        onClick={() => signIn("google")}
                        className="text-sm font-medium bg-green-600 text-white px-4 py-2 rounded shadow-sm hover:bg-green-700 transition"
                    >
                        Sign in with Google
                    </button>
                )}
            </div>
        </header>
    );
}
