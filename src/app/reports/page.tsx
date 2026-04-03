import Link from "next/link";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const REPORT_SECTIONS = [
    {
        heading: "Payments",
        reports: [
            {
                title: "Invoices & Payments",
                description: "Detailed report of all invoices, payment status, amounts collected, and outstanding balances.",
                href: "/invoices",
            },
            {
                title: "Open Invoices",
                description: "View all unpaid and partially paid invoices, including aging information.",
                href: "/invoices",
            },
        ],
    },
    {
        heading: "Project Financials",
        reports: [
            {
                title: "Budget Variance",
                description: "Compare estimated vs. actual labor costs across all active projects by cost code.",
                href: "/manager/variance",
            },
        ],
    },
    {
        heading: "Time & Labor",
        reports: [
            {
                title: "Time Billing Report",
                description: "Review all time entries by employee and project, including billable hours and labor costs.",
                href: "/manager/time-entries",
            },
        ],
    },
    {
        heading: "Estimates",
        reports: [
            {
                title: "All Estimates",
                description: "View and filter all estimates across projects and leads by status, date, and value.",
                href: "/estimates",
            },
        ],
    },
];

export default async function ReportsPage() {
    const session = await getServerSession(authOptions);
    if (!session?.user) return redirect("/login");

    const user = await prisma.user.findUnique({ where: { email: session.user.email! } });
    if (!user || (user.role !== "ADMIN" && user.role !== "MANAGER" && user.role !== "FINANCE")) {
        return <div className="p-8 text-red-500">Access Denied.</div>;
    }

    return (
        <div className="max-w-4xl mx-auto py-8 px-6 space-y-10">
            <h1 className="text-2xl font-bold text-hui-textMain">Reports</h1>

            {REPORT_SECTIONS.map((section) => (
                <div key={section.heading}>
                    <h2 className="text-xs font-semibold uppercase tracking-widest text-hui-textMuted mb-4 flex items-center gap-2">
                        <span className="inline-block w-3 h-3 rounded-full bg-hui-primary" />
                        {section.heading}
                    </h2>
                    <div className="space-y-3">
                        {section.reports.map((report) => (
                            <div
                                key={report.title}
                                className="hui-card p-5 flex items-center justify-between gap-4"
                            >
                                <div>
                                    <div className="font-semibold text-hui-textMain text-sm">{report.title}</div>
                                    <div className="text-hui-textMuted text-sm mt-0.5">{report.description}</div>
                                </div>
                                <Link
                                    href={report.href}
                                    className="hui-btn hui-btn-secondary shrink-0 text-sm"
                                >
                                    View Report
                                </Link>
                            </div>
                        ))}
                    </div>
                </div>
            ))}
        </div>
    );
}
