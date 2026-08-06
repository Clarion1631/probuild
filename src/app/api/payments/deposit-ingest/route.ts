import { NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";
import type { DepositIngest } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { revalidatePath } from "next/cache";
import { findBestProjectNameMatches, normalizeWords } from "@/lib/project-match";
import { toNum } from "@/lib/prisma-helpers";
import { recordPaymentCore } from "@/lib/payment-record-core";
import { getFreshQBTokens, settleMilestoneFromQBPayment } from "@/lib/quickbooks-payments";
import { buildQBPaymentRequest, sendQBPaymentCreateRequest, type QBTokens } from "@/lib/quickbooks";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Deposit auto-apply pipeline (Phase B1). The GTR receipt bot classifies an
 * incoming check/deposit photo as `customer_payment`, does its own Gemini
 * extraction, and POSTs the metadata here — no photo bytes, one request per
 * Drive file. This endpoint owns ALL matching and money writes: it applies
 * the deposit against the one Pending milestone it uniquely matches, in
 * QuickBooks (if the milestone is QBO-linked) AND ProBuild, or files an
 * OfficeTask for a human when the match isn't clean.
 *
 * Auth: Authorization: Bearer ${DEPOSIT_INGEST_SECRET}. `/api/payments/*` is
 * already in the generic proxy bypass (src/proxy.ts), so this in-handler
 * Bearer check is the sole gate — fail closed (401) when the env var is
 * unset, exactly like /api/office-tasks/ingest.
 *
 * State machine (DepositIngest row, keyed by the Drive fileId):
 *   processing   — claimed, working the match (or a non-QBO apply, which has
 *                  no further boundary). Stale-claim re-claimable (5 min).
 *   qbo_unknown  — the QBO Payment create request was SENT (or is about to
 *                  be — the row's qbRequestPayload is persisted BEFORE the
 *                  network call fires) but the response was lost/timed out.
 *                  Recovery replays the byte-identical request with the same
 *                  requestid; Intuit returns the ORIGINAL response instead of
 *                  creating a duplicate Payment.
 *   qbo_created  — the QBO Payment exists (qbPaymentId set); ProBuild settle
 *                  is pending. Resume from settle.
 *   applied      — terminal success.
 *   unmatched    — terminal to the bot (an OfficeTask was filed). A human can
 *                  force a retry with ?force=1 after fixing the cause, UNLESS
 *                  the row already crossed the QBO boundary (never force-reset
 *                  those — reconcile manually instead).
 *   failed       — retryable, PRE-QBO-boundary failures only (a guard
 *                  rejection, QB not connected, ...). Any failure once the
 *                  QBO request begins goes to qbo_unknown, never failed.
 *   reconcile    — manual. Bounded retries (MAX_ATTEMPTS); on exhaustion or a
 *                  genuine post-settle conflict, files ONE OfficeTask.
 *
 * Reservation: a partial unique index on paymentScheduleId (see
 * scripts/apply-deposit-ingest-schema.mjs — not expressible in Prisma) stops
 * two different deposit files from claiming the same pending milestone. The
 * loser's reservation attempt hits the unique violation and goes unmatched.
 */

const MAX_ATTEMPTS = 8; // like the notification outbox (src/lib/payment-outbox.ts)
const STALE_PROCESSING_MS = 5 * 60_000;
const OPEN_INVOICE_STATUSES = ["Issued", "Overdue", "Partially Paid"]; // matches src/lib/open-invoices-report.ts's canon

interface NormalizedPayload {
    fileId: string;
    fileUrl: string | null;
    fileName: string | null;
    projectName: string;
    payerName: string | null;
    amount: number;
    checkDate: string | null; // YYYY-MM-DD, validated separately (required, but not a 400 — see below)
    checkNumber: string | null; // required, but not a 400 — see below
    memo: string | null;
}

interface MatchedSchedule {
    id: string;
    invoiceId: string;
    qbInvoiceId: string | null;
    invoiceCode: string;
}

export async function POST(req: Request) {
    const secret = process.env.DEPOSIT_INGEST_SECRET;
    if (!secret) {
        console.error("DEPOSIT_INGEST_SECRET is not configured");
        return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
    }
    // Hash both sides to fixed length so timingSafeEqual is usable regardless of
    // header length — removes the string-compare timing side channel.
    const authHeader = req.headers.get("authorization") ?? "";
    const expectedDigest = createHash("sha256").update(`Bearer ${secret}`).digest();
    const gotDigest = createHash("sha256").update(authHeader).digest();
    if (!timingSafeEqual(expectedDigest, gotDigest)) {
        return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
    }

    let raw: Record<string, unknown>;
    try {
        raw = await req.json();
    } catch {
        return NextResponse.json({ ok: false, reason: "invalid-json" }, { status: 400 });
    }
    // JSON `null`/arrays parse fine but aren't a payload — 400, not a 500 from field access.
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        return NextResponse.json({ ok: false, reason: "invalid-json" }, { status: 400 });
    }

    const fileId = String(raw.fileId ?? "").trim();
    const projectName = String(raw.projectName ?? "").trim();
    const rawAmount = Number(raw.amount);
    // Hard 400s: without these, there's no row to claim and nothing to match against.
    // checkDate/checkNumber are ALSO required but are deliberately NOT 400s — the bot's
    // Gemini extraction can legitimately come back incomplete, and that's an `unmatched`
    // outcome (with an OfficeTask), not a request the bot needs to special-case.
    if (!fileId || fileId.length > 200) return NextResponse.json({ ok: false, reason: "fileId is required (max 200 chars)" }, { status: 400 });
    if (!projectName || projectName.length > 300) return NextResponse.json({ ok: false, reason: "projectName is required (max 300 chars)" }, { status: 400 });
    if (!Number.isFinite(rawAmount) || rawAmount <= 0) {
        return NextResponse.json({ ok: false, reason: "amount must be a positive number" }, { status: 400 });
    }
    // Money is cents-exact: a 3-decimal extraction (100.005) would pass the epsilon
    // match yet reach QBO unrounded. Normalize once, reject anything not representable.
    const amountCents = Math.round(rawAmount * 100);
    if (Math.abs(rawAmount * 100 - amountCents) > 1e-6 || amountCents <= 0) {
        return NextResponse.json({ ok: false, reason: "amount must have at most 2 decimal places" }, { status: 400 });
    }
    const amount = amountCents / 100;

    const payload: NormalizedPayload = {
        fileId,
        projectName,
        amount,
        fileUrl: typeof raw.fileUrl === "string" && raw.fileUrl.trim() ? raw.fileUrl.trim() : null,
        fileName: typeof raw.fileName === "string" && raw.fileName.trim() ? raw.fileName.trim() : null,
        payerName: typeof raw.payerName === "string" && raw.payerName.trim() ? raw.payerName.trim() : null,
        checkDate: typeof raw.checkDate === "string" ? raw.checkDate.trim() : null,
        checkNumber: typeof raw.checkNumber === "string" && raw.checkNumber.trim() ? raw.checkNumber.trim() : null,
        memo: typeof raw.memo === "string" && raw.memo.trim() ? raw.memo.trim() : null,
    };

    const force = new URL(req.url).searchParams.get("force") === "1";

    // ── Idempotency / claim ─────────────────────────────────────────────────
    let row = await prisma.depositIngest.findUnique({ where: { fileId } });
    let freshlyClaimed = false;

    if (!row) {
        try {
            row = await prisma.depositIngest.create({
                data: {
                    fileId,
                    status: "processing",
                    extracted: JSON.stringify(payload),
                    attempts: 1,
                    processingStartedAt: new Date(),
                },
            });
            freshlyClaimed = true;
        } catch (e: any) {
            if (e?.code !== "P2002") throw e;
            // Lost the create race to a concurrent duplicate request — fall through
            // to the existing-row handling below.
            row = await prisma.depositIngest.findUnique({ where: { fileId } });
        }
    }
    if (!row) {
        return NextResponse.json({ ok: false, reason: "claim-race" }, { status: 500 });
    }

    // ── Terminal states ──────────────────────────────────────────────────────
    if (row.status === "applied") {
        let invoiceCode: string | undefined;
        if (row.paymentScheduleId) {
            const s = await prisma.paymentSchedule.findUnique({
                where: { id: row.paymentScheduleId },
                select: { invoice: { select: { code: true } } },
            });
            invoiceCode = s?.invoice.code;
        }
        return NextResponse.json({
            ok: true, status: "applied", alreadyApplied: true,
            scheduleId: row.paymentScheduleId, qbPaymentId: row.qbPaymentId, invoiceCode,
        });
    }
    if (row.status === "reconcile") {
        // Heal a crash between the terminal write and the task create (see ensureReviewTask).
        const officeTaskId = row.officeTaskId ?? await ensureReviewTask(row, row.lastError ?? "reconcile", "reconcile");
        return NextResponse.json({ ok: true, status: "reconcile", reason: row.lastError, officeTaskId });
    }
    if (row.status === "unmatched" && !force) {
        const officeTaskId = row.officeTaskId ?? await ensureReviewTask(row, row.lastError ?? "unmatched", "unmatched");
        return NextResponse.json({ ok: true, status: "unmatched", reason: row.lastError, officeTaskId });
    }

    // ── Force-reset an unmatched row (human retry after fixing the cause) ──
    // Never force-reset a row that already crossed the QBO boundary — that money
    // decision needs a human looking at QuickBooks, not a silent re-run.
    if (row.status === "unmatched" && force) {
        if (row.qbPaymentId || row.qbRequestPayload) {
            return NextResponse.json({
                ok: true, status: "unmatched",
                reason: "cannot force-retry — this deposit already reached QuickBooks; reconcile it manually",
                officeTaskId: row.officeTaskId,
            });
        }
        const reclaimed = await prisma.depositIngest.updateMany({
            where: { id: row.id, status: "unmatched" },
            data: {
                status: "processing", extracted: JSON.stringify(payload),
                attempts: { increment: 1 }, processingStartedAt: new Date(),
                lastError: null, paymentScheduleId: null,
            },
        });
        if (reclaimed.count === 0) {
            const fresh = await prisma.depositIngest.findUnique({ where: { id: row.id } });
            return NextResponse.json({ ok: true, status: fresh?.status ?? "unmatched", reason: fresh?.lastError ?? null });
        }
        freshlyClaimed = true;
        row = (await prisma.depositIngest.findUnique({ where: { id: row.id } }))!;
    }

    // ── Stale-claim reclaim (worker died mid-flight) ────────────────────────
    // "failed" has no lease (nothing is actively in-flight for it) — always retryable.
    // processing/qbo_unknown/qbo_created only reclaim once the 5-minute lease is stale;
    // a fresh lease means another request is actively working this file right now.
    const inFlightStatuses = ["processing", "qbo_unknown", "qbo_created", "failed"];
    if (!freshlyClaimed && inFlightStatuses.includes(row.status)) {
        const needsLease = row.status !== "failed";
        const staleBefore = new Date(Date.now() - STALE_PROCESSING_MS);
        const preQbo = row.status === "processing" || row.status === "failed";
        const claim = await prisma.depositIngest.updateMany({
            where: {
                id: row.id, status: row.status,
                ...(needsLease ? { processingStartedAt: { lt: staleBefore } } : {}),
            },
            data: {
                // CAS failed→processing: leaving status as "failed" would let a second
                // concurrent retry match the same claim (failed has no lease) and both
                // would send QBO bodies under the same requestid. The winner takes a
                // fresh processing lease; the loser's status CAS fails.
                status: preQbo ? "processing" : row.status,
                attempts: { increment: 1 }, processingStartedAt: new Date(),
                // Pre-QBO retries restart from a clean slate: fresh payload AND a
                // released reservation, so matching re-runs end-to-end against current
                // inputs — a stale reservation must never survive a payload overwrite.
                // (A "processing"/"failed" row is pre-QBO-boundary by construction: the
                // status flips to qbo_unknown before qbRequestPayload is ever sent.)
                // qbo_unknown/qbo_created resumes deliberately replay the ORIGINAL
                // extracted values (see resumeFromQboUnknown/resumeFromQboCreated).
                ...(preQbo ? { extracted: JSON.stringify(payload), paymentScheduleId: null } : {}),
            },
        });
        if (claim.count > 0) {
            freshlyClaimed = true;
            row = (await prisma.depositIngest.findUnique({ where: { id: row.id } }))!;
        }
    }

    if (!freshlyClaimed) {
        // Someone else is actively working this file (fresh lease) — the bot's next
        // 10-minute run retries safely (idempotent by fileId). Re-read for the current
        // status: our snapshot can be stale (e.g. a failed→processing CAS we just lost).
        const current = await prisma.depositIngest.findUnique({ where: { id: row.id }, select: { status: true } });
        return NextResponse.json({ ok: true, status: current?.status ?? row.status, reason: "in progress — retry shortly" });
    }

    // `>` (not `>=`): the claim above just incremented attempts, so this value IS the
    // attempt number about to run — 1..MAX_ATTEMPTS execute, MAX+1 (a reclaim after a
    // crash mid-attempt-MAX) reconciles. The post-failure check in the catch below uses
    // `>=` because it runs AFTER the attempt completed. Together: at most MAX real runs.
    if (row.attempts > MAX_ATTEMPTS) {
        const crossedQboBoundary = !!row.qbPaymentId || !!row.qbRequestPayload;
        return await finalizeReconcile(
            row,
            `exceeded ${MAX_ATTEMPTS} retry attempts (last error: ${row.lastError ?? "none"})`,
            { nullReservation: !crossedQboBoundary },
        );
    }

    try {
        if (row.status === "qbo_created") return await resumeFromQboCreated(row);
        if (row.status === "qbo_unknown") return await resumeFromQboUnknown(row);
        return await matchAndApply(row, payload);
    } catch (e: any) {
        // Any exception that escapes this far is, by construction, one the QBO-crossing
        // steps (send, settle) didn't already handle internally — but re-read the row's
        // PERSISTED state rather than assume, since e.g. settleMilestoneFromQBPayment can
        // throw AFTER qbPaymentId was already committed (a real QuickBooks Payment exists).
        const message = e instanceof Error ? e.message : String(e);
        const fresh = (await prisma.depositIngest.findUnique({ where: { id: row.id } })) ?? row;
        const crossedQboBoundary = !!fresh.qbPaymentId || !!fresh.qbRequestPayload;
        if (fresh.attempts >= MAX_ATTEMPTS) {
            return await finalizeReconcile(fresh, message, { nullReservation: !crossedQboBoundary });
        }
        const retryStatus = !crossedQboBoundary ? "failed" : fresh.qbPaymentId ? "qbo_created" : "qbo_unknown";
        await prisma.depositIngest.updateMany({
            // Conditioned on an active status: a throw AFTER a terminal write (e.g. the
            // review-task transaction hiccuping post-finalize) must never regress
            // applied/unmatched/reconcile back into the retry loop.
            where: { id: fresh.id, status: { in: ["processing", "qbo_unknown", "qbo_created", "failed"] } },
            data: {
                status: retryStatus, lastError: message.slice(0, 1000),
                // Entering "failed" leaves the reservation index — release the milestone
                // explicitly so the row can't shadow-hold it un-indexed (the retry
                // re-matches and re-reserves from scratch).
                ...(retryStatus === "failed" ? { paymentScheduleId: null } : {}),
            },
        });
        return NextResponse.json({ ok: false, status: retryStatus, reason: message });
    }
}

