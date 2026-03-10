"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Users, Building, FileText, Anchor } from "lucide-react";

export default function CompanyLayout({ children }: { children: React.ReactNode }) {
    const pathname = usePathname();

    const menuSections = [
        {
            title: "Collaborators",
            items: [
                { name: "Team Members", href: "/company/team-members", icon: Users },
                { name: "Clients", href: "#", icon: Users }, // Placeholder icon
                { name: "Subcontractors", href: "/company/subcontractors", icon: Anchor },
                { name: "Vendors", href: "#", icon: Anchor }, // Placeholder icon
            ]
        },
        {
            title: "Library",
            items: [
                { name: "Templates", href: "/company/templates", icon: FileText },
                { name: "Categories", href: "#", icon: FileText }, // Placeholder icon
                { name: "My Items", href: "#", icon: FileText }, // Placeholder icon
                { name: "Catalogs", href: "#", icon: FileText }, // Placeholder icon
            ]
        },
        {
            title: "Marketing",
            items: [
                { name: "Houzz Profile", href: "/settings/company", icon: Building },
                { name: "Contact Form", href: "#", icon: FileText }, // Placeholder icon
                { name: "Website", href: "#", icon: FileText }, // Placeholder icon
                { name: "Email Marketing", href: "#", icon: FileText }, // Placeholder icon
                { name: "Marketing Insights", href: "#", icon: FileText }, // Placeholder icon
            ]
        }
    ];

    return (
        <div className="flex h-screen overflow-hidden w-full bg-hui-background">
            {/* Secondary Sidebar */}
            <aside className="w-56 bg-white border-r border-hui-border flex flex-col shrink-0 overflow-y-auto">
                <div className="p-4 pt-6">
                    <h2 className="text-lg font-bold text-hui-textMain mb-6 px-2">Company</h2>
                    
                    <div className="space-y-6">
                        {menuSections.map((section) => (
                            <div key={section.title}>
                                <h3 className="text-xs font-semibold text-hui-textMuted flex items-center gap-2 px-2 py-1 uppercase tracking-wider mb-1">
                                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" /></svg>
                                    {section.title}
                                </h3>
                                <ul className="space-y-0.5">
                                    {section.items.map((item) => {
                                        const isActive = pathname.startsWith(item.href) && item.href !== "#";
                                        return (
                                            <li key={item.name}>
                                                <Link
                                                    href={item.href}
                                                    className={`flex items-center gap-2 px-3 py-1.5 rounded-md transition-colors text-sm ${isActive
                                                            ? "bg-hui-primary/10 text-hui-primary font-medium"
                                                            : "text-hui-textMain hover:bg-slate-50"
                                                        }`}
                                                >
                                                    {item.name}
                                                </Link>
                                            </li>
                                        );
                                    })}
                                </ul>
                            </div>
                        ))}
                    </div>
                </div>
            </aside>

            {/* Main Content Area */}
            <main className="flex-1 flex flex-col overflow-y-auto w-full bg-hui-background">
                {children}
            </main>
        </div>
    );
}
