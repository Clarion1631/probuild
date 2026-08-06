import { NextRequest, NextResponse } from "next/server";
import { generateInvoicePdf } from "@/lib/pdf";
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
        const pdfBuffer = await generateInvoicePdf(id);
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