// ── Matching + apply ─────────────────────────────────────────────────────────

async function matchAndApply(row: DepositIngest, payload: NormalizedPayload): Promise<NextResponse> {
    let schedule: MatchedSchedule | null = null;

    if (row.paymentScheduleId) {
        // A prior crashed attempt already reserved a schedule — resume with THAT
        // reservation rather than re-matching (state may have moved since).
        schedule = await loadMatchedSchedule(row.paymentScheduleId);
        if (!schedule) {
            return await finalizeReconcile(row, "reserved milestone no longer exists", {});
        }
    } else {
        if (!payload.checkNumber) {
            return await finalizeUnmatched(row, "missing check number");
        }
        if (!isValidCheckDate(payload.checkDate)) {
            return await finalizeUnmatched(row, "missing or invalid check date");
        }

        const projects = await prisma.project.findMany({
            select: { id: true, name: true, client: { select: { name: true } } },
        });
        const projectMatches = findBestProjectNameMatches(payload.projectName, projects);
        if (projectMatches.length !== 1) {
            return await finalizeUnmatched(row, projectMatches.length === 0
                ? `no project matched "${payload.projectName}"`
                : `"${payload.projectName}" matched ${projectMatches.length} projects — ambiguous`);
        }
        const project = projectMatches[0];

        // Conservative gross-conflict check only: the Drive-folder project match is
        // authoritative, the payer line is corroboration. Skip when there's nothing
        // meaningful to compare (short/empty names on either side).
        if (payload.payerName) {
            const payerWords = normalizeWords(payload.payerName).filter(w => w.length > 2);
            const clientWords = normalizeWords(project.client.name).filter(w => w.length > 2);
            if (payerWords.length > 0 && clientWords.length > 0 && !payerWords.some(w => clientWords.includes(w))) {
                return await finalizeUnmatched(row, `payer "${payload.payerName}" shares no name with client "${project.client.name}"`);
            }
        }

        // Crash recovery for the non-QBO path: a prior attempt may have SETTLED the
        // milestone (recordPaymentCore committed) and died before the "applied" write —
        // and the pre-QBO reclaim then released the reservation, so this retry arrives
        // with no pointer to it. The physical check is identified by project + check
        // number + amount: a Paid milestone bearing exactly those IS our earlier
        // attempt. This runs BEFORE Pending matching so the deposit can never re-apply
        // to a different (later-added) same-amount milestone.
        const priorSettle = await prisma.paymentSchedule.findFirst({
            where: {
                status: "Paid", paymentMethod: "check", referenceNumber: payload.checkNumber,
                invoice: { projectId: project.id },
            },
            select: { id: true, amount: true, invoice: { select: { code: true } } },
        });
        if (priorSettle && Math.abs(toNum(priorSettle.amount) - payload.amount) <= 0.005) {
            try {
                await prisma.depositIngest.update({
                    where: { id: row.id },
                    data: { status: "applied", paymentScheduleId: priorSettle.id, lastError: null },
                });
            } catch (e: any) {
                if (e?.code !== "P2002") throw e;
                // Another deposit row terminally holds this schedule — this file is a
                // second photo of an already-applied check, not a recovery of our own.
                return await finalizeUnmatched(row, `check #${payload.checkNumber} was already applied via another deposit file`);
            }
            return NextResponse.json({
                ok: true, status: "applied", recovered: true,
                scheduleId: priorSettle.id, invoiceCode: priorSettle.invoice.code,
            });
        }

        const candidates = await prisma.paymentSchedule.findMany({
            where: { status: "Pending", invoice: { projectId: project.id, status: { in: OPEN_INVOICE_STATUSES } } },
            select: { id: true, amount: true, invoiceId: true, qbInvoiceId: true, invoice: { select: { code: true } } },
        });
        const amountMatches = candidates.filter(c => Math.abs(toNum(c.amount) - payload.amount) <= 0.005);
        if (amountMatches.length !== 1) {
            return await finalizeUnmatched(row, amountMatches.length === 0
                ? `no pending milestone on "${project.name}" matches $${payload.amount}`
                : `${amountMatches.length} pending milestones on "${project.name}" match $${payload.amount} — ambiguous`);
        }
        const picked = amountMatches[0];

        // Reserve — the partial unique index (scripts/apply-deposit-ingest-schema.mjs)
        // stops a second deposit file from claiming the same milestone concurrently.
        try {
            await prisma.depositIngest.update({ where: { id: row.id }, data: { paymentScheduleId: picked.id } });
        } catch (e: any) {
            if (e?.code === "P2002") {
                return await finalizeUnmatched(row, "milestone already being applied by another deposit");
            }
            throw e;
        }
        schedule = { id: picked.id, invoiceId: picked.invoiceId, qbInvoiceId: picked.qbInvoiceId, invoiceCode: picked.invoice.code };
    }

    return schedule.qbInvoiceId
        ? await applyQboLinked(row, schedule, payload)
        : await applyNonQbo(row, schedule, payload);
}

