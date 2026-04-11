"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import ErrorBoundary from "@/components/ErrorBoundary";

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
    const pathname = usePathname();

    const navLink = (href: string, label: string) => (
        <li key={href}>
            <Link
                href={href}
                className={`block px-3 py-2 text-sm rounded-md transition-colors ${pathname === href ? 'font-medium bg-[#f5efe6] text-hui-textMain' : 'text-hui-textMuted hover:bg-slate-50 hover:text-hui-textMain'}`}
            >
                {label}
            </Link>
        </li>
    );

    return (
        <div className="flex min-h-[calc(100vh-1px)] h-full overflow-hidden bg-hui-background text-slate-900 w-full">
            {/* Settings Sidebar */}
            <aside className="w-64 border-r border-hui-border bg-white flex-shrink-0 h-full overflow-y-auto">
                <div className="p-6 space-y-6">
                    <h2 className="text-xl font-bold text-hui-textMain">Settings</h2>

                    {/* Account */}
                    <div>
                        <p className="text-[10px] font-semibold uppercase tracking-widest text-hui-textMuted mb-1.5 px-3">Account</p>
                        <ul className="space-y-0.5">
                            {navLink("/settings/company", "Company Info")}
                            {navLink("/settings/privacy", "Privacy & Security")}
                            {navLink("/settings/language", "Language")}
                        </ul>
                    </div>

                    {/* Business */}
                    <div>
                        <p className="text-[10px] font-semibold uppercase tracking-widest text-hui-textMuted mb-1.5 px-3">Business</p>
                        <ul className="space-y-0.5">
                            {navLink("/settings/notifications", "Notifications")}
                            {navLink("/settings/payment-methods", "Payment Methods")}
                            {navLink("/settings/sales-taxes", "Sales Taxes")}
                            {navLink("/settings/calendar", "Calendar")}
                            {navLink("/settings/integrations", "Integrations")}
                        </ul>
                    </div>

                    {/* Team */}
                    <div>
                        <p className="text-[10px] font-semibold uppercase tracking-widest text-hui-textMuted mb-1.5 px-3">Team</p>
                        <ul className="space-y-0.5">
                            {navLink("/settings/contacts", "Contacts")}
                            {navLink("/settings/cost-codes", "Cost Codes")}
                        </ul>
                    </div>
                </div>
            </aside>
            {/* Content */}
            <main className="flex-1 overflow-y-auto bg-hui-background h-full w-full">
                <ErrorBoundary fallbackTitle="Settings error">
                    {children}
                </ErrorBoundary>
            </main>
        </div>
    );
}
