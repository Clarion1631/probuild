"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const SIDEBAR_ITEMS = [
    { label: "Team Members", href: "/settings/team", icon: "M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" },
    { label: "Subcontractors", href: "/settings/subcontractors", icon: "M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" },
    { label: "Company", href: "/settings/company", icon: "M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" },
    { label: "Cost Codes", href: "/settings/cost-codes", icon: "M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" },
];

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
    const pathname = usePathname();

    return (
        <div className="flex min-h-[calc(100vh-1px)]">
            {/* Settings Sidebar */}
            <aside className="w-56 bg-white border-r border-hui-border flex flex-col shrink-0">
                <div className="px-4 py-5 border-b border-hui-border">
                    <h2 className="text-sm font-bold text-hui-textMain uppercase tracking-wider">Company</h2>
                </div>
                <nav className="flex-1 px-2 py-3 space-y-0.5">
                    {SIDEBAR_ITEMS.map(item => {
                        const active = pathname.startsWith(item.href);
                        return (
                            <Link key={item.href} href={item.href}
                                className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition ${active ? "bg-hui-primary/5 text-hui-primary" : "text-slate-600 hover:bg-slate-50 hover:text-hui-textMain"}`}
                            >
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
                                    <path d={item.icon} />
                                </svg>
                                {item.label}
                            </Link>
                        );
                    })}
                </nav>
            </aside>
            {/* Content */}
            {children}
        </div>
    );
}