async function applyNonQbo(row: DepositIngest, schedule: MatchedSchedule, payload: NormalizedPayload): Promise<NextResponse> {
    const paymentDate = parseCheckDateLocalMidnight(payload.checkDate!);
    const result = await recordPaymentCore(schedule.id, schedule.invoiceId, {
        paymentDate, method: "check", referenceNumber: payload.checkNumber, notes: payload.memo,
    });
    if (!result.success) {
        // Idempotent-retry check: if the milestone is ALREADY paid with OUR OWN check
        // number/method, an earlier attempt of THIS deposit won the claim and we just
        // crashed before recording "applied" — that's success, not a conflict.
        const fresh = await prisma.paymentSchedule.findUnique({
            where: { id: schedule.id },
            select: { status: true, paymentMethod: true, referenceNumber: true },
        });
        const isOurs = fresh?.status === "Paid" && fresh.paymentMethod === "check" && fresh.referenceNumber === payload.checkNumber;
        if (!isOurs) {
            return await finalizeReconcile(row, `ProBuild settle failed: ${result.error}`, { nullReservation: true });
        }
    }
    await prisma.depositIngest.update({ where: { id: row.id }, data: { status: "applied", lastError: null } });
    return NextResponse.json({ ok: true, status: "applied", scheduleId: schedule.id, invoiceCode: schedule.invoiceCode });
}

