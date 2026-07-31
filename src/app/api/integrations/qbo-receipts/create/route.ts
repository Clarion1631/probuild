import { NextResponse } from "next/server";
import { getFreshQBTokens, QBNotConnectedError } from "@/lib/quickbooks-payments";
import {
    createQBReceiptPurchase,
    QboPurchaseFaultError,
    type CreateQBReceiptPurchaseInput,
    type CreateQBReceiptPurchaseResult,
} from "@/lib/qbo-receipt-push";
import type { QBTokens } from "@/lib/quickbooks";

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
 * as receipt-ingest and qbo-expenses/sync). 401 is the only auth-failure
 * status; every OTHER deterministic outcome (kill switch off, bad JSON,
 * missing fields, or a QBO business-rule fault) is a 200 with `ok:false` —
 * the Apps Script treats non-200 as retryable and needs those cases to be
 * terminal, not retried forever. 500 is reserved for genuinely transient
 * failures: network errors, QBO 429/5xx, token refresh, DB errors.
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

function buildInput(body: ReceiptPushBody, groups: CreateQBReceiptPurchaseInput["groups"]): CreateQBReceiptPurchaseInput {
    return {
        projectName: body.projectName as string,
        fileId: body.fileId as string,
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
}

export interface QboReceiptCreateHandlerDependencies {
    getIngestSecret(): string | undefined;
    isPushEnabled(): boolean;
    getFreshTokens(): Promise<QBTokens>;
    createPurchase(tokens: QBTokens, input: CreateQBReceiptPurchaseInput): Promise<CreateQBReceiptPurchaseResult>;
}

export function createQboReceiptCreateHandlers(dependencies: QboReceiptCreateHandlerDependencies) {
    return {
        async POST(request: Request) {
            // Auth first so a bad key is always a 401 (alertable misconfig),
            // then the opt-in kill switch. push-disabled is deterministic —
            // 200/ok:false, not a 503: it is expected steady-state until the
            // feature is turned on, and the Apps Script must not retry it forever.
            const secret = dependencies.getIngestSecret();
            if (!secret || request.headers.get("x-ingest-key") !== secret) {
                return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
            }
            if (!dependencies.isPushEnabled()) {
                return NextResponse.json({ ok: false, reason: "push-disabled" });
            }

            let body: ReceiptPushBody;
            try {
                body = await request.json();
            } catch {
                return NextResponse.json({ ok: false, reason: "invalid-json" });
            }

            const groups = normalizeGroups(body.groups);
            if (
                typeof body.fileId !== "string" || !body.fileId ||
                typeof body.projectName !== "string" || !body.projectName ||
                groups.length === 0
            ) {
                return NextResponse.json({ ok: false, reason: "missing-fields" });
            }

            let tokens: QBTokens;
            try {
                tokens = await dependencies.getFreshTokens();
            } catch (error) {
                if (error instanceof QBNotConnectedError) {
                    return NextResponse.json({ ok: false, reason: "quickbooks-not-connected" }, { status: 503 });
                }
                // Token refresh failures are transient (QBO outage, network) —
                // retryable, so this is the one case that stays 500.
                console.error("QBO receipt push token fetch failed", error instanceof Error ? error.name : "UnknownError");
                return NextResponse.json({ ok: false, reason: "push-failed" }, { status: 500 });
            }

            try {
                const input = buildInput(body, groups);
                // Deterministic outcomes (project-not-matched, amount-mismatch,
                // missing-vendor, invalid-date, docnumber-conflict, duplicate-name,
                // ...) come back as ok:false here and are forwarded as 200 — the
                // Apps Script treats ok:false as terminal, same convention as
                // sendToProBuild.txt.
                const result = await dependencies.createPurchase(tokens, input);
                return NextResponse.json(result);
            } catch (error) {
                if (error instanceof QboPurchaseFaultError) {
                    // A QBO business-rule rejection (400/403) is terminal, not
                    // transient — 200/ok:false with the fault code, never a retry loop.
                    console.error("QBO receipt push business fault", error.status, error.faultCode ?? "unknown");
                    return NextResponse.json({ ok: false, reason: "qbo-fault", detail: error.faultCode ?? String(error.status) });
                }
                // Network errors, QBO 429/5xx, DB errors — genuinely transient.
                console.error("QBO receipt push failed", error instanceof Error ? error.name : "UnknownError");
                return NextResponse.json({ ok: false, reason: "push-failed" }, { status: 500 });
            }
        },
    };
}

const handlers = createQboReceiptCreateHandlers({
    getIngestSecret: () => process.env.RECEIPT_INGEST_SECRET,
    isPushEnabled: () => process.env.QBO_RECEIPT_PUSH_ENABLED === "true",
    getFreshTokens: getFreshQBTokens,
    createPurchase: createQBReceiptPurchase,
});

export async function POST(request: Request) {
    return handlers.POST(request);
}
