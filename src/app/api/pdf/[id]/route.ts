import { NextRequest, NextResponse } from "next/server";
import { generateEstimatePdf } from "@/lib/pdf";
import { isStaffRequest } from "@/lib/pdf-route-auth";

export async function GET(
    req: NextRequest,
    context: { params: Promise<{ id: string }> }
) {
    const resolvedParams = await context.params;
    const { id } = resolvedParams;

    if (!id) {
        return NextResponse.json({ error: "Missing ID" }, { status: 400 });
    }

    // Legacy staff-facing estimate PDF; clients get theirs via /portal/estimates.
    if (!await isStaffRequest()) {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    try {
        const pdfBuffer = await generateEstimatePdf(id);

        const inline = req.nextUrl.searchParams.get('inline') === 'true';

        return new NextResponse(pdfBuffer as any, {
            status: 200,
            headers: {
                "Content-Type": "application/pdf",
                "Cache-Control": "private, no-store",
                "Content-Disposition": inline
                    ? `inline; filename="Estimate_${id}.pdf"`
                    : `attachment; filename="Estimate_${id}.pdf"`,
            },
        });
    } catch (error) {
        console.error("PDF Generation Error:", error);
        return NextResponse.json({ error: "Failed to generate PDF" }, { status: 500 });
    }
}