async function applyQboLinked(row: DepositIngest, schedule: MatchedSchedule, payload: NormalizedPayload): Promise<NextResponse> {
    const tokens = await getFreshQBTokens(); // throws QBNotConnectedError → top-level catch → "failed" (pre-QBO, no boundary crossed)

    const built = await buildQBPaymentRequest(tokens, schedule.qbInvoiceId!, {
        amount: payload.amount,
        txnDate: payload.checkDate!,
        paymentRefNum: payload.checkNumber!,
    });
    if (!built.ok) {
        throw new Error(`QuickBooks guard failed (${built.reason}) for invoice ${schedule.invoiceCode}`);
    }

    // Persist the EXACT bytes BEFORE the network call fires — a crash/timeout on the
    // send still leaves the row able to replay byte-identically with the same requestid.
    await prisma.depositIngest.update({
        where: { id: row.id },
        data: { status: "qbo_unknown", qbRequestPayload: built.requestBody },
    });

    const requestId = depositRequestId(payload.fileId);
    return await sendAndSettle(row.id, schedule, {
        checkDate: payload.checkDate!, checkNumber: payload.checkNumber!, requestId, requestBody: built.requestBody,
    }, tokens);
}

async function resumeFromQboUnknown(row: DepositIngest): Promise<NextResponse> {
    const schedule = await loadMatchedSchedule(row.paymentScheduleId!);
    if (!schedule) return await finalizeReconcile(row, "reserved milestone no longer exists", {});
    const extracted = JSON.parse(row.extracted) as NormalizedPayload;

    let tokens: QBTokens;
    try {
        tokens = await getFreshQBTokens();
    } catch (e: any) {
        // Stay qbo_unknown — a brief QB outage doesn't downgrade the state (the
        // original send may or may not have gone through).
        await prisma.depositIngest.updateMany({
            where: { id: row.id, status: "qbo_unknown" },
            data: { lastError: String(e?.message ?? e).slice(0, 1000) },
        });
        return NextResponse.json({ ok: false, status: "qbo_unknown", reason: "QuickBooks unavailable" });
    }

    const requestId = depositRequestId(extracted.fileId);
    return await sendAndSettle(row.id, schedule, {
        checkDate: extracted.checkDate!, checkNumber: extracted.checkNumber!, requestId, requestBody: row.qbRequestPayload!,
    }, tokens);
}

