import { getServerSession } from "next-auth";
import { NextRequest, NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { verifyClientPortalToken } from "@/lib/client-portal-auth";
import { generateChangeOrderBillingPdf } from "@/lib/pdf";
import { prisma } from "@/lib/prisma";
import { isStaffAccountEnabled } from "@/lib/staff-status";

function notFound() {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
}

export async function GET(
    req: NextRequest,
    context: { params: Promise<{ id: string; billingId: string }> },
) {
    const { id, billingId } = await context.params;
    if (!id || !billingId) return notFound();

    const billing = await prisma.changeOrderBilling.findFirst({
        where: { id: billingId, changeOrderId: id },
        select: {
            id: true,
            changeOrderId: true,
            paymentSchedule: {
                select: { invoice: { select: { clientId: true, project: { select: { clientId: true } } } } },
            },
        },
    });
    if (!billing?.paymentSchedule) return notFound();

    const session = await getServerSession(authOptions);
    const staffEmail = session?.user?.email;
    const staffAuthorized = Boolean(staffEmail && await isStaffAccountEnabled(staffEmail));

    const token = req.nextUrl.searchParams.get("token") || req.cookies.get("client_portal_token")?.value;
    const tokenPayload = token ? await verifyClientPortalToken(token) : null;
    const invoiceClientId = billing.paymentSchedule.invoice.clientId
        || billing.paymentSchedule.invoice.project?.clientId
        || null;
    const portalAuthorized = Boolean(tokenPayload && invoiceClientId && tokenPayload.clientId === invoiceClientId);
    if (!staffAuthorized && !portalAuthorized) return notFound();

    try {
        const pdf = await generateChangeOrderBillingPdf(id, billingId);
        const inline = req.nextUrl.searchParams.get("inline") === "true";
        return new NextResponse(pdf as any, {
            status: 200,
            headers: {
                "Content-Type": "application/pdf",
                "Cache-Control": "private, no-store",
                "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="ChangeOrder_TandM_${billingId}.pdf"`,
            },
        });
    } catch {
        return notFound();
    }
}
