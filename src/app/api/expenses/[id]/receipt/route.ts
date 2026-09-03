import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
    expenseStillOnProjectWhere,
    resolveExpenseProjectId,
    resolveExpenseProjectUnderLock,
} from "@/lib/expense-attribution";
import { lockExpense } from "@/lib/expense-lock";
import { lockAttributionParents } from "@/lib/phase-invariant";
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

/**
 * The storage path inside a receipt URL this route wrote, or null.
 *
 * Deliberately narrow: only `expenses/<id>/receipt/...` under this bucket is
 * ever returned, so a `receiptUrl` pointing anywhere else — a Drive link, a
 * receipt-intake object under its own bucket, a legacy value that is a bare
 * path — is left strictly alone. The cleanup below deletes REAL FILES, and the
 * only ones it is entitled to delete are the ones this route created.
 */
function ownedReceiptPath(url: string | null, expenseId: string): string | null {
    if (!url) return null;
    const marker = `/${STORAGE_BUCKET}/`;
    const idx = url.indexOf(marker);
    if (idx === -1) return null;
    const path = decodeURIComponent(url.slice(idx + marker.length)).split("?")[0];
    return path.startsWith(`expenses/${expenseId}/receipt/`) ? path : null;
}

/** Best effort, always: an orphaned object is a smaller problem than a 500. */
async function removeObject(
    supabase: ReturnType<typeof getSupabase>,
    path: string | null,
): Promise<void> {
    if (!supabase || !path) return;
    try {
        await supabase.storage.from(STORAGE_BUCKET).remove([path]);
    } catch {
        console.warn("expense receipt: could not remove storage object", path);
    }
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
            select: { id: true, projectId: true, estimateId: true, estimate: { select: { projectId: true } } },
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

        // THE UPLOAD IS THE SLOW PART, AND THE AUTHORIZATION WAS DECIDED BEFORE
        // IT (Codex round 35, item 2).
        //
        // Two things can change while a 10 MB photo is going up, and this used
        // to survive neither:
        //
        //   * A FALLBACK-ATTRIBUTED expense answers through its estimate, and
        //     that estimate can be moved to another job mid-upload. The write
        //     then landed on a row the uploader has no access to — a receipt
        //     attached to a stranger's job under a permission granted for a
        //     different one.
        //   * TWO uploads can be in flight at once. Both wrote `receiptUrl` by
        //     bare id, so the later one silently replaced the earlier, leaving
        //     the loser's object in the bucket with nothing pointing at it —
        //     paid-for storage holding a receipt no report can ever find.
        //
        // So the write re-decides both under the shared per-expense lock, and
        // carries the answer in its predicate. Whichever object does not end up
        // referenced is deleted before this returns, whether it is the one just
        // uploaded (lost the race) or the one it replaced (won it).
        const settled = await prisma.$transaction(async tx => {
            const raw = tx as unknown as { $queryRawUnsafe(q: string, ...v: unknown[]): Promise<unknown> };
            // THE PARENTS FIRST, THEN THE ROW (round 40, item 1). The global
            // order is Project -> Estimate -> EstimateItem -> CostCode ->
            // Expense, and EXPENSE IS LAST.
            //
            // This took the per-expense lock and only then called
            // `resolveExpenseProjectUnderLock`, which for a fallback-attributed
            // row share-locks the ESTIMATE to answer: Expense -> Estimate,
            // against a booking path that goes Estimate -> Expense. A cycle,
            // and this route has no `withTxRetry` — the 40P01 surfaces as a
            // failed upload with the object already in the bucket.
            await lockAttributionParents(raw, { projectId, estimateId: expense.estimateId });
            await lockExpense(raw, id);
            const locked = await tx.expense.findUnique({
                where: { id },
                select: { projectId: true, estimateId: true, receiptUrl: true },
            });
            if (!locked) return { outcome: "gone" } as const;
            // THE ROW MUST STILL BE THE ONE WHOSE PARENTS ARE HELD. Both halves
            // are checked because either can move the resolver onto an estimate
            // this transaction never locked: a different `estimateId` sends it
            // to a row outside the lock set, and a different resolved project
            // means the FK write below would reach a `Project` row acquired
            // after the Expense. "lost" is the existing 409, and it deletes the
            // object that was just uploaded.
            if (locked.estimateId !== expense.estimateId) return { outcome: "lost" } as const;
            // Re-resolved through the SHARED resolver, against the share-locked
            // estimate — not the value read before the upload.
            const lockedProjectId = await resolveExpenseProjectUnderLock(raw, locked);
            if (!lockedProjectId || !canAccessProject(user, lockedProjectId)) {
                return { outcome: "forbidden" } as const;
            }
            if (lockedProjectId !== projectId) return { outcome: "lost" } as const;
            const previousUrl = locked.receiptUrl ?? null;
            const result = await tx.expense.updateMany({
                where: {
                    id,
                    // The attribution the access check just answered about...
                    ...expenseStillOnProjectWhere(locked, lockedProjectId),
                    // ...and the value being replaced, so a writer that did not
                    // take the lock cannot have its URL overwritten unseen.
                    receiptUrl: previousUrl,
                },
                data: { receiptUrl: publicUrl },
            });
            if (result.count === 0) return { outcome: "lost" } as const;
            return { outcome: "won", previousUrl } as const;
        });

        if (settled.outcome !== "won") {
            // Nothing points at what was just uploaded, so it does not stay.
            await removeObject(supabase, storagePath);
            if (settled.outcome === "forbidden") {
                return NextResponse.json({ error: "Forbidden" }, { status: 403 });
            }
            if (settled.outcome === "gone") {
                return NextResponse.json({ error: "Expense not found" }, { status: 404 });
            }
            return NextResponse.json(
                {
                    error: "This expense changed while the receipt was uploading. Reopen it and try again.",
                    code: "EXPENSE_REATTRIBUTED",
                },
                { status: 409 },
            );
        }

        // The row now points somewhere else, so the object it used to point at
        // is unreferenced. Same policy as every other replace-in-place upload
        // in the codebase (studio/usdz-generator.ts): best effort, and only for
        // a path this route is entitled to own.
        const replaced = ownedReceiptPath(settled.previousUrl, id);
        if (replaced && replaced !== storagePath) await removeObject(supabase, replaced);

        return NextResponse.json({ ok: true, receiptUrl: publicUrl });
    } catch (error) {
        console.error("Error uploading expense receipt:", error);
        return NextResponse.json({ error: "Failed to upload receipt" }, { status: 500 });
    }
}
