import { NextRequest, NextResponse } from "next/server";
import { generatePurchaseOrderPdf } from "@/lib/pdf";

export async function GET(
    req: NextRequest,
    context: { params: Promise<{ id: string }> }
) {
    const resolvedParams = await context.params;
    const { id } = resolvedParams;

    if (!id) {
        return NextResponse.json({ error: "Missing ID" }, { status: 400 });
    }

    try {
        const pdfBuffer = await generatePurchaseOrderPdf(id);

        const inline = req.nextUrl.searchParams.get('inline') !== 'false'; // default to inline for POs

        return new NextResponse(pdfBuffer as any, {
            status: 200,
            headers: {
                "Content-Type": "application/pdf",
                "Content-Disposition": inline
                    ? `inline; filename="PurchaseOrder_${id}.pdf"`
                    : `attachment; filename="PurchaseOrder_${id}.pdf"`,
            },
        });
    } catch (error) {
        console.error("PO PDF Generation Error:", error);
        return NextResponse.json({ error: "Failed to generate PO PDF" }, { status: 500 });
    }
}
