import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSupabase, STORAGE_BUCKET } from "@/lib/supabase";

export const maxDuration = 60;

export async function POST(
    req: NextRequest,
    context: { params: Promise<{ id: string }> }
) {
    try {
        const { id } = await context.params;

        if (!id) {
            return NextResponse.json({ error: "Missing estimate ID" }, { status: 400 });
        }

        const estimate = await prisma.estimate.findUnique({ where: { id }, select: { id: true, code: true } });
        if (!estimate) {
            return NextResponse.json({ error: "Estimate not found" }, { status: 404 });
        }

        const supabase = getSupabase();
        if (!supabase) {
            return NextResponse.json({ error: "Storage not configured" }, { status: 500 });
        }

        let formData;
        try {
            formData = await req.formData();
        } catch {
            return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
        }

        const pdfBlob = formData.get("pdf") as File | null;
        if (!pdfBlob) {
            return NextResponse.json({ error: "No PDF file attached" }, { status: 400 });
        }

        const MAX_PDF_BYTES = 20 * 1024 * 1024; // 20 MB
        if (pdfBlob.size > MAX_PDF_BYTES) {
            return NextResponse.json({ error: "PDF too large (max 20 MB)" }, { status: 413 });
        }

        const bytes = await pdfBlob.arrayBuffer();
        const buffer = Buffer.from(bytes);

        const safeName = `Estimate_${(estimate.code || id).replace(/[^a-zA-Z0-9._-]/g, "_")}.pdf`;
        const storagePath = `estimate-pdfs/${id}/${Date.now()}_${safeName}`;

        const { error: uploadError } = await supabase.storage
            .from(STORAGE_BUCKET)
            .upload(storagePath, buffer, {
                contentType: "application/pdf",
                upsert: true,
            });

        if (uploadError) {
            console.error("Supabase upload error:", uploadError);
            return NextResponse.json({ error: `Storage upload failed: ${uploadError.message}` }, { status: 500 });
        }

        const { data: urlData } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(storagePath);
        const url = urlData?.publicUrl || storagePath;

        return NextResponse.json({ success: true, url }, { status: 200 });
    } catch (err: any) {
        console.error("PDF upload error:", err);
        return NextResponse.json({ error: err.message || "Upload failed" }, { status: 500 });
    }
}
