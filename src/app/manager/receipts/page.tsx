export const dynamic = "force-dynamic";
import { prisma } from "@/lib/prisma";
import { getSessionOrDev } from "@/lib/auth";
import { redirect } from "next/navigation";
import { resolveReceiptUrls } from "@/lib/receipt-intake/receipt-url";
import { STAFF_READ_ROLES } from "@/lib/receipt-intake/intake-auth";
import ReceiptQueueClient from "./ReceiptQueueClient";

export default async function BookkeeperReceiptsPage() {
    const session = await getSessionOrDev();
    if (!session?.user) redirect("/login");

    // Same role gate as the GET /api/receipts/intake staff-queue read
    // (STAFF_READ_ROLES): this page queries Expense directly and mints
    // short-lived signed URLs for every receipt, so a session check alone let
    // ANY logged-in role — not just ADMIN/MANAGER/FINANCE — browse the
    // bookkeeper queue and its receipt images. Deny-by-default: no matching
    // User (outside local dev) is not staff.
    const user = await prisma.user.findUnique({ where: { email: session.user.email! } });
    if (!user ? process.env.NODE_ENV !== "development" : !STAFF_READ_ROLES.includes(user.role)) {
        return <div className="p-8 text-red-500">Access Denied. Bookkeeping staff only.</div>;
    }

    const [
        pendingExpenses,
        importedExpenses,
        importedExpenseCount,
        projects,
        costCodes,
    ] = await Promise.all([
        // Receipt intake remains the pre-accounting review queue.
        prisma.expense.findMany({
            where: { status: "Pending" },
            include: {
                estimate: {
                    include: { project: { select: { id: true, name: true } } },
                },
                costCode: { select: { code: true, name: true } },
            },
            orderBy: { createdAt: "desc" },
        }),
        // QBO imports are finalized records and never enter the actionable queue.
        prisma.expense.findMany({
            where: { qbPurchaseId: { not: null } },
            include: {
                estimate: {
                    include: { project: { select: { id: true, name: true } } },
                },
                costCode: { select: { code: true, name: true } },
            },
            orderBy: { qbSyncedAt: "desc" },
            take: 100,
        }),
        prisma.expense.count({
            where: { qbPurchaseId: { not: null } },
        }),
        prisma.project.findMany({
            where: { status: { not: "Closed" } },
            select: { id: true, name: true },
            orderBy: { name: "asc" },
        }),
        prisma.costCode.findMany({
            where: { isActive: true },
            select: { id: true, code: true, name: true },
            orderBy: { code: "asc" },
        }),
    ]);

    // `receiptUrl` is a stable `receipt-intake://` REFERENCE for anything the
    // v2 pipeline booked (book.ts), not a link — the client renders it
    // straight into an `href`, so it must be a short-lived signed URL by the
    // time it gets there. A legacy absolute URL passes through unchanged.
    const [resolvedPendingExpenses, resolvedImportedExpenses] = await Promise.all([
        resolveReceiptUrls(pendingExpenses),
        resolveReceiptUrls(importedExpenses),
    ]);

    return (
        <div className="max-w-6xl mx-auto py-8 px-6 space-y-6">
            <div>
                <h1 className="text-2xl font-bold text-hui-textMain">Bookkeeper Review Queue</h1>
                <p className="text-sm text-hui-textMuted mt-1">
                    Review receipt intake before accounting, and audit finalized expenses imported from QuickBooks.
                </p>
            </div>

            <div className="hui-card p-4 bg-amber-50 border-amber-200">
                <div className="flex items-start gap-3">
                    <svg className="w-5 h-5 text-amber-600 mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
                    </svg>
                    <div className="text-sm text-amber-800">
                        <strong>Receipt forwarding address:</strong> Forward emailed receipts to{" "}
                        <code className="bg-amber-100 px-1 py-0.5 rounded font-mono text-xs">receipts@probuild.goldentouchremodeling.com</code>{" "}
                        — they land in the Drive receipts archive, where the receipt automation processes them.
                    </div>
                </div>
            </div>

            <ReceiptQueueClient
                expenses={JSON.parse(JSON.stringify(resolvedPendingExpenses))}
                importedExpenses={JSON.parse(JSON.stringify(resolvedImportedExpenses))}
                importedExpenseCount={importedExpenseCount}
                projects={projects}
                costCodes={costCodes}
            />
        </div>
    );
}
