import { NextResponse } from "next/server";
import { getFreshQBTokens, QBNotConnectedError } from "@/lib/quickbooks-payments";
import { createQBReceiptPurchase, type CreateQBReceiptPurchaseInput } from "@/lib/qbo-receipt-push";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Receipt bot -> QBO Purchase creation. Replaces the Apps Script's
 * email-to-QBO leg (see docs/apps-script/sendToQBOviaAPI.gs): ProBuild
 * creates the finalized Purchase directly, job-coded at the line level, with
 * the receipt file attached, so the bank feed shows a ready match. QBO stays
 * the source of record — this writes to REAL BOOKS.
 *
 * Kill switch is opt-IN (QBO_RECEIPT_PUSH_ENABLED === "true"), checked before
 * anything else — the opposite polarity of the QBO expense sync cron's
 * opt-out flag, because a missing env var must default to OFF for an
 * endpoint that writes the books.
 *
 * Auth: x-ingest-key header must equal RECEIPT_INGEST_SECRET (same contract
 * as receipt-ingest and qbo-expenses/sync).
 */

interface ReceiptPushLine { sku?: unknown; desc?: unknown; price?: unknown }
interface ReceiptPushGroup { category?: unknown; amount?: unknown; lines?: unknown }
interface ReceiptPushBody {
    fileId?: unknown;
    projectName?: unknown;
    docType?: unknown;
    vendor?: unknown;
    date?: unknown;
    invoice?: unknown;
    checkNumber?: unknown;
    memo?: unknown;
    totalAmount?: unknown;
    fileName?: unknown;
    groups?: unknown;
    fileBase64?: unknown;
    fileContentType?: unknown;
}

function normalizeGroups(raw: unknown): CreateQBReceiptPurchaseInput["groups"] {
    if (!Array.isArray(raw)) return [];
    return raw.map((g: ReceiptPushGroup) => ({
        category: typeof g?.category === "string" ? g.category : "General",
        amount: Number(g?.amount),
        lines: Array.isArray(g?.lines)
            ? (g.lines as ReceiptPushLine[]).map(l => ({
                sku: typeof l?.sku === "string" ? l.sku : undefined,
                desc: typeof l?.desc === "string" ? l.desc : undefined,
                price: typeof l?.price === "string" || typeof l?.price === "number" ? l.price : undefined,
            }))
            : undefined,
    }));
}

export async function POST(req: Request) {
    // Opt-in kill switch, checked before anything else.
    if (process.env.QBO_RECEIPT_PUSH_ENABLED !== "true") {
        return NextResponse.json({ ok: false, reason: "push-disabled" }, { status: 503 });
    }

    const secret = process.env.RECEIPT_INGEST_SECRET;
    if (!secret || req.headers.get("x-ingest-key") !== secret) {
        return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
    }

    let body: ReceiptPushBody;
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ ok: false, reason: "invalid-json" }, { status: 400 });
    }

    const groups = normalizeGroups(body.groups);
    if (
        typeof body.fileId !== "string" || !body.fileId ||
        typeof body.projectName !== "string" || !body.projectName ||
        groups.length === 0
    ) {
        return NextResponse.json({ ok: false, reason: "missing-fields" }, { status: 400 });
    }

    let tokens;
    try {
        tokens = await getFreshQBTokens();
    } catch (error) {
        if (error instanceof QBNotConnectedError) {
            return NextResponse.json({ ok: false, reason: "quickbooks-not-connected" }, { status: 503 });
        }
        console.error("QBO receipt push token fetch failed", error instanceof Error ? error.name : "UnknownError");
        return NextResponse.json({ ok: false, reason: "push-failed" }, { status: 500 });
    }

    try {
        const input: CreateQBReceiptPurchaseInput = {
            projectName: body.projectName,
            fileId: body.fileId,
            groups,
            docType: typeof body.docType === "string" ? body.docType : undefined,
            vendor: typeof body.vendor === "string" ? body.vendor : undefined,
            date: typeof body.date === "string" ? body.date : undefined,
            invoice: typeof body.invoice === "string" ? body.invoice : undefined,
            checkNumber: typeof body.checkNumber === "string" ? body.checkNumber : undefined,
            memo: typeof body.memo === "string" ? body.memo : undefined,
            totalAmount: Number(body.totalAmount),
            fileName: typeof body.fileName === "string" ? body.fileName : undefined,
            fileBase64: typeof body.fileBase64 === "string" ? body.fileBase64 : undefined,
            fileContentType: typeof body.fileContentType === "string" ? body.fileContentType : undefined,
        };

        // { ok: false } results (project-not-matched, amount-mismatch) map to
        // 200 — the Apps Script treats non-200 as retryable and ok:false as
        // terminal, same convention as sendToProBuild.txt.
        const result = await createQBReceiptPurchase(tokens, input);
        return NextResponse.json(result);
    } catch (error) {
        console.error("QBO receipt push failed", error instanceof Error ? error.name : "UnknownError");
        return NextResponse.json({ ok: false, reason: "push-failed" }, { status: 500 });
    }
}
