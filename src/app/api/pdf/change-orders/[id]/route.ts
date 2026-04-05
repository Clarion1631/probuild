import { NextRequest, NextResponse } from "next/server";
import { generateChangeOrderPdf } from "@/lib/pdf";

export async function GET(
    req: NextRequest,
    context: { params: Promise<{ id: string }> }
) {
    const { id } = await context.params;

    if (!id) {
        return NextResponse.json({ error: "Missing ID" }, { status: 400 });
    }

    try {
        const pdfBuffer = await generateChangeOrderPdf(id);
        const inline = req.nextUrl.searchParams.get("inline") === "true";

        return new NextResponse(pdfBuffer as any, {
            status: 200,
            headers: {
                "Content-Type": "application/pdf",
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
