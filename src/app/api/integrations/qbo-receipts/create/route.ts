import { NextResponse } from "next/server";
import { getFreshQBTokens, QBNotConnectedError } from "@/lib/quickbooks-payments";
import { logAutomationEvent, type AutomationEventInput } from "@/lib/automation-events";
import { isPaused, PAUSE_KEYS } from "@/lib/automation-settings";
import {
    createQBReceiptPurchase,
    QboAccountConfigError,
    QboPurchaseFaultError,
    isRetryableQboError,
    type CreateQBReceiptPurchaseInput,
    type CreateQBReceiptPurchaseResult,
} from "@/lib/qbo-receipt-push";
import {
    isQBTimeoutError,
    isQBBudgetExhaustedError,
    createRouteDeadline,
    type QBTokens,
} from "@/lib/quickbooks";

/**
 * Whole-request budget, under the 60s route ceiling. Every QBO call this push
 * makes is capped by what is LEFT of it, so a run of individually-legal calls
 * cannot add up past the ceiling and get the function killed mid-write with
 * nothing recorded.
 */
export const RECEIPT_PUSH_BUDGET_MS = 50_000;

export const dynamic = "force-dynamic";
// Stays at 60. A single push does a lot of SERIAL QBO work on a healthy day —
// project/vendor/customer lookups, the customer and vendor ensures, the
// account-identity verify, the Purchase create, then the attachment upload —
// and the token refresh alone is allowed 45s. Trimming the ceiling would start
// killing legitimately slow pushes. The fix for the outage case is the
// per-request deadline in qbTimedFetch, which now fails fast on its own; the
// ceiling is only the backstop behind it.
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

/**
 * Command-center audit: one event per authenticated push attempt.
 *
 * Every call site sits AFTER auth + body validation succeed (`input.fileId`
 * is always a real string by then), so `detail.fileId` is baked in here once
 * rather than re-added at each call site — that is how every logged outcome
 * on this path ends up carrying the FULL Drive fileId, never just the
 * 21-char `docNumber` prefix (which two different fileIds can share).
 * Unauthorized and invalid-body requests never reach this function — there
 * is no trusted file id yet at that point — so they are correctly excluded
 * from this guarantee (see the early-return checks above, which log nothing).
 */
/**
 * A Purchase that posted but carries no receipt image.
 *
 * The upload can fail terminally (a QBO Fault, a hard 4xx) or be skipped
 * (unsupported type, corrupt base64, oversized). Retrying those forever is
 * pointless — but logging them as a plain "created"/"already-exists" was worse:
 * the bot moved on, health counted a healthy booking, and the receipt was
 * silently missing from the books with nothing to alert on. This status keeps
 * the booking terminal (no retry loop) while making it visible and stopping it
 * from refreshing receipt freshness.
 */
export const ATTACHMENT_FAILED_STATUS = "attachment-failed";

/** Did this outcome actually get the receipt image into QuickBooks? */
export function attachmentSucceeded(attachment: string | undefined): boolean {
    return attachment === "attached" || attachment === "already-attached";
}

function pushEventFromOutcome(
    input: CreateQBReceiptPurchaseInput,
    outcome: { status: "created" | "already-exists" | "fallback" | "error" | "attachment-failed"; reason?: string },
    detail?: Record<string, unknown>,
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
        detail: { fileId: input.fileId, ...detail },
    };
}

export function createQboReceiptCreateHandlers(dependencies: QboReceiptCreateHandlerDependencies) {
    return {
        async POST(request: Request) {
            // Auth first so a bad key is always a 401 (alertable misconfig),
            // then the opt-in kill switch. push-disabled is deterministic —
            // 200/ok:false, not a 503: it is expected steady-state until the
            // feature is turned on, and the Apps Script must not retry it forever.
            // Unauthorized and malformed/incomplete-body requests return here
            // WITHOUT logging an event and are deliberately excluded from the
            // "every logged outcome carries fileId" guarantee below — there is
            // no trusted file id to log yet (a bad actor could claim any
            // fileId in an unauthenticated or unvalidated body).
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
                await logEvent(pushEventFromOutcome(input, { status: "fallback", reason: "push-paused" }));
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
                if (isQBTimeoutError(error)) {
                    await logEvent(pushEventFromOutcome(input, { status: "error", reason: "qbo-timeout" }));
                    return NextResponse.json({ ok: false, retry: true, reason: "qbo-timeout" }, { status: 503 });
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
                // A booking whose receipt never made it is reported as
                // attachment-failed, not as a clean create — see
                // ATTACHMENT_FAILED_STATUS.
                const bookedWithoutReceipt = result.ok && !attachmentSucceeded(result.attachment);
                const event = pushEventFromOutcome(
                    input,
                    result.ok
                        ? bookedWithoutReceipt
                            ? { status: ATTACHMENT_FAILED_STATUS, reason: result.attachment }
                            : { status: result.alreadyExists ? "already-exists" : "created" }
                        : { status: "fallback", reason: result.reason },
                    {
                        // The QBO deep link needs the purchase id (fileId is
                        // already baked into `detail` by pushEventFromOutcome).
                        ...(result.ok ? { qbPurchaseId: result.qbPurchaseId } : {}),
                        // Attachment evidence, now reported on BOTH ok branches:
                        // an already-exists response re-checks the Attachable and
                        // uploads if the first attempt's response was lost, so its
                        // outcome ("already-attached", "attached", "failed:...")
                        // is real evidence rather than a repeat of booking time.
                        ...(result.ok ? { attachment: result.attachment } : {}),
                    },
                );
                await logEvent(event);
                return NextResponse.json(result);
            } catch (error) {
                if (isQBTimeoutError(error)) {
                    // QBO is unreachable, not saying no — 503 so the Apps
                    // Script retries on its next pass instead of falling back
                    // to the email path. Safe to retry even if the create did
                    // land: it carries a QBO `requestid` idempotency key and
                    // the docNumber pre-check returns already-exists.
                    console.error("QBO receipt push timed out", error.message);
                    await logEvent(pushEventFromOutcome(input, { status: "error", reason: "qbo-timeout" }));
                    return NextResponse.json({ ok: false, retry: true, reason: "qbo-timeout" }, { status: 503 });
                }
                if (isQBBudgetExhaustedError(error)) {
                    // Out of time, not out of luck: 503 so the Apps Script
                    // retries on its next pass, same idempotency guarantees as
                    // the timeout branch.
                    console.error("QBO receipt push ran out of route budget");
                    await logEvent(pushEventFromOutcome(input, { status: "error", reason: "qbo-budget-exhausted" }));
                    return NextResponse.json({ ok: false, retry: true, reason: "qbo-budget-exhausted" }, { status: 503 });
                }
                if (isRetryableQboError(error)) {
                    // 429/5xx/network, or a failed attachment step. Same
                    // reasoning and same idempotency guarantees as the timeout
                    // branch: retry beats banking a half-finished receipt.
                    console.error("QBO receipt push hit a retryable failure", error instanceof Error ? error.message : "unknown");
                    await logEvent(pushEventFromOutcome(input, { status: "error", reason: "qbo-unavailable" }));
                    return NextResponse.json({ ok: false, retry: true, reason: "qbo-unavailable" }, { status: 503 });
                }
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
    createPurchase: (tokens, input) =>
        createQBReceiptPurchase(tokens, input, {}, createRouteDeadline(RECEIPT_PUSH_BUDGET_MS)),
});

export async function POST(request: Request) {
    return handlers.POST(request);
}
