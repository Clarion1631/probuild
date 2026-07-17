"use client";

import Link from "next/link";
import { useState } from "react";
import { usePermissions } from "@/components/PermissionsProvider";
import FieldUpdatesNavItem from "@/components/FieldUpdatesNavItem";
import { NAV_ITEMS, SearchIcon } from "@/components/nav/navItems";
import SearchPanel from "@/components/nav/SearchPanel";

export default function Sidebar({ logoUrl }: { logoUrl?: string }) {
    const [isSearchOpen, setIsSearchOpen] = useState(false);
    const { permissions, loaded } = usePermissions();

    const can = (key: string) => !!permissions[key];
    const projects = NAV_ITEMS.find((i) => i.key === "projects")!;

    return (
        // Desktop / iPad-landscape icon rail. Hidden below lg — the mobile drawer
        // (MobileNavDrawer) takes over there. Keeping this rail untouched at >= lg
        // preserves the existing desktop layout pixel-for-pixel.
        <aside className="hidden lg:flex w-20 bg-hui-sidebar text-white flex-col min-h-screen items-center py-4 relative z-50">
            {/* Search Flyout */}
            {isSearchOpen && (
                <div className="absolute left-20 top-0 w-64 bg-slate-50 min-h-screen shadow-xl border-r border-slate-200 text-slate-800 flex flex-col z-40">
                    <SearchPanel />
                </div>
            )}

            {/* Main Global Nav */}
            <div className="mb-8 z-50">
                <Link href="/" className="block">
                    {logoUrl ? (
                        <div className="w-10 h-10 rounded-md bg-white flex items-center justify-center overflow-hidden">
                            <img src={logoUrl} alt="Company Logo" className="w-full h-full object-contain" />
                        </div>
                    ) : (
                        <div className="w-10 h-10 bg-hui-primary rounded-md flex items-center justify-center font-bold text-xl hover:bg-hui-primaryHover transition">
                            G
                        </div>
                    )}
                </Link>
            </div>

            <nav className="flex-1 w-full space-y-2 flex flex-col items-center">
                <button
                    onClick={() => setIsSearchOpen(!isSearchOpen)}
                    className={`flex flex-col items-center justify-center w-full py-3 hover:bg-[#2a2a2a] transition ${isSearchOpen ? 'text-white bg-[#2a2a2a]' : 'text-slate-400'}`}
                >
                    <SearchIcon className="w-5 h-5 mb-1" />
                    <span className="text-[10px] uppercase font-semibold">Search</span>
                </button>

                {/* Projects — always visible (filtered by ProjectAccess on the API side) */}
                <Link href={projects.href} className="flex flex-col items-center justify-center w-full py-3 hover:bg-[#2a2a2a] text-slate-400 hover:text-white transition group">
                    <projects.Icon className="w-5 h-5 mb-1 group-hover:text-white" />
                    <span className="text-[10px] uppercase font-semibold">Projects</span>
                </Link>

                {loaded ? (
                    NAV_ITEMS.filter((item) => item.key !== "projects" && item.show(can)).map((item) =>
                        item.custom === "fieldUpdates" ? (
                            <FieldUpdatesNavItem key={item.key} />
                        ) : (
                            <Link
                                key={item.key}
                                href={item.href}
                                className="flex flex-col items-center justify-center w-full py-3 hover:bg-[#2a2a2a] text-slate-400 hover:text-white transition group"
                            >
                                <item.Icon className="w-5 h-5 mb-1 group-hover:text-white" />
                                <span className="text-[10px] uppercase font-semibold text-center leading-tight">{item.label}</span>
                            </Link>
                        )
                    )
                ) : (
                    Array.from({ length: 5 }).map((_, i) => (
                        <div
                            key={i}
                            aria-hidden
                            className="flex flex-col items-center justify-center w-full py-3"
                        >
                            <div className="w-6 h-6 mb-1 rounded bg-slate-700/60 animate-pulse" />
                            <div className="w-10 h-2 rounded bg-slate-700/60 animate-pulse" />
                        </div>
                    ))
                )}
            </nav>

            <div className="w-full flex flex-col items-center space-y-2 mt-auto">
                <Link href="/settings/company" className="flex flex-col items-center justify-center w-full py-3 hover:bg-[#2a2a2a] text-green-400 transition">
                    <svg className="w-5 h-5 mb-1" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M11.3 1.046A12.014 12.014 0 0010 1C5.029 1 1 5.029 1 10c0 4.97 4.029 9 9 9 1.488 0 2.89-.358 4.148-1.006A7.472 7.472 0 0114.5 15C14.5 9.773 18.23 5.372 23 4.296A12.062 12.062 0 0011.3 1.046zM20.5 4a6.5 6.5 0 11-13 0 6.5 6.5 0 0113 0z" clipRule="evenodd" /></svg>
                    <span className="text-[10px] uppercase font-semibold">Upgrade</span>
                </Link>
            </div>
        </aside>
    );
}
