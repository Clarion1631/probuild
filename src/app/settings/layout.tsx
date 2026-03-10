"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
    const pathname = usePathname();

    return (
        <div className="flex min-h-[calc(100vh-1px)] h-full overflow-hidden bg-hui-background text-slate-900 w-full">
            {/* Settings Sidebar */}
            <aside className="w-64 border-r border-hui-border bg-white flex-shrink-0 h-full overflow-y-auto">
                <div className="p-6">
                    <h2 className="text-xl font-bold text-hui-textMain mb-6">Account Info</h2>
                    
                    <ul className="space-y-1">
                        <li>
                            <Link 
                                href="/settings/company" 
                                className={`block px-3 py-2 text-sm rounded-md transition-colors ${pathname === '/settings/company' ? 'font-medium bg-[#f5efe6] text-hui-textMain' : 'text-hui-textMuted hover:bg-slate-50'}`}
                            >
                                Your Houzz Pro Account
                            </Link>
                        </li>
                        <li>
                            <Link 
                                href="#" 
                                className="block px-3 py-2 text-sm text-hui-textMuted hover:bg-slate-50 rounded-md transition-colors"
                            >
                                Privacy & Security
                            </Link>
                        </li>
                        <li>
                            <Link 
                                href="#" 
                                className="block px-3 py-2 text-sm text-hui-textMuted hover:bg-slate-50 rounded-md transition-colors"
                            >
                                Language
                            </Link>
                        </li>
                    </ul>
                </div>
            </aside>
            {/* Content */}
            <main className="flex-1 overflow-y-auto bg-hui-background h-full w-full">
                {children}
            </main>
        </div>
    );
}
