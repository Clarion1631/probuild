"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import ErrorBoundary from "@/components/ErrorBoundary";
import { usePermissions } from "@/components/PermissionsProvider";

const NAV_SECTIONS = [
    {
        heading: "Payments",
        items: [
            { label: "Payments Received", href: "/reports/payments" },
            { label: "Open Invoices", href: "/reports/open-invoices" },
            { label: "Payouts", href: "/reports/payouts" },
            { label: "Transactions", href: "/reports/transactions" },
            { label: "Sales Tax", href: "/reports/sales-tax" },
        ],
    },
    {
        heading: "Project Financials",
        items: [
            { label: "Budget Variance", href: "/manager/variance" },
            { label: "Global Tracker", href: "/reports/global-tracker" },
        ],
    },
    {
        heading: "Time & Labor",
        items: [
            { label: "Time Billing", href: "/reports/time-billing" },
        ],
    },
    {
        heading: "Estimates",
        items: [
            { label: "All Estimates", href: "/estimates" },
        ],
    },
    {
        heading: "Admin Tools",
        adminOnly: true,
        items: [
            { label: "Stripe Payment Sync", href: "/reports/stripe-backfill" },
        ],
    },
];

export default function ReportsLayout({ children }: { children: React.ReactNode }) {
    const pathname = usePathname();
    const { isAdmin } = usePermissions();

    return (
        <div className="flex min-h-[calc(100vh-1px)] h-full overflow-hidden bg-hui-background text-slate-900 w-full">
            {/* Reports Sidebar */}
            <aside className="w-56 border-r border-hui-border bg-white flex-shrink-0 h-full overflow-y-auto">
                <div className="p-5">
                    <Link href="/reports" className="block text-xl font-bold text-hui-textMain mb-6 hover:text-hui-primary transition">
                        Reports
                    </Link>

                    <div className="space-y-5">
                        {NAV_SECTIONS.filter(s => !s.adminOnly || isAdmin).map((section) => (
                            <div key={section.heading}>
                                <p className="text-[10px] font-semibold uppercase tracking-widest text-hui-textMuted mb-1.5 px-3">
                                    {section.heading}
                                </p>
                                <ul className="space-y-0.5">
                                    {section.items.map((item) => {
                                        const isActive = pathname === item.href;
                                        return (
                                            <li key={item.href}>
                                                <Link
                                                    href={item.href}
                                                    className={`block px-3 py-2 text-sm rounded-md transition-colors ${isActive
                                                        ? "font-medium bg-[#f5efe6] text-hui-textMain"
                                                        : "text-hui-textMuted hover:bg-slate-50 hover:text-hui-textMain"
                                                    }`}
                                                >
                                                    {item.label}
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

            {/* Content */}
            <main className="flex-1 overflow-y-auto bg-hui-background h-full w-full">
                <ErrorBoundary fallbackTitle="Reports error">
                    {children}
                </ErrorBoundary>
            </main>
        </div>
    );
}
