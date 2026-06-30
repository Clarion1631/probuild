"use client";

import { useSession, signIn, signOut } from "next-auth/react";
import { Menu } from "lucide-react";
import { useNavDrawer } from "@/components/nav/navDrawerStore";

export default function Header() {
    const { data: session } = useSession();
    const toggleNav = useNavDrawer((s) => s.toggle);

    return (
        <header className="bg-white border-b border-hui-border min-h-16 flex items-center justify-between pl-[max(1.5rem,env(safe-area-inset-left))] pr-[max(1.5rem,env(safe-area-inset-right))] pt-[env(safe-area-inset-top)] shadow-sm">
            <div className="flex items-center gap-2">
                {/* Hamburger — opens the mobile nav drawer; hidden on desktop where the rail is shown. */}
                <button
                    onClick={toggleNav}
                    aria-label="Open navigation"
                    className="lg:hidden -ml-2 inline-flex items-center justify-center min-h-11 min-w-11 rounded-md text-slate-600 hover:bg-slate-100 transition"
                >
                    <Menu className="w-6 h-6" />
                </button>
                <h2 className="text-xl font-semibold text-hui-textMain">Golden Touch</h2>
            </div>
            <div className="flex items-center gap-4">
                {session ? (
                    <div className="flex items-center gap-4">
                        <span className="text-sm font-medium text-slate-700">
                            {session.user?.name}
                        </span>
                        {session.user?.image && (
                            <img src={session.user.image} alt="User Avatar" className="w-8 h-8 rounded-full border border-hui-border" />
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
                        className="hui-btn hui-btn-green"
                    >
                        Sign in with Google
                    </button>
                )}
            </div>
        </header>
    );
}
