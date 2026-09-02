// Copy a QBO Purchase's receipt attachment into ProBuild's own storage so the
// receipt is viewable in ProBuild without a QuickBooks login. QBO stays the
// financial source of record; the stored copy is audit convenience.
//
// receiptUrl is ProBuild-owned metadata: this module only ever fills an EMPTY
// receiptUrl (guarded update), so a manually uploaded receipt is never
// overwritten by a later sync run.
import { getQBPurchaseAttachables, qbTimedFetch, qboResponseError, type QBTokens, type RouteDeadline } from "./quickbooks";
import { getSupabase, STORAGE_BUCKET } from "./supabase";
import { prisma } from "./prisma";

const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
const ALLOWED_CONTENT = /^(image\/|application\/pdf)/i;

export type QboReceiptAttachResult =
    | "attached"
    | "no-expense"
    | "already-linked"
    | "no-attachment"
    /**
     * QBO HAD a usable-looking attachment for this purchase and we still could
     * not store it — no download URL on the candidate, or a body that came back
     * empty/oversized. Distinct from "no-attachment" (QuickBooks simply has no
     * receipt here, which is the normal case for most purchases and is not a
     * failure) so a run can report the difference instead of counting every
     * receipt-less purchase as broken.
     */
    | "attachment-unavailable"
    | "storage-unavailable";

/** Outcomes that mean a receipt SHOULD have been stored and was not. */
export function isAttachmentFailure(result: QboReceiptAttachResult): boolean {
    return result === "attachment-unavailable" || result === "storage-unavailable";
}

export async function attachQboReceipt(
    tokens: QBTokens,
    qbPurchaseId: string,
    deadline?: RouteDeadline,
): Promise<QboReceiptAttachResult> {
    const expense = await prisma.expense.findUnique({
        where: { qbPurchaseId },
        select: { id: true, receiptUrl: true },
    });
    if (!expense) return "no-expense";
    if (expense.receiptUrl) return "already-linked";

    const supabase = getSupabase();
    if (!supabase) return "storage-unavailable";

    const attachables = await getQBPurchaseAttachables(tokens, qbPurchaseId, deadline);
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
    if (!attachment) return "no-attachment"; // QBO has no receipt for this purchase
    // A candidate that survived the filters but carries no download URL is an
    // anomaly, not an absence: there IS a receipt and we cannot fetch it.
    if (!attachment.TempDownloadUri) return "attachment-unavailable";

    // QBO-issued temp URL: same unbounded-hang risk as the API itself, and the
    // same run budget — a slow download is still time the sync cannot spend.
    const download = await qbTimedFetch(attachment.TempDownloadUri, { qbDeadline: deadline });
    if (!download.ok) {
        // A bare Error made a 503 on the download indistinguishable from a 404,
        // so the sync could not tell "this file is gone" from "QBO is down" and
        // kept grinding through the rest of the run either way. Classify it at
        // the boundary like every other QBO response: 408/429/5xx become
        // QboRetryableError and stop the remaining attachment work.
        throw await qboResponseError(download, `QBO attachment download for purchase ${qbPurchaseId}`);
    }
    const bytes = Buffer.from(await download.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_ATTACHMENT_BYTES) {
        // The file exists in QBO but what came back is unusable.
        return "attachment-unavailable";
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
    const { count } = await prisma.expense.updateMany({
        where: { id: expense.id, receiptUrl: null },
        data: { receiptUrl: publicUrl },
    });
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
