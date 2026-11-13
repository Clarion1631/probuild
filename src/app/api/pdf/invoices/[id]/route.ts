import { NextRequest, NextResponse } from "next/server";
import { generateInvoicePdfWithAudit } from "@/lib/pdf";
import { getPortalClientId, isStaffRequest } from "@/lib/pdf-route-auth";
import { prisma } from "@/lib/prisma";

function notFound() {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
}

export async function GET(
    req: NextRequest,
    context: { params: Promise<{ id: string }> }
) {
    const { id } = await context.params;

    if (!id) {
        return NextResponse.json({ error: "Missing ID" }, { status: 400 });
    }

    // This route is proxy-bypassed so portal clients can reach it without a
    // staff session — it must authorize here. Entitlement mirrors
    // getInvoiceForPortal: staff, or the client the invoice belongs to.
    const invoice = await prisma.invoice.findUnique({
        where: { id },
        select: { clientId: true, project: { select: { clientId: true } } },
    });
    if (!invoice) return notFound();

    if (!await isStaffRequest()) {
        const portalClientId = await getPortalClientId(req);
        const entitled = Boolean(portalClientId
            && (portalClientId === invoice.clientId || portalClientId === invoice.project?.clientId));
        if (!entitled) return notFound();
    }

    try {
        // ?exact=1 (the phone Download): answer 409 instead of a PDF that would not match the page.
        // ?milestone= is the payment-request focus; it only changes how the PDF is drawn.
        const exact = req.nextUrl.searchParams.get("exact") === "1";
        const requestedMilestoneIds = (req.nextUrl.searchParams.get("milestone") || "")
            .split(",").map(s => s.trim()).filter(s => s.length > 0 && s.length <= 50).slice(0, 40);
        const { bytes: pdfBuffer, lossy } = await generateInvoicePdfWithAudit(id, {
            requestedMilestoneIds,
            // The page hides the full-invoice Total Amount in focus mode; only the exact (phone Download) path mirrors that.
            omitFocusedTotal: exact,
        });
        if (exact && lossy) return NextResponse.json({ error: "PDF would not match the page" }, { status: 409, headers: { "Cache-Control": "private, no-store" } });
        const inline = req.nextUrl.searchParams.get("inline") === "true";

        return new NextResponse(pdfBuffer as any, {
            status: 200,
            headers: {
                "Content-Type": "application/pdf",
                "Cache-Control": "private, no-store",
                "Content-Disposition": inline
                    ? `inline; filename="Invoice_${id}.pdf"`
                    : `attachment; filename="Invoice_${id}.pdf"`,
            },
        });
    } catch (error) {
        console.error("Invoice PDF Generation Error:", error);
        return NextResponse.json({ error: "Failed to generate PDF" }, { status: 500 });
    }
}
