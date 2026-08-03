import { NextResponse } from "next/server";
import { getFreshQBTokens, QBNotConnectedError } from "@/lib/quickbooks-payments";
import { logAutomationEvent, type AutomationEventInput } from "@/lib/automation-events";
import { isPaused, PAUSE_KEYS } from "@/lib/automation-settings";
import {
    createQBReceiptPurchase,
    QboAccountConfigError,
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
interface ReceiptPushGroup { category?: unknown; amount?: unknown; lines?: unknown; tax?: unknown }
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
    overheadCategory?: unknown;
}

function normalizeGroups(raw: unknown): CreateQBReceiptPurchaseInput["groups"] {
    if (!Array.isArray(raw)) return [];
    return raw.map((g: ReceiptPushGroup) => ({
        category: typeof g?.category === "string" ? g.category : "General",
        amount: Number(g?.amount),
        // Strict === true: only an explicit boolean routes money to the tax
        // account — truthy strings ("false", "0") must never move a line.
        tax: g?.tax === true,
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
        overheadCategory: typeof body.overheadCategory === "string" ? body.overheadCategory : undefined,
    };
}

export interface QboReceiptCreateHandlerDependencies {
    getIngestSecret(): string | undefined;
    isPushEnabled(): boolean;
    getFreshTokens(): Promise<QBTokens>;
    createPurchase(tokens: QBTokens, input: CreateQBReceiptPurchaseInput): Promise<CreateQBReceiptPurchaseResult>;
    /** Fire-and-forget audit row for the Automation Command Center. Optional so tests need not stub it. */
    logEvent?: (event: AutomationEventInput) => void | Promise<void>;
    /** Command Center pause switch (pause-only; env stays the opt-in master). Optional for tests. */
    isPushPaused?: () => Promise<boolean>;
}

/** Command-center audit: one event per authenticated push attempt. */
function pushEventFromOutcome(
    input: CreateQBReceiptPurchaseInput,
    outcome: { status: "created" | "already-exists" | "fallback" | "error"; reason?: string },
): AutomationEventInput {
    const taxCents = input.groups
        .filter(g => g.tax === true && Number.isFinite(g.amount))
        .reduce((sum, g) => sum + Math.round(g.amount * 100), 0);
    return {
        kind: "receipt-push",
        status: outcome.status,
        reason: outcome.reason,
        source: "apps-script",
        vendor: input.vendor,
        projectName: input.projectName,
        docNumber: input.fileId ? input.fileId.slice(0, 21) : undefined,
        fileName: input.fileName,
        amountCents: Number.isFinite(input.totalAmount) ? Math.round(input.totalAmount * 100) : undefined,
        taxCents: taxCents > 0 ? taxCents : undefined,
    };
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

            // Input + logger BEFORE token fetch so token failures are audited
            // too — "one event per authenticated push attempt" must include
            // the attempts QBO connectivity killed. The logger is isolated
            // here so an injected implementation that REJECTS can never
            // divert the money path into an error branch.
            const rawLog = dependencies.logEvent ?? logAutomationEvent;
            const logEvent = async (event: AutomationEventInput) => {
                try { await rawLog(event); } catch (error) {
                    console.error("push audit log failed", error instanceof Error ? error.name : "UnknownError");
                }
            };
            const input = buildInput(body, groups);

            // Command Center pause: terminal ok:false so the bot books via the
            // email path while paused — receipts keep flowing, just not
            // hands-free. Checked AFTER validation so the paused attempt is
            // AUDITED as a fallback (otherwise paused traffic would vanish
            // from the intake graph and inflate the hands-free rate).
            const isPushPausedFn = dependencies.isPushPaused ?? (() => isPaused(PAUSE_KEYS.receiptPush));
            if (await isPushPausedFn()) {
                const event = pushEventFromOutcome(input, { status: "fallback", reason: "push-paused" });
                event.detail = { fileId: input.fileId };
                await logEvent(event);
                return NextResponse.json({ ok: false, reason: "push-paused" });
            }

            let tokens: QBTokens;
            try {
                tokens = await dependencies.getFreshTokens();
            } catch (error) {
                if (error instanceof QBNotConnectedError) {
                    await logEvent(pushEventFromOutcome(input, { status: "error", reason: "quickbooks-not-connected" }));
                    return NextResponse.json({ ok: false, reason: "quickbooks-not-connected" }, { status: 503 });
                }
                // Token refresh failures are transient (QBO outage, network) —
                // retryable, so this is the one case that stays 500.
                console.error("QBO receipt push token fetch failed", error instanceof Error ? error.name : "UnknownError");
                await logEvent(pushEventFromOutcome(input, { status: "error", reason: "token-fetch-failed" }));
                return NextResponse.json({ ok: false, reason: "push-failed" }, { status: 500 });
            }
            try {
                // Deterministic outcomes (project-not-matched, amount-mismatch,
                // missing-vendor, invalid-date, docnumber-conflict, duplicate-name,
                // ...) come back as ok:false here and are forwarded as 200 — the
                // Apps Script treats ok:false as terminal, same convention as
                // sendToProBuild.txt.
                const result = await dependencies.createPurchase(tokens, input);
                const event = pushEventFromOutcome(input, result.ok
                    ? { status: result.alreadyExists ? "already-exists" : "created" }
                    : { status: "fallback", reason: result.reason });
                // Full ids for the Command Center's validation panel: the Drive
                // file link needs the WHOLE fileId (docNumber is a 21-char
                // prefix) and the QBO deep link needs the purchase id.
                event.detail = {
                    fileId: input.fileId,
                    ...(result.ok ? { qbPurchaseId: result.qbPurchaseId } : {}),
                    // Attachment evidence AT BOOKING TIME (fresh creates only —
                    // already-exists responses don't re-report it).
                    ...(result.ok && !result.alreadyExists ? { attachment: result.attachment } : {}),
                };
                await logEvent(event);
                return NextResponse.json(result);
            } catch (error) {
                if (error instanceof QboAccountConfigError) {
                    // Deterministic misconfiguration (missing/wrong-type/
                    // colliding account ids) — the SAME failure would repeat on
                    // every retry, so it must be terminal (bot books via the
                    // email path) rather than a 500 retry loop that strands
                    // every receipt until someone notices.
                    console.error("QBO receipt push account misconfiguration", error.message);
                    await logEvent(pushEventFromOutcome(input, { status: "fallback", reason: "account-misconfigured" }));
                    return NextResponse.json({ ok: false, reason: "account-misconfigured" });
                }
                if (error instanceof QboPurchaseFaultError) {
                    // A QBO business-rule rejection (400/403) is terminal, not
                    // transient — 200/ok:false with the fault code, never a retry loop.
                    console.error("QBO receipt push business fault", error.status, error.faultCode ?? "unknown");
                    await logEvent(pushEventFromOutcome(input, { status: "fallback", reason: `qbo-fault:${error.faultCode ?? error.status}` }));
                    return NextResponse.json({ ok: false, reason: "qbo-fault", detail: error.faultCode ?? String(error.status) });
                }
                // Network errors, QBO 429/5xx, DB errors — genuinely transient.
                console.error("QBO receipt push failed", error instanceof Error ? error.name : "UnknownError");
                await logEvent(pushEventFromOutcome(input, { status: "error", reason: error instanceof Error ? error.name : "UnknownError" }));
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