async function resumeFromQboCreated(row: DepositIngest): Promise<NextResponse> {
    const schedule = await loadMatchedSchedule(row.paymentScheduleId!);
    if (!schedule) return await finalizeReconcile(row, "reserved milestone no longer exists", {});
    const extracted = JSON.parse(row.extracted) as NormalizedPayload;
    return await settleAndFinalize(row.id, schedule, {
        checkDate: extracted.checkDate!, checkNumber: extracted.checkNumber!, qbPaymentId: row.qbPaymentId!,
    });
}

async function sendAndSettle(
    rowId: string,
    schedule: MatchedSchedule,
    ctx: { checkDate: string; checkNumber: string; requestId: string; requestBody: string },
    tokens: QBTokens,
): Promise<NextResponse> {
    let paymentId: string;
    try {
        const sent = await sendQBPaymentCreateRequest(tokens, ctx.requestBody, ctx.requestId);
        paymentId = sent.paymentId;
    } catch (e: any) {
        // Response lost/timed out — stay qbo_unknown. The row already holds the exact
        // bytes sent, so the next request with this fileId replays byte-identically via
        // the same requestid; Intuit returns the ORIGINAL Payment instead of a duplicate.
        const message = e instanceof Error ? e.message : String(e);
        await prisma.depositIngest.updateMany({
            where: { id: rowId, status: "qbo_unknown" },
            data: { lastError: message.slice(0, 1000) },
        });
        return NextResponse.json({ ok: false, status: "qbo_unknown", reason: message });
    }

    await prisma.depositIngest.update({
        where: { id: rowId },
        data: { status: "qbo_created", qbPaymentId: paymentId, lastError: null },
    });

    return await settleAndFinalize(rowId, schedule, { checkDate: ctx.checkDate, checkNumber: ctx.checkNumber, qbPaymentId: paymentId });
}

