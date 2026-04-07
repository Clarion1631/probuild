export const dynamic = "force-dynamic";
import { prisma } from "@/lib/prisma";
import { getSessionOrDev } from "@/lib/auth";
import { redirect } from "next/navigation";
import ReceiptQueueClient from "./ReceiptQueueClient";

export default async function BookkeeperReceiptsPage() {
    const session = await getSessionOrDev();
    if (!session?.user) redirect("/login");

    // All pending expenses (AI-parsed or manually submitted)
    const pendingExpenses = await prisma.expense.findMany({
        where: { status: "Pending" },
        include: {
            estimate: {
                include: { project: { select: { id: true, name: true } } },
            },
            costCode: { select: { code: true, name: true } },
        },
        orderBy: { createdAt: "desc" },
    });

    const projects = await prisma.project.findMany({
        where: { status: { not: "Closed" } },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
    });

    const costCodes = await prisma.costCode.findMany({
        where: { isActive: true },
        select: { id: true, code: true, name: true },
        orderBy: { code: "asc" },
    });

    return (
        <div className="max-w-6xl mx-auto py-8 px-6 space-y-6">
            <div>
                <h1 className="text-2xl font-bold text-hui-textMain">Bookkeeper Review Queue</h1>
                <p className="text-sm text-hui-textMuted mt-1">
                    Review AI-parsed receipts and manually submitted expenses before they enter the books.
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
                        (configure email routing in your DNS/email provider to post to <code>/api/receipts/parse</code>).
                    </div>
                </div>
            </div>

            <ReceiptQueueClient
                expenses={JSON.parse(JSON.stringify(pendingExpenses))}
                projects={projects}
                costCodes={costCodes}
            />
        </div>
    );
}
