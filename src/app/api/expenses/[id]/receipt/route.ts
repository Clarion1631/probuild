import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { getSupabase, STORAGE_BUCKET } from "@/lib/supabase";

const MAX_RECEIPT_BYTES = 10 * 1024 * 1024; // 10 MB

function isAllowedReceiptType(mimeType: string): boolean {
    return mimeType.startsWith("image/") || mimeType === "application/pdf";
}

// Receipt uploads are ProBuild-owned metadata, unlike amounts/status which are
// read-only once an expense is finalized in QuickBooks (qbPurchaseId set) — so
// this route intentionally does NOT call assertExpenseMutableOutsideQbo.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        const id = (await params).id;
        if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

        const expense = await prisma.expense.findUnique({ where: { id }, select: { id: true } });
        if (!expense) return NextResponse.json({ error: "Expense not found" }, { status: 404 });

        const formData = await req.formData();
        const file = formData.get("file") as File | null;
        if (!file) return NextResponse.json({ error: "No file uploaded" }, { status: 400 });

        if (!isAllowedReceiptType(file.type)) {
            return NextResponse.json({ error: "Unsupported file type. Use an image or PDF." }, { status: 400 });
        }
        if (file.size > MAX_RECEIPT_BYTES) {
            return NextResponse.json({ error: "File too large (max 10MB)" }, { status: 400 });
        }

        const bytes = await file.arrayBuffer();
        const buffer = Buffer.from(bytes);

        const supabase = getSupabase();
        if (!supabase) return NextResponse.json({ error: "Storage not configured" }, { status: 500 });

        const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
        const storagePath = `expenses/${id}/receipt/${Date.now()}_${safeName}`;

        const { error: uploadError } = await supabase.storage
            .from(STORAGE_BUCKET)
            .upload(storagePath, buffer, {
                contentType: file.type || "application/octet-stream",
                upsert: false,
            });

        if (uploadError) {
            return NextResponse.json({ error: `Upload failed: ${uploadError.message}` }, { status: 500 });
        }

        const { data: urlData } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(storagePath);
        const publicUrl = urlData?.publicUrl || storagePath;

        await prisma.expense.update({
            where: { id },
            data: { receiptUrl: publicUrl },
        });

        return NextResponse.json({ ok: true, receiptUrl: publicUrl });
    } catch (error) {
        console.error("Error uploading expense receipt:", error);
        return NextResponse.json({ error: "Failed to upload receipt" }, { status: 500 });
    }
}
