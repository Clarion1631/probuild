import { NextRequest, NextResponse } from "next/server";
import { generateEstimatePdf } from "@/lib/pdf";

export async function GET(
    req: NextRequest,
    context: { params: Promise<{ id: string }> }
) {
    const { id } = await context.params;

    if (!id) {
        return NextResponse.json({ error: "Missing ID" }, { status: 400 });
    }

    try {
        const pdfBuffer = await generateEstimatePdf(id);
        const inline = req.nextUrl.searchParams.get("inline") === "true";

        return new NextResponse(pdfBuffer as any, {
            status: 200,
            headers: {
                "Content-Type": "application/pdf",
                "Content-Disposition": inline
                    ? `inline; filename="Estimate_${id}.pdf"`
                    : `attachment; filename="Estimate_${id}.pdf"`,
            },
        });
    } catch (error) {
        console.error("Estimate PDF Generation Error:", error);
        return NextResponse.json({ error: "Failed to generate PDF" }, { status: 500 });
    }
}
