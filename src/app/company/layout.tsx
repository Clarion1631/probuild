"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Users, Building, FileText, Anchor } from "lucide-react";

export default function CompanyLayout({ children }: { children: React.ReactNode }) {
    const pathname = usePathname();

    const menuItems = [
        { name: "Team Members", href: "/company/team-members", icon: Users },
        { name: "Clients", href: "/clients", icon: Building }, // Just links for now
        { name: "Subcontractors", href: "#", icon: Anchor },
        { name: "Vendors", href: "#", icon: FileText },
    ];

    return (
        <div className="flex h-screen overflow-hidden w-full bg-hui-background">
            {/* Secondary Sidebar */}
            <aside className="w-56 bg-white border-r border-hui-border flex flex-col shrink-0 overflow-y-auto">
                <div className="p-4 pt-6">
                    <h2 className="text-lg font-bold text-hui-textMain mb-6 px-2">Company</h2>
                    <ul className="space-y-1">
                        {menuItems.map((item) => {
                            const isActive = pathname.startsWith(item.href) && item.href !== "#" && item.href !== "/clients";
                            const Icon = item.icon;
                            return (
                                <li key={item.name}>
                                    <Link
                                        href={item.href}
                                        className={`flex items-center gap-3 px-3 py-2 rounded-md transition-colors text-sm font-medium ${isActive
                                                ? "bg-slate-100 text-hui-textMain border-l-4 border-hui-textMain"
                                                : "text-hui-textMuted hover:bg-slate-50 hover:text-hui-textMain"
                                            }`}
                                    >
                                        <Icon className={`w-4 h-4 ${isActive ? 'text-hui-textMain' : 'text-hui-textMuted'}`} />
                                        {item.name}
                                    </Link>
                                </li>
                            );
                        })}
                    </ul>
                </div>
            </aside>

            {/* Main Content Area */}
            <main className="flex-1 flex flex-col overflow-y-auto w-full bg-hui-background">
                {children}
            </main>
        </div>
    );
}