async function settleAndFinalize(
    rowId: string,
    schedule: MatchedSchedule,
    ctx: { checkDate: string; checkNumber: string; qbPaymentId: string },
): Promise<NextResponse> {
    const paidAt = new Date(`${ctx.checkDate}T12:00:00`);
    const settled = await settleMilestoneFromQBPayment({
        paymentScheduleId: schedule.id,
        invoiceId: schedule.invoiceId,
        qbPaymentId: ctx.qbPaymentId,
        paidAt,
        referenceNumber: ctx.checkNumber,
    });

    if (!settled) {
        // Lost the claim — success ONLY if a concurrent settle (the hourly cron polling
        // the payment we just created) landed with OUR SAME qbPaymentId; a different or
        // absent qbPaymentId is a genuine conflict that needs a human.
        const fresh = await prisma.paymentSchedule.findUnique({ where: { id: schedule.id }, select: { qbPaymentId: true } });
        if (fresh?.qbPaymentId !== ctx.qbPaymentId) {
            const row = await prisma.depositIngest.findUnique({ where: { id: rowId } });
            if (!row) throw new Error("DepositIngest row vanished mid-settle");
            return await finalizeReconcile(row, "milestone settled with a different QuickBooks payment than this deposit created — reconcile manually", {});
        }
    }

    await prisma.depositIngest.update({ where: { id: rowId }, data: { status: "applied", lastError: null } });
    return NextResponse.json({ ok: true, status: "applied", scheduleId: schedule.id, invoiceCode: schedule.invoiceCode, qbPaymentId: ctx.qbPaymentId });
}

