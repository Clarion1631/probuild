// Copy a QBO Purchase's receipt attachment into ProBuild's own storage so the
// receipt is viewable in ProBuild without a QuickBooks login. QBO stays the
// financial source of record; the stored copy is audit convenience.
//
// receiptUrl is ProBuild-owned metadata: this module only ever fills an EMPTY
// receiptUrl (guarded update), so a manually uploaded receipt is never
// overwritten by a later sync run.
import { getQBPurchaseAttachables, qbTimedFetch, type QBTokens } from "./quickbooks";
import { getSupabase, STORAGE_BUCKET } from "./supabase";
import { prisma } from "./prisma";
import { withReceiptEvidenceLock } from "@/lib/receipt-evidence-lock";

const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
const ALLOWED_CONTENT = /^(image\/|application\/pdf)/i;

export type QboReceiptAttachResult =
    | "attached"
    | "no-expense"
    | "already-linked"
    | "no-attachment"
    | "storage-unavailable";

export async function attachQboReceipt(
    tokens: QBTokens,
    qbPurchaseId: string,
): Promise<QboReceiptAttachResult> {
    const expense = await prisma.expense.findUnique({
        where: { qbPurchaseId },
        select: { id: true, receiptUrl: true },
    });
    if (!expense) return "no-expense";
    if (expense.receiptUrl) return "already-linked";

    const supabase = getSupabase();
    if (!supabase) return "storage-unavailable";

    const attachables = await getQBPurchaseAttachables(tokens, qbPurchaseId);
    const candidates = attachables
        .filter(a => a.TempDownloadUri && ALLOWED_CONTENT.test(a.ContentType ?? ""))
        .filter(a => (a.Size ?? 0) <= MAX_ATTACHMENT_BYTES)
        // The email-to-QBO intake stores the rendered email body alongside the
        // real receipt; prefer the actual receipt file, then the largest file.
        .sort((left, right) => {
            const leftEmail = /^Email_body/i.test(left.FileName ?? "") ? 1 : 0;
            const rightEmail = /^Email_body/i.test(right.FileName ?? "") ? 1 : 0;
            if (leftEmail !== rightEmail) return leftEmail - rightEmail;
            return (right.Size ?? 0) - (left.Size ?? 0);
        });
    const attachment = candidates[0];
    if (!attachment?.TempDownloadUri) return "no-attachment";

    // QBO-issued temp URL: same unbounded-hang risk as the API itself.
    const download = await qbTimedFetch(attachment.TempDownloadUri);
    if (!download.ok) {
        throw new Error(`QBO attachment download failed: HTTP ${download.status}`);
    }
    const bytes = Buffer.from(await download.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_ATTACHMENT_BYTES) {
        return "no-attachment";
    }

    const safeName = (attachment.FileName ?? "receipt").replace(/[^a-zA-Z0-9._-]/g, "_");
    const storagePath = `expenses/${expense.id}/receipt/qbo_${attachment.Id ?? "0"}_${safeName}`;
    const { error: uploadError } = await supabase.storage
        .from(STORAGE_BUCKET)
        .upload(storagePath, bytes, {
            contentType: attachment.ContentType || "application/octet-stream",
            upsert: true,
        });
    if (uploadError) throw new Error(`Receipt upload failed: ${uploadError.message}`);

    const { data: urlData } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(storagePath);
    const publicUrl = urlData?.publicUrl;
    if (!publicUrl) throw new Error("Receipt upload produced no public URL");

    // Guarded: only fill an empty receiptUrl so manual uploads always win.
    // Receipt linkage is sweep evidence, so this queues behind the sweep
    // (round-42 gate, finding 1).
    const { count } = await withReceiptEvidenceLock<{ count: number }>(
        fn => prisma.$transaction(fn),
        tx => tx.expense.updateMany({
            where: { id: expense.id, receiptUrl: null },
            data: { receiptUrl: publicUrl },
        }),
    );
    if (count === 0) {
        // Someone else linked a receipt first. Concurrent QBO attaches share
        // this deterministic path, so only clean up when the winner's URL is a
        // DIFFERENT object (a manual upload) — never delete what's now linked.
        const current = await prisma.expense.findUnique({
            where: { id: expense.id },
            select: { receiptUrl: true },
        });
        if (current?.receiptUrl !== publicUrl) {
            await supabase.storage.from(STORAGE_BUCKET).remove([storagePath]).catch(() => {});
        }
        return "already-linked";
    }
    return "attached";
}
