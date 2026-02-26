import { NextRequest, NextResponse } from "next/server";
import { generateEstimatePdf } from "@/lib/pdf";
import { getEstimate } from "@/lib/actions";

export async function GET(
    req: NextRequest,
    context: { params: Promise<{ id: string }> } // Await the entire params object
) {
    const resolvedParams = await context.params;
    const { id } = resolvedParams;

    if (!id) {
        return NextResponse.json({ error: "Missing ID" }, { status: 400 });
    }

    try {
        const estimate = await getEstimate(id);
        if (!estimate) {
            return NextResponse.json({ error: "Estimate not found" }, { status: 404 });
        }

        const pdfBuffer = await generateEstimatePdf(id);

        return new NextResponse(pdfBuffer as any, {
            status: 200,
            headers: {
                "Content-Type": "application/pdf",
                "Content-Disposition": `attachment; filename="Estimate_${estimate.code || id}.pdf"`,
            },
        });
    } catch (error) {
        console.error("PDF Generation Error:", error);
        return NextResponse.json({ error: "Failed to generate PDF" }, { status: 500 });
    }
}