// ── Terminal-state helpers ───────────────────────────────────────────────────

// Terminal state is ALWAYS persisted before the review task is created: a crash
// between the two leaves a terminal row whose missing task is healed on the next
// re-POST (the terminal-state reads above call ensureReviewTask), whereas the
// reverse order would leave a NON-terminal row that re-runs the match on the next
// retry and files a duplicate task. A briefly-missing task is also visible
// elsewhere (the bot parks the file in _Needs Review); a duplicate would not be.
async function finalizeUnmatched(row: DepositIngest, reason: string): Promise<NextResponse> {
    // "unmatched" is not in the partial reservation index's status list, so this
    // transition releases any held milestone reservation by itself.
    await prisma.depositIngest.update({ where: { id: row.id }, data: { status: "unmatched", lastError: reason.slice(0, 1000) } });
    const officeTaskId = row.officeTaskId ?? await ensureReviewTask(row, reason, "unmatched");
    return NextResponse.json({ ok: true, status: "unmatched", reason, officeTaskId });
}

async function finalizeReconcile(row: DepositIngest, reason: string, opts: { nullReservation?: boolean }): Promise<NextResponse> {
    await prisma.depositIngest.update({
        where: { id: row.id },
        data: { status: "reconcile", lastError: reason.slice(0, 1000), ...(opts.nullReservation ? { paymentScheduleId: null } : {}) },
    });
    const officeTaskId = row.officeTaskId ?? await ensureReviewTask(row, reason, "reconcile");
    return NextResponse.json({ ok: true, status: "reconcile", reason, officeTaskId });
}

