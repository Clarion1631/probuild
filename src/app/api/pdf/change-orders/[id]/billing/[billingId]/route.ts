import { NextRequest, NextResponse } from "next/server";
import { generateChangeOrderBillingPdf } from "@/lib/pdf";
import { getPortalClientId, isStaffRequest } from "@/lib/pdf-route-auth";
import { prisma } from "@/lib/prisma";

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

    if (!await isStaffRequest()) {
        // OR entitlement, mirroring getInvoiceForPortal: the invoice's own
        // client or the project's client may fetch the billing backup.
        const portalClientId = await getPortalClientId(req);
        const invoice = billing.paymentSchedule.invoice;
        const portalAuthorized = Boolean(portalClientId
            && (portalClientId === invoice.clientId || portalClientId === invoice.project?.clientId));
        if (!portalAuthorized) return notFound();
    }

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
