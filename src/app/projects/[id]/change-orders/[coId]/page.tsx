import { getChangeOrder, getProject } from "@/lib/actions";
import { notFound } from "next/navigation";
import ChangeOrderEditor from "./ChangeOrderEditor";
import { resolveDocUrl } from "@/lib/secure-storage";
import { currentStaffUserOrNull, isAdminOrManager } from "@/lib/permissions";
import { resolveCompanyTimeZone } from "@/lib/company-timezone";
import { dayKeyInTimeZone } from "@/lib/tz-date";
import { isOfflineApproval, offlineApprovalSummary } from "@/lib/change-order-offline-approval";
import { creditTargetError } from "@/lib/change-order-credit";

export const dynamic = "force-dynamic";

export default async function ChangeOrderPage({
    params
}: {
    params: Promise<{ id: string; coId: string }>
}) {
    const resolvedParams = await params;
    const project = await getProject(resolvedParams.id);
    const co = await getChangeOrder(resolvedParams.coId);

    if (!project) return <div>Project not found</div>;
    if (!co) {
        notFound();
    }

    // totalAmount/balanceDue are Prisma Decimals — serialize before crossing the
    // server->client boundary (the portal twin already JSON-serializes the same shape).
    const initialData = JSON.parse(JSON.stringify({
        ...co,
        clientSignatureUrl: await resolveDocUrl((co as any).clientSignatureUrl),
        companySignatureUrl: await resolveDocUrl((co as any).companySignatureUrl),
    }));

    // The editor never decides the role itself: the server says whether the
    // "Mark approved" button may show. Only Draft/Sent COs with no customer
    // approval on file can be marked approved.
    const staff = await currentStaffUserOrNull();
    const timeZone = await resolveCompanyTimeZone();
    const hasApprovalOnFile = co.approvedBy != null || co.approvedAt != null || co.clientSignatureUrl != null || (co as any).approvalSource != null;
    const canMarkApproved = !!staff
        && isAdminOrManager(staff)
        && (co.status === "Draft" || co.status === "Sent")
        && !hasApprovalOnFile;
    // A FIXED credit (negative subtotal) lowers one unpaid milestone on the invoice, so
    // "Mark approved" needs the milestones it can come off. Plain values only.
    const isCredit = co.pricingType !== "COST_PLUS" && Math.round(Number(co.totalAmount) * 100) < 0;
    // Loaded lazily (like the server actions do) so the page only pulls billing-core for a credit.
    const creditTargets = canMarkApproved && isCredit
        ? await (await import("@/lib/billing-core")).getChangeOrderCreditTargets(co.id)
        : null;
    const credit = creditTargets
        ? {
            estimateCode: co.estimate?.code ?? null,
            invoiceCode: creditTargets.invoice?.code ?? null,
            taxLabel: creditTargets.credit.taxLabel,
            creditAmount: creditTargets.credit.totalCents / 100,
            rows: creditTargets.rows
                .filter((row) => row.eligible)
                .map((row) => ({
                    id: row.id,
                    name: row.name,
                    amount: row.amountCents / 100,
                    newAmount: row.newAmountCents / 100,
                    fits: row.fits,
                    reason: row.reason,
                })),
            defaultId: creditTargets.defaultId,
            error: creditTargetError(co.code, creditTargets, null),
        }
        : null;
    const offline = {
        canMarkApproved,
        todayKey: dayKeyInTimeZone(new Date(), timeZone),
        staffName: (staff?.name?.trim() || staff?.email || "") as string,
        summary: isOfflineApproval(co as any) ? offlineApprovalSummary(co as any, timeZone) : null,
        credit,
    };

    return (
        <div className="flex h-[calc(100%+48px)] -m-6 overflow-hidden">
            <div className="flex-1 bg-slate-50 overflow-hidden flex flex-col">
                <ChangeOrderEditor
                    context={{
                        projectId: project.id,
                        projectName: project.name,
                        clientName: project.client.name,
                        clientEmail: project.client.email || undefined,
                        location: project.location || undefined
                    }}
                    initialData={initialData}
                    offline={offline}
                />
            </div>
        </div>
    );
}
