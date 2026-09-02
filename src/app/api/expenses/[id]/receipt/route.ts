import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveExpenseProjectId } from "@/lib/expense-attribution";
import { getCurrentUserWithPermissions, canAccessProject } from "@/lib/permissions";
import { getSupabase, STORAGE_BUCKET } from "@/lib/supabase";

const MAX_RECEIPT_BYTES = 10 * 1024 * 1024; // 10 MB

// Explicit allowlist compared on the MIME essence ("image/svg+xml; charset=x"
// must not sneak past a startsWith check) — receipts are photos or PDFs.
const ALLOWED_RECEIPT_TYPES = new Set([
    "image/jpeg", "image/png", "image/webp", "image/gif",
    "image/heic", "image/heif", "application/pdf",
]);

function isAllowedReceiptType(mimeType: string): boolean {
    const essence = mimeType.split(";")[0].trim().toLowerCase();
    return ALLOWED_RECEIPT_TYPES.has(essence);
}

// Receipt uploads are ProBuild-owned metadata, unlike amounts/status which are
// read-only once an expense is finalized in QuickBooks (qbPurchaseId set) — so
// this route intentionally does NOT call assertExpenseMutableOutsideQbo.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        const user = await getCurrentUserWithPermissions();
        if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        const id = (await params).id;
        if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

        const expense = await prisma.expense.findUnique({
            where: { id },
            select: { id: true, projectId: true, estimate: { select: { projectId: true } } },
        });
        if (!expense) return NextResponse.json({ error: "Expense not found" }, { status: 404 });
        // Fail closed: an expense with no resolvable project cannot be
        // authorized against project access, so nobody uploads to it.
        //
        // Resolved, not read off the estimate: a re-attributed expense belongs
        // to the project its `projectId` names, and authorizing it against the
        // job it USED to be on would both admit the wrong people and lock out
        // the crew who now own it.
        const projectId = resolveExpenseProjectId(expense);
        if (!projectId || !canAccessProject(user, projectId)) {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }

        const formData = await req.formData();
        const file = formData.get("file");
        if (!(file instanceof File) || file.size === 0) {
            return NextResponse.json({ error: "No file uploaded" }, { status: 400 });
        }

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