/** Create the ONE review task for a terminal row, tolerating crashes and concurrent
 *  healers: the task is created first, then claimed onto the row with an atomic
 *  officeTaskId-is-null update — a claim loser deletes its own just-created copy, so
 *  exactly one task survives no matter how many callers race. */
async function ensureReviewTask(row: DepositIngest, reason: string, kind: "unmatched" | "reconcile"): Promise<string | null> {
    // Never throws: callers run AFTER the terminal-state write, and an exception here
    // would fall into the outer catch — which must not touch terminal rows (and a
    // missing task self-heals on the next read anyway).
    try {
        const extracted = JSON.parse(row.extracted) as NormalizedPayload;
        const officeTaskId = await createDepositReviewTask(extracted, reason, kind);
        if (!officeTaskId) return null;
        const claim = await prisma.depositIngest.updateMany({
            where: { id: row.id, officeTaskId: null },
            data: { officeTaskId },
        });
        if (claim.count === 0) {
            await prisma.officeTask.delete({ where: { id: officeTaskId } }).catch(() => {});
            const fresh = await prisma.depositIngest.findUnique({ where: { id: row.id }, select: { officeTaskId: true } });
            return fresh?.officeTaskId ?? null;
        }
        return officeTaskId;
    } catch (e) {
        console.error("[deposit-ingest] review-task create failed (will heal on next read):", e);
        return null;
    }
}

/** Column-resolution + position logic inlined from src/app/api/office-tasks/ingest/route.ts. */
async function createDepositReviewTask(payload: NormalizedPayload, reason: string, kind: "unmatched" | "reconcile"): Promise<string | null> {
    const column = await prisma.officeBoardColumn.findFirst({ orderBy: [{ position: "asc" }, { createdAt: "asc" }] });
    if (!column) {
        console.error("No OfficeBoardColumn configured — cannot file deposit review task");
        return null;
    }
    const who = payload.payerName || payload.fileName || "deposit";
    const title = `Deposit needs review (${kind}): ${who} $${payload.amount}`.slice(0, 300);
    const notes = [
        `Reason: ${reason}`,
        payload.fileUrl ? `File: ${payload.fileUrl}` : null,
        `Extraction: ${JSON.stringify(payload)}`,
        `Source: deposit-ingest`,
    ].filter(Boolean).join("\n");

    const task = await prisma.$transaction(async (tx) => {
        const last = await tx.officeTask.findFirst({
            where: { columnId: column.id, archivedAt: null },
            orderBy: [{ position: "desc" }, { createdAt: "desc" }, { id: "desc" }],
            select: { position: true },
        });
        return tx.officeTask.create({
            data: {
                title, columnId: column.id, status: column.name,
                position: (last?.position ?? -1) + 1,
                notes, createdById: null,
            },
            select: { id: true },
        });
    });
    revalidatePath("/tasks");
    return task.id;
}

// ── Small helpers ────────────────────────────────────────────────────────────

async function loadMatchedSchedule(scheduleId: string): Promise<MatchedSchedule | null> {
    const s = await prisma.paymentSchedule.findUnique({
        where: { id: scheduleId },
        select: { id: true, invoiceId: true, qbInvoiceId: true, invoice: { select: { code: true } } },
    });
    if (!s) return null;
    return { id: s.id, invoiceId: s.invoiceId, qbInvoiceId: s.qbInvoiceId, invoiceCode: s.invoice.code };
}

/** Mirrors qbo-receipt-push.ts's receiptRequestId pattern: a stable hash of the
 *  full fileId, capped at QBO's 50-char requestid limit, namespaced so a
 *  deposit sharing a Drive fileId with anything else can never collide on
 *  QBO's server-side create idempotency key. */
function depositRequestId(fileId: string): string {
    return createHash("sha256").update(`deposit-${fileId}`).digest("hex").slice(0, 50);
}

/** Same round-trip validation qbo-receipt-push.ts's isValidCalendarDate uses. */
function isValidCheckDate(value: string | null): value is string {
    if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Strict YYYY-MM-DD → LOCAL midnight, matching actions.ts's parsePaymentDateInput
 *  (the value is already validated by isValidCheckDate before this is called). */
function parseCheckDateLocalMidnight(value: string): Date {
    const [y, mo, d] = value.split("-").map(Number);
    return new Date(y, mo - 1, d);
}
