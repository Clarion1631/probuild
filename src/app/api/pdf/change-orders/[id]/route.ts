import { NextRequest, NextResponse } from "next/server";
import { generateChangeOrderPdf } from "@/lib/pdf";
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

    // Entitlement mirrors getChangeOrderForPortal (IDOR-4): staff may fetch any
    // change order; a portal client only their own project's, and never a
    // Draft — that includes invalidated-after-edit versions.
    if (!await isStaffRequest()) {
        const portalClientId = await getPortalClientId(req);
        if (!portalClientId) return notFound();
        const co = await prisma.changeOrder.findFirst({
            where: {
                id,
                project: { clientId: portalClientId },
                status: { in: ["Sent", "Approved", "Declined"] },
            },
            select: { id: true },
        });
        if (!co) return notFound();
    }

    try {
        const pdfBuffer = await generateChangeOrderPdf(id);
        const inline = req.nextUrl.searchParams.get("inline") === "true";

        return new NextResponse(pdfBuffer as any, {
            status: 200,
            headers: {
                "Content-Type": "application/pdf",
                "Cache-Control": "private, no-store",
                "Content-Disposition": inline
                    ? `inline; filename="ChangeOrder_${id}.pdf"`
                    : `attachment; filename="ChangeOrder_${id}.pdf"`,
            },
        });
    } catch (error) {
        console.error("Change Order PDF Generation Error:", error);
        return NextResponse.json({ error: "Failed to generate PDF" }, { status: 500 });
    }
}
