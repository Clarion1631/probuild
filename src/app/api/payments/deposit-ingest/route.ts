import { NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";
import type { DepositIngest } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { revalidatePath } from "next/cache";
import { findBestProjectNameMatches, normalizeWords } from "@/lib/project-match";
import { toNum } from "@/lib/prisma-helpers";
import { recordPaymentCore } from "@/lib/payment-record-core";
import { parsePaymentDateInput } from "@/lib/payment-date";
import { getFreshQBTokens, settleMilestoneFromQBPayment } from "@/lib/quickbooks-payments";
import { buildQBPaymentRequest, sendQBPaymentCreateRequest, type QBTokens } from "@/lib/quickbooks";
import { toDepositReviewItem } from "@/lib/deposit-review";
import { withTxRetry } from "@/lib/tx-retry";
import { attributeDeposit, type MilestoneCandidate } from "@/lib/deposit-attribution";
import {
    BANK_APPLY_MIN_AGE_DAYS,
    BANK_DEPOSIT_SOURCE,
    BANK_DEPOSIT_TO_ACCOUNT_ID,
    BANK_IMAGE_SOURCE,
    CLAIMING_STATUSES,
    CROSS_SOURCE_CLAIM_WINDOW_DAYS,
    MONEY_BOUNDARY_CLAIM_STATUSES,
    TALLIED_SWEEP_STATUSES,
    PAID_UNION_WINDOW_DAYS,
    appliedTwinNote,
    bankCreditIsOldEnough,
    bankFileId,
    bankImageKeyPrefix,
    collisionNote,
    crossSourceClaimNote,
    describeCandidates,
    findCollisions,
    PROGRESS_CONFIDENCE,
    PROGRESS_WINDOW_DAYS,
    bankCreditFingerprint,
    booksWithoutOverride,
    isCustomerDepositClass,
    isDeterministicQboGuardFailure,
    isNotCustomerDepositReason,
    liveApplyEnabled,
    LIVE_APPLY_ENV_VAR,
    notCustomerDepositNote,
    requestedByInstant,
    isoDateToUtc,
    isoDaysAfter,
    isoDaysBefore,
    parseBankBatch,
    progressCorroboration,
    qboGuardNote,
    reservationLostNote,
    selectPayerBearingImage,
    sweepBatchOk,
    type BankCredit,
    type SweepCounts,
} from "@/lib/deposit-sweep";

export const dynamic = "force-dynamic";
// A bank batch processes its whole day sequentially in ONE invocation (capped
// at MAX_BANK_CREDITS_PER_BATCH), each credit potentially making two QuickBooks
// round trips. 30s left no headroom for a slow day; the runner's own timeout is
// larger still, so the server always gets to answer rather than the client
// abandoning a batch that is mid-money-write.
export const maxDuration = 60;

/**
 * Deposit auto-apply pipeline (Phase B1). The GTR receipt bot classifies an
 * incoming check/deposit photo as `customer_payment`, does its own Gemini
 * extraction, and POSTs the metadata here — no photo bytes, one request per
 * Drive file. This endpoint owns ALL matching and money writes: it applies
 * the deposit against the one Pending milestone it uniquely matches, in
 * QuickBooks (if the milestone is QBO-linked) AND ProBuild, or files an
 * OfficeTask for a human when the match isn't clean.
 *
 * TWO SOURCES, ONE STATE MACHINE (docs/plans/DEPOSIT-SWEEP-PLAN.md):
 *   - the PHOTO path above, one POST per Drive file; and
 *   - the DEPOSIT SWEEP, `{ source: "bank", ... }`, ONE POST per day carrying
 *     the complete day's Washington Trust credit rows plus the CSV's own
 *     control totals. It exists because a deposit that reaches the bank
 *     without ever being photographed used to sit unbooked indefinitely (the
 *     Hoppe check: 9 days, $13,447.68), and the QuickBooks API cannot see an
 *     unbooked deposit at all.
 * The bank branch reuses this file's claim/reservation/QBO/settle machinery
 * verbatim — see handleBankBatch. It adds NO money-write path; what it adds is
 * a stricter match (requested-only candidates, a 14-day Paid union, a
 * cross-source claim check, a 2-day wait) because a bank credit carries no
 * project name and no check number, only an amount.
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
 *   proposed     — BANK ROWS ONLY. The match resolved to exactly one milestone
 *                  but nothing was written to QuickBooks or ProBuild: either a
 *                  dry run (Phase A shadow week) or the credit is younger than
 *                  the 2-day wait. Terminal to the bot for today; the next
 *                  daily POST re-evaluates it as a replay. Holds no
 *                  reservation (it is outside the partial index's predicate)
 *                  but IS visible to the cross-source claim check.
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

/** The receipt bot can poll a deposit by Drive file ID. This read uses the
 * same bearer secret as ingest and only returns a sanitized review projection,
 * never the raw extraction snapshot or a QBO replay request body. */
export async function GET(req: Request) {
    const unauthorized = requireDepositIngestAuth(req);
    if (unauthorized) return unauthorized;

    const fileId = new URL(req.url).searchParams.get("fileId")?.trim() ?? "";
    if (!fileId || fileId.length > 200) {
        return NextResponse.json({ ok: false, reason: "invalid-file-id" }, { status: 400 });
    }
    const row = await prisma.depositIngest.findUnique({
        where: { fileId },
        select: {
            id: true, status: true, extracted: true, paymentScheduleId: true,
            qbPaymentId: true, officeTaskId: true, attempts: true, lastError: true,
            createdAt: true, updatedAt: true,
        },
    });
    if (!row) return NextResponse.json({ ok: false, reason: "not-found" }, { status: 404 });
    return NextResponse.json({ ok: true, deposit: toDepositReviewItem(row) });
}

export async function POST(req: Request) {
    const unauthorized = requireDepositIngestAuth(req);
    if (unauthorized) return unauthorized;

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

    // The deposit sweep's daily batch. Split BEFORE any photo-payload
    // validation: a bank batch has no fileId/projectName/amount of its own.
    if (raw.source === BANK_DEPOSIT_SOURCE) return await handleBankBatch(raw);

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

    // Persisted for BOTH sources so the cross-source claim check is an indexed
    // query in both directions (a photo row must be findable by the sweep, not
    // just the other way round). An unparseable checkDate leaves postDate null
    // — that row is already headed for `unmatched`.
    const photoColumns = {
        amountCents,
        postDate: isValidCheckDate(payload.checkDate) ? isoDateToUtc(payload.checkDate) : null,
    };

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
                    ...photoColumns,
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
        if (row.qbPaymentId || row.qbRequestPayload || row.settleStartedAt) {
            return NextResponse.json({
                ok: true, status: "unmatched",
                reason: "cannot force-retry — this deposit already crossed a money boundary (QuickBooks or a ProBuild settle); reconcile it manually",
                officeTaskId: row.officeTaskId,
            });
        }
        const reclaimed = await prisma.depositIngest.updateMany({
            where: { id: row.id, status: "unmatched" },
            data: {
                status: "processing", extracted: JSON.stringify(payload),
                attempts: { increment: 1 }, processingStartedAt: new Date(),
                lastError: null, paymentScheduleId: null, ...photoColumns,
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
        const retriable = row.status === "processing" || row.status === "failed";
        // Clean-slate ONLY before any money boundary: qbRequestPayload marks the QBO
        // boundary, settleStartedAt marks the non-QBO one. Once either is set, the
        // reservation and ORIGINAL extracted payload are preserved so recovery goes
        // through the exact reserved-row path (matchAndApply's reserved branch /
        // resumeFromQboUnknown) — never a heuristic re-match against a settle that
        // may already have committed.
        const boundaryMarked = !!(row.qbPaymentId || row.qbRequestPayload || row.settleStartedAt);
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
                status: retriable ? "processing" : row.status,
                attempts: { increment: 1 }, processingStartedAt: new Date(),
                // qbo_unknown/qbo_created resumes deliberately replay the ORIGINAL
                // extracted values (see resumeFromQboUnknown/resumeFromQboCreated).
                ...(retriable && !boundaryMarked ? { extracted: JSON.stringify(payload), paymentScheduleId: null, ...photoColumns } : {}),
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
        const crossedAnyBoundary = !!row.qbPaymentId || !!row.qbRequestPayload || !!row.settleStartedAt;
        return await finalizeReconcile(
            row,
            `exceeded ${MAX_ATTEMPTS} retry attempts (last error: ${row.lastError ?? "none"})`,
            { nullReservation: !crossedAnyBoundary },
        );
    }

    try {
        if (row.status === "qbo_created") return await resumeFromQboCreated(row);
        if (row.status === "qbo_unknown") return await resumeFromQboUnknown(row);
        return await matchAndApply(row, payload);
    } catch (e: any) {
        return await recordAttemptFailure(row, e);
    }
}

/**
 * Persist the outcome of an attempt that threw. Shared by the photo POST above
 * and the bank sweep's per-credit loop so both classify a failure the same way
 * — this is the money-boundary logic, and a second copy of it would drift.
 *
 * Any exception that reaches here is, by construction, one the QBO-crossing
 * steps (send, settle) didn't already handle internally — but re-read the row's
 * PERSISTED state rather than assume, since e.g. settleMilestoneFromQBPayment can
 * throw AFTER qbPaymentId was already committed (a real QuickBooks Payment exists).
 */
async function recordAttemptFailure(row: DepositIngest, e: unknown): Promise<NextResponse> {
    const message = e instanceof Error ? e.message : String(e);
    const fresh = (await prisma.depositIngest.findUnique({ where: { id: row.id } })) ?? row;
    const crossedQboBoundary = !!fresh.qbPaymentId || !!fresh.qbRequestPayload;
    const crossedAnyBoundary = crossedQboBoundary || !!fresh.settleStartedAt;
    if (fresh.attempts >= MAX_ATTEMPTS) {
        // Reservation survives exhaustion whenever ANY money boundary was crossed —
        // the reconcile human must see which milestone this deposit may have paid.
        return await finalizeReconcile(fresh, message, { nullReservation: !crossedAnyBoundary });
    }
    const retryStatus = !crossedQboBoundary ? "failed" : fresh.qbPaymentId ? "qbo_created" : "qbo_unknown";
    await prisma.depositIngest.updateMany({
        // Conditioned on an active status: a throw AFTER a terminal write (e.g. the
        // review-task transaction hiccuping post-finalize) must never regress
        // applied/unmatched/reconcile back into the retry loop.
        where: { id: fresh.id, status: { in: ["processing", "qbo_unknown", "qbo_created", "failed"] } },
        data: {
            status: retryStatus, lastError: message.slice(0, 1000),
            // Pre-boundary "failed" releases the milestone (NULL leaves the partial
            // index; that retry re-matches and re-reserves from scratch). Past the
            // NON-QBO boundary (settleStartedAt) the reservation is preserved — and
            // "failed" is in the index predicate, so the hold stays continuously
            // indexed and no second file can slip in before the retry resumes.
            ...(retryStatus === "failed" && !fresh.settleStartedAt ? { paymentScheduleId: null } : {}),
        },
    });
    return NextResponse.json({ ok: false, status: retryStatus, reason: message });
}

function requireDepositIngestAuth(req: Request): NextResponse | null {
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
    return null;
}

// ── Matching + apply ─────────────────────────────────────────────────────────

async function matchAndApply(row: DepositIngest, payload: NormalizedPayload): Promise<NextResponse> {
    let schedule: MatchedSchedule | null = null;

    if (row.paymentScheduleId) {
        // A prior crashed attempt already reserved a schedule — resume with THAT
        // reservation rather than re-matching (state may have moved since), and with
        // the PRESERVED original payload: the boundary-marked reclaim deliberately
        // kept row.extracted, and the settle (possibly already committed) used those
        // values — a re-extracted inbound payload must not shift the check number or
        // date mid-recovery.
        try {
            payload = JSON.parse(row.extracted) as NormalizedPayload;
        } catch {
            return await finalizeReconcile(row, "reserved row has unreadable extracted payload", {});
        }
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

        // Money-grade bar on top of the shared fuzzy matcher: the label's first word
        // (the client surname by folder convention) must appear in the winning project's
        // name. The matcher alone scores two shared GENERIC words ("Kitchen Remodel")
        // as a match, which is fine for routing expense receipts but could point a
        // deposit at the wrong client's project when the payer line failed to extract.
        const labelWords = normalizeWords(payload.projectName);
        if (labelWords.length === 0 || !normalizeWords(project.name).includes(labelWords[0])) {
            return await finalizeUnmatched(row, `"${payload.projectName}" only weakly matched "${project.name}" (first word differs) — not safe for money`);
        }

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

        const candidates = await prisma.paymentSchedule.findMany({
            where: { status: "Pending", invoice: { projectId: project.id, status: { in: OPEN_INVOICE_STATUSES } } },
            select: { id: true, amount: true, invoiceId: true, qbInvoiceId: true, invoice: { select: { code: true } } },
        });
        const amountMatches = candidates.filter(c => Math.abs(toNum(c.amount) - payload.amount) <= 0.005);
        if (amountMatches.length !== 1) {
            if (amountMatches.length > 0) {
                return await finalizeUnmatched(row, `${amountMatches.length} pending milestones on "${project.name}" match $${payload.amount} — ambiguous`);
            }
            // Before the generic (and alarming) zero-match message: the sweep may
            // simply have booked this same check first, which makes the milestone
            // Paid and therefore invisible to the Pending query above.
            const twin = await findAppliedTwin(row, Math.round(payload.amount * 100), payload.checkDate, BANK_DEPOSIT_SOURCE);
            const base = `no pending milestone on "${project.name}" matches $${payload.amount}`;
            return await finalizeUnmatched(row, twin ? `${base} — ${appliedTwinNote(twin)}` : base);
        }
        const picked = amountMatches[0];

        // Reserve — the partial unique index (scripts/apply-deposit-ingest-schema.mjs)
        // stops a second deposit file from claiming the same milestone concurrently,
        // and the cross-source claim check inside the same transaction stops the OTHER
        // SOURCE (the sweep) from reserving a DIFFERENT milestone for this same money.
        // Another PHOTO at the same amount is not blocked: it carries its own project
        // name, so it was never ambiguous.
        const reserved = await reserveMilestone(row, picked.id, {
            amountCents: Math.round(payload.amount * 100),
            postDate: isValidCheckDate(payload.checkDate) ? payload.checkDate : null,
        });
        if (!reserved.ok) return await finalizeUnmatched(row, reserved.reason);
        schedule = { id: picked.id, invoiceId: picked.invoiceId, qbInvoiceId: picked.qbInvoiceId, invoiceCode: picked.invoice.code };
    }

    return schedule.qbInvoiceId
        ? await applyQboLinked(row, schedule, payload)
        : await applyNonQbo(row, schedule, payload);
}

async function applyNonQbo(row: DepositIngest, schedule: MatchedSchedule, payload: NormalizedPayload): Promise<NextResponse> {
    // Money-boundary marker (the non-QBO analog of persisting qbRequestPayload):
    // stamped BEFORE the settle so any crash from here on preserves the reservation
    // and the original payload, and recovery resumes THIS reserved row exactly.
    if (!row.settleStartedAt) {
        await prisma.depositIngest.update({ where: { id: row.id }, data: { settleStartedAt: new Date() } });
    }
    // checkDate is already validated as strict YYYY-MM-DD by isValidCheckDate before
    // we get here, so the canonical parser's calendar-day branch always takes it.
    const paymentDate = parsePaymentDateInput(payload.checkDate!);
    if (!paymentDate) {
        // Unreachable given isValidCheckDate upstream; belt-and-braces so a future
        // change to that gate can never silently store a wrong day.
        return await finalizeUnmatched(row, `check date could not be parsed: ${payload.checkDate}`);
    }
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
            // Reservation kept: settleStartedAt is stamped, so the reconcile human
            // must see exactly which milestone this deposit was applying to (and the
            // index hold stops another file from claiming it mid-review).
            return await finalizeReconcile(row, `ProBuild settle failed: ${result.error}`, {});
        }
    }
    await prisma.depositIngest.update({ where: { id: row.id }, data: { status: "applied", lastError: null } });
    return NextResponse.json({ ok: true, status: "applied", scheduleId: schedule.id, invoiceCode: schedule.invoiceCode });
}

async function applyQboLinked(row: DepositIngest, schedule: MatchedSchedule, payload: NormalizedPayload): Promise<NextResponse> {
    const tokens = await getFreshQBTokens(); // throws QBNotConnectedError → top-level catch → "failed" (pre-QBO, no boundary crossed)
    const opts = applyOptionsForRow(row);

    const built = await buildQBPaymentRequest(tokens, schedule.qbInvoiceId!, {
        amount: payload.amount,
        txnDate: payload.checkDate!,
        paymentRefNum: payload.checkNumber!,
        ...(opts.depositToAccountId ? { depositToAccountId: opts.depositToAccountId } : {}),
    });
    if (!built.ok) {
        // Deterministic guards (balance-mismatch, invoice-not-found,
        // missing-customer) never come good on a retry: the same request fails
        // the same way forever, so the generic loop just burns eight attempts
        // and reconciles with an opaque reason. Balance-mismatch in particular
        // is not an error at all — it means a human already booked this payment,
        // which is exactly what the guard is for. Say so, in words, once.
        if (isDeterministicQboGuardFailure(built.reason)) {
            return await finalizeUnmatched(row, qboGuardNote(built, schedule.invoiceCode));
        }
        throw new Error(`QuickBooks guard failed (${built.reason}) for invoice ${schedule.invoiceCode}`);
    }

    // Persist the EXACT bytes BEFORE the network call fires — a crash/timeout on the
    // send still leaves the row able to replay byte-identically with the same requestid.
    //
    // CONDITIONAL on the row still being ours: the batch preflight can cancel a
    // row (a collision found on a later credit) while this one is mid-flight.
    // Zero rows updated means we no longer own this deposit, and the correct
    // response is to stop BEFORE QuickBooks is touched at all.
    const claimed = await prisma.depositIngest.updateMany({
        where: { id: row.id, status: "processing" },
        data: { status: "qbo_unknown", qbRequestPayload: built.requestBody },
    });
    if (claimed.count === 0) {
        const fresh = await prisma.depositIngest.findUnique({ where: { id: row.id } });
        return NextResponse.json({
            ok: true, status: fresh?.status ?? "unknown",
            reason: fresh?.lastError ?? "this deposit was re-classified while it was being applied — no payment was created",
        });
    }

    const requestId = depositRequestId(payload.fileId);
    return await sendAndSettle(row.id, schedule, {
        checkDate: payload.checkDate!, checkNumber: payload.checkNumber!, requestId, requestBody: built.requestBody,
        suppressClientReceipt: opts.suppressClientReceipt,
    }, tokens);
}

/**
 * Money-write options derived from the row's SOURCE, not from a caller's
 * argument, so a crash-recovery resume (which re-enters from the persisted row,
 * not the original request) makes the same choices the first attempt did.
 *
 * Bank rows deposit straight to the Washington Trust account and never email
 * the client a receipt: the sweep books money no human has looked at yet, and
 * the back-date rule cannot suppress that (a 2-day-old payment is well inside
 * BACKDATED_RECEIPT_CUTOFF_DAYS). The team email and activity log still fire.
 */
function applyOptionsForRow(row: DepositIngest): { depositToAccountId?: string; suppressClientReceipt?: boolean } {
    return row.source === BANK_DEPOSIT_SOURCE
        ? { depositToAccountId: BANK_DEPOSIT_TO_ACCOUNT_ID, suppressClientReceipt: true }
        : {};
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
        suppressClientReceipt: applyOptionsForRow(row).suppressClientReceipt,
    }, tokens);
}

async function resumeFromQboCreated(row: DepositIngest): Promise<NextResponse> {
    const schedule = await loadMatchedSchedule(row.paymentScheduleId!);
    if (!schedule) return await finalizeReconcile(row, "reserved milestone no longer exists", {});
    const extracted = JSON.parse(row.extracted) as NormalizedPayload;
    return await settleAndFinalize(row.id, schedule, {
        checkDate: extracted.checkDate!, checkNumber: extracted.checkNumber!, qbPaymentId: row.qbPaymentId!,
        suppressClientReceipt: applyOptionsForRow(row).suppressClientReceipt,
    });
}

async function sendAndSettle(
    rowId: string,
    schedule: MatchedSchedule,
    ctx: { checkDate: string; checkNumber: string; requestId: string; requestBody: string; suppressClientReceipt?: boolean },
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

    // Same CAS, on the far side of the money boundary — but the payment NOW
    // EXISTS, so a lost claim is not a quiet stop: it is a real QuickBooks
    // payment whose row someone else has taken, which only a human can untangle.
    const created = await prisma.depositIngest.updateMany({
        where: { id: rowId, status: "qbo_unknown" },
        data: { status: "qbo_created", qbPaymentId: paymentId, lastError: null },
    });
    if (created.count === 0) {
        const fresh = await prisma.depositIngest.findUnique({ where: { id: rowId } });
        if (!fresh) throw new Error("DepositIngest row vanished mid-send");
        return await finalizeReconcile(
            fresh,
            `QuickBooks payment ${paymentId} was created, but this deposit was re-classified mid-flight ` +
            `(status ${fresh.status}) — link or void that payment by hand`,
            {},
        );
    }

    return await settleAndFinalize(rowId, schedule, {
        checkDate: ctx.checkDate, checkNumber: ctx.checkNumber, qbPaymentId: paymentId,
        suppressClientReceipt: ctx.suppressClientReceipt,
    });
}

async function settleAndFinalize(
    rowId: string,
    schedule: MatchedSchedule,
    ctx: { checkDate: string; checkNumber: string; qbPaymentId: string; suppressClientReceipt?: boolean },
): Promise<NextResponse> {
    const paidAt = new Date(`${ctx.checkDate}T12:00:00Z`);
    const settled = await settleMilestoneFromQBPayment({
        paymentScheduleId: schedule.id,
        invoiceId: schedule.invoiceId,
        qbPaymentId: ctx.qbPaymentId,
        paidAt,
        referenceNumber: ctx.checkNumber,
        suppressClientReceipt: ctx.suppressClientReceipt,
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

    const finished = await prisma.depositIngest.updateMany({
        where: { id: rowId, status: { in: ["qbo_created", "processing"] } },
        data: { status: "applied", lastError: null },
    });
    if (finished.count === 0) {
        // The settle DID commit, so this money is applied — but the row moved
        // under us and must not be silently stamped applied over whatever a
        // concurrent path decided. A human reconciles the two.
        const fresh = await prisma.depositIngest.findUnique({ where: { id: rowId } });
        if (fresh) {
            return await finalizeReconcile(
                fresh,
                `the milestone was settled with QuickBooks payment ${ctx.qbPaymentId}, but this deposit row had already ` +
                `been moved to ${fresh.status} — confirm the milestone and close this out by hand`,
                {},
            );
        }
    }
    return NextResponse.json({ ok: true, status: "applied", scheduleId: schedule.id, invoiceCode: schedule.invoiceCode, qbPaymentId: ctx.qbPaymentId });
}

// ── Deposit sweep: the bank source ───────────────────────────────────────────

/**
 * The bank variant's per-credit payload. A SUPERSET of NormalizedPayload, so
 * every shared helper below reads it verbatim — finalizeUnmatched →
 * ensureReviewTask → createDepositReviewTask, the reserved-row resume,
 * applyQboLinked, settleAndFinalize. The bank reference stands in as the
 * instrument reference (there is no check number on a bank line, by
 * construction; the reference is what Vanessa sees in the feed) and the CSV
 * post date as the transaction date.
 */
interface BankPayload extends NormalizedPayload {
    source: typeof BANK_DEPOSIT_SOURCE;
    bankReference: string;
    postDate: string;
    amountCents: number;
    /** The three fields the deposit-class allowlist reads, kept separate and
     *  unmerged (see isCustomerDepositClass). */
    baiCode: string | null;
    description: string | null;
    transactionDetail: string | null;
    customerReference: string | null;
}

interface BankCreditResult {
    bankReference: string;
    status: string;
    replay: boolean;
    reason?: string | null;
    scheduleId?: string | null;
    qbPaymentId?: string | null;
    officeTaskId?: string | null;
    alreadyApplied?: boolean;
}

const BANK_CANDIDATE_SELECT = {
    id: true, name: true, status: true, amount: true, invoiceId: true, qbInvoiceId: true,
    invoice: {
        select: {
            code: true,
            project: { select: { id: true, name: true } },
            client: { select: { name: true } },
        },
    },
} as const;

type BankCandidate = {
    id: string;
    name: string;
    status: string;
    amount: unknown;
    invoiceId: string;
    qbInvoiceId: string | null;
    invoice: {
        code: string;
        project: { id: string; name: string } | null;
        client: { name: string } | null;
    };
};

const centsOf = (amount: unknown) => Math.round(toNum(amount) * 100);

const describeOne = (c: BankCandidate) => ({
    milestoneName: c.name,
    projectName: c.invoice.project?.name ?? null,
    invoiceCode: c.invoice.code,
});

const toMilestoneCandidate = (c: BankCandidate): MilestoneCandidate => ({
    id: c.id,
    projectName: c.invoice.project?.name ?? c.invoice.code,
    customerName: c.invoice.client?.name ?? null,
    milestoneName: c.name,
    amountCents: centsOf(c.amount),
    status: c.status,
});

const isoOf = (value: Date | null) => (value ? value.toISOString().slice(0, 10) : null);

function bankPayloadFor(credit: BankCredit, postDate: string): BankPayload {
    return {
        source: BANK_DEPOSIT_SOURCE,
        bankReference: credit.bankReference,
        postDate,
        amountCents: credit.amountCents,
        baiCode: credit.baiCode,
        description: credit.description,
        transactionDetail: credit.transactionDetail,
        customerReference: credit.customerReference,
        fileId: bankFileId(credit.bankReference),
        // A bank credit names no project — the sweep matches across all of them.
        projectName: "",
        amount: credit.amount,
        fileUrl: null,
        fileName: `bank ref ${credit.bankReference}`,
        payerName: null,
        checkDate: postDate,
        checkNumber: credit.bankReference,
        memo: credit.transactionDetail,
    };
}

/**
 * ONE POST per day, carrying the COMPLETE day's credit rows plus the CSV's own
 * control totals (docs/BANK-DATA-SOURCES.md). The whole batch is refused (400,
 * nothing written) when the totals don't tie — a half-seen day is exactly the
 * state that makes an amount look unique when it is not.
 *
 * Then, before any money write, two preflight steps in this order:
 *   1. REPLAY resolution. A credit whose bankReference already has a row is a
 *      replay of that row, never a new deposit — a terminal row returns its
 *      stored outcome, a `proposed` row is re-evaluated now (it may have aged
 *      past the wait rule), a stale in-flight row is reclaimed. Replays are
 *      EXCLUDED from collision classification (Codex round 2, R3): the daily
 *      job re-posts the same day repeatedly, and treating that as a collision
 *      would send every credit to a human forever.
 *   2. COLLISION detection on what remains: a DIFFERENT bankReference, in this
 *      batch or already stored, with the same postDate and amountCents. Both
 *      go to a human — an amount is all a bank credit carries.
 */
async function handleBankBatch(raw: Record<string, unknown>): Promise<NextResponse> {
    const parsed = parseBankBatch(raw);
    if (!parsed.ok) return NextResponse.json({ ok: false, reason: parsed.reason }, { status: 400 });
    const { postDate, credits, dryRun } = parsed.batch;

    const fileIds = credits.map(c => bankFileId(c.bankReference));
    const existing = await prisma.depositIngest.findMany({
        where: { fileId: { in: fileIds } },
        select: { fileId: true },
    });
    const replays = new Set(existing.map(r => r.fileId));

    // Collision classification runs over the WHOLE batch (replays included) and
    // every stored same-day row in ANY status. It must not depend on how far a
    // previous run got: a crash between "created as processing" and "filed as
    // unmatched" would otherwise erase the verdict and let the money auto-apply
    // on the next day's replay.
    const storedSameDay = await prisma.depositIngest.findMany({
        where: {
            source: BANK_DEPOSIT_SOURCE,
            postDate: isoDateToUtc(postDate),
            amountCents: { in: [...new Set(credits.map(c => c.amountCents))] },
            fileId: { notIn: fileIds },
        },
        select: { bankReference: true, amountCents: true },
    });
    const collisions = findCollisions(credits, storedSameDay);

    // Persist every collision verdict BEFORE any matching runs, so the batch can
    // die at any point from here on without a colliding credit ever being
    // eligible to book money.
    const pastBoundary = new Set<string>();
    for (const credit of credits) {
        const others = collisions.get(credit.bankReference);
        if (!others) continue;
        const verdict = await persistCollisionVerdict(credit, postDate, others);
        if (verdict === "past-boundary") pastBoundary.add(credit.bankReference);
    }
    // A credit that collided with a row already past the money boundary is not
    // just "needs a human" — there is a QuickBooks payment in play that nobody
    // can cancel from here. Escalate it so the batch reports unresolved.
    for (const credit of credits) {
        const others = collisions.get(credit.bankReference);
        if (!others || pastBoundary.has(credit.bankReference)) continue;
        const committed = others.filter(ref => pastBoundary.has(ref));
        if (committed.length > 0) await escalateAgainstCommittedTwin(credit, postDate, others, committed);
    }

    const results: BankCreditResult[] = [];
    for (const credit of credits) {
        results.push(await processBankCredit(credit, postDate, {
            dryRun,
            replay: replays.has(bankFileId(credit.bankReference)),
            collidesWith: collisions.get(credit.bankReference) ?? [],
        }));
    }

    // Every outcome, terminal and not, derived from the RAW per-credit results
    // rather than from a list of statuses someone remembered to name: anything
    // outside the tallied set (qbo_created after a settle threw, a busy
    // processing row, a status that does not exist yet) lands in `unresolved`,
    // so no credit can be silently counted as nothing. `replay` is orthogonal
    // (a replay still has an outcome) and is reported so "ran but did nothing
    // new" is distinguishable from "ran but saw nothing" — the failure mode a
    // browser-automated CSV export actually has.
    const tally = (status: string) => results.filter(r => r.status === status).length;
    const counts: SweepCounts = {
        credits: credits.length,
        applied: tally("applied"),
        proposed: tally("proposed"),
        unmatched: tally("unmatched"),
        reconcile: tally("reconcile"),
        failed: tally("failed"),
        qboUnknown: tally("qbo_unknown"),
        unresolved: results.filter(r => !TALLIED_SWEEP_STATUSES.includes(r.status as never)).length,
        replay: results.filter(r => r.replay).length,
    };
    // HTTP is still 200 — the batch WAS processed; 400 is reserved for a payload
    // that could not be trusted at all. `ok` is what tells the unattended runner
    // whether the day finished cleanly.
    return NextResponse.json({
        ok: sweepBatchOk(counts),
        source: BANK_DEPOSIT_SOURCE, postDate, dryRun, counts, credits: results,
    });
}

/**
 * Write a colliding credit's verdict, atomically, before any matching runs.
 *
 *  - no row yet          → INSERT it already terminal (`unmatched`), so the
 *                          verdict exists even if this process dies next line;
 *  - non-terminal row    → CAS it to `unmatched` (or `reconcile` when it already
 *                          crossed a money boundary: releasing a reservation
 *                          that may correspond to a real QuickBooks payment
 *                          would strand it);
 *  - terminal row        → leave it; the per-credit loop reports its stored
 *                          outcome and heals a missing task.
 *
 * The OfficeTask is created after the row, not inside its transaction — the
 * file-wide invariant (see finalizeUnmatched) is that terminal state is
 * persisted FIRST and a missing task self-heals on the next POST, whereas the
 * reverse order can file duplicate tasks.
 */
async function persistCollisionVerdict(
    credit: BankCredit,
    postDate: string,
    others: string[],
): Promise<"recorded" | "past-boundary"> {
    const payload = bankPayloadFor(credit, postDate);
    const reason = collisionNote(credit, postDate, others);
    const existing = await prisma.depositIngest.findUnique({ where: { fileId: payload.fileId } });

    if (!existing) {
        try {
            const created = await prisma.depositIngest.create({
                data: {
                    fileId: payload.fileId, status: "unmatched", extracted: JSON.stringify(payload),
                    attempts: 1, processingStartedAt: new Date(), lastError: reason.slice(0, 1000),
                    source: BANK_DEPOSIT_SOURCE, bankReference: credit.bankReference,
                    postDate: isoDateToUtc(postDate), amountCents: credit.amountCents,
                    // EVERY bank-row creation path stamps this, or a later reuse
                    // of the reference reads as a clean replay of a row that
                    // never recorded what it was.
                    bankFingerprint: bankCreditFingerprint(payload),
                },
            });
            const taskId = await ensureReviewTask(created, reason, "unmatched");
            // Same rule as every other bank review: no task means nobody sees
            // it, so the row must not stay a quiet `unmatched`.
            await escalateUnseenBankReview(created, reason, taskId);
        } catch (e: any) {
            // Lost the create race to a concurrent POST of the same day; that
            // row is handled by the branch below on the next pass.
            if (e?.code !== "P2002") throw e;
        }
        return "recorded";
    }

    if (["applied", "unmatched", "reconcile"].includes(existing.status)) return "recorded";

    // A row that has NOT reached the money yet is cancelled here, whatever its
    // lease says. Leaving a fresh `processing` worker alone was the wrong call:
    // it could still win its own processing→qbo_unknown CAS a moment later and
    // create a payment for a credit this preflight had already ruled a
    // collision — "both credits go to a human" has to mean both. The CAS below
    // and the worker's boundary CAS are the same lock from opposite ends:
    // whichever lands first, the other sees zero rows and stops.
    //
    // Only a row PAST the boundary is left alone, because cancelling it would
    // strand a QuickBooks payment that already exists. That one needs a human,
    // and so does the credit that collided with it.
    const boundaryMarked = !!(existing.qbPaymentId || existing.qbRequestPayload || existing.settleStartedAt);
    const pastBoundary = boundaryMarked || ["qbo_unknown", "qbo_created"].includes(existing.status);
    if (pastBoundary) return "past-boundary";

    const status = "unmatched";
    const claimed = await prisma.depositIngest.updateMany({
        where: { id: existing.id, status: existing.status },
        data: {
            // Pre-boundary by construction (past-boundary rows returned above),
            // so releasing the reservation here is safe and correct.
            status, lastError: reason.slice(0, 1000), paymentScheduleId: null,
        },
    });
    if (claimed.count === 0) return "recorded"; // another worker moved it; its own path decides
    const fresh = await prisma.depositIngest.findUnique({ where: { id: existing.id } });
    if (fresh && !fresh.officeTaskId) {
        const taskId = await ensureReviewTask(fresh, reason, "unmatched");
        await escalateUnseenBankReview(fresh, reason, taskId);
    }
    return "recorded";
}

/** A collision whose twin already reached QuickBooks: that twin cannot be
 *  called back, so this credit is not merely unmatched — it is unresolved, and
 *  the batch must say so. */
async function escalateAgainstCommittedTwin(
    credit: BankCredit,
    postDate: string,
    others: string[],
    committed: string[],
): Promise<void> {
    const reason = `${collisionNote(credit, postDate, others)}; ${committed.join(", ")} has already reached QuickBooks and ` +
        `cannot be called back, so a human must decide what this credit is`;
    await prisma.depositIngest.updateMany({
        where: { fileId: bankFileId(credit.bankReference), status: { in: ["unmatched", "reconcile"] } },
        data: { status: "reconcile", lastError: reason.slice(0, 1000) },
    });
}

async function processBankCredit(
    credit: BankCredit,
    postDate: string,
    opts: { dryRun: boolean; replay: boolean; collidesWith: string[] },
): Promise<BankCreditResult> {
    const payload = bankPayloadFor(credit, postDate);
    const claim = await claimBankRow(payload);
    if (claim.kind === "settled") return await bankResult(credit.bankReference, opts.replay, claim.response);
    const row = claim.row;

    // Belt and braces: the verdict was already persisted by
    // persistCollisionVerdict, so this only fires if that CAS lost a race.
    if (opts.collidesWith.length > 0) {
        return await bankResult(credit.bankReference, opts.replay,
            await finalizeUnmatched(row, collisionNote(credit, postDate, opts.collidesWith)));
    }
    if (row.attempts > MAX_ATTEMPTS) {
        const crossedAnyBoundary = !!row.qbPaymentId || !!row.qbRequestPayload || !!row.settleStartedAt;
        return await bankResult(credit.bankReference, opts.replay, await finalizeReconcile(
            row,
            `exceeded ${MAX_ATTEMPTS} retry attempts (last error: ${row.lastError ?? "none"})`,
            { nullReservation: !crossedAnyBoundary },
        ));
    }
    try {
        const response = row.status === "qbo_created" ? await resumeFromQboCreated(row)
            : row.status === "qbo_unknown" ? await resumeFromQboUnknown(row)
            : await matchAndApplyBank(row, payload, opts);
        return await bankResult(credit.bankReference, opts.replay, response);
    } catch (e) {
        return await bankResult(credit.bankReference, opts.replay, await recordAttemptFailure(row, e));
    }
}

/** Flatten one credit's own response into the batch response, so a per-credit
 *  outcome never becomes a second source of truth. */
async function bankResult(bankReference: string, replay: boolean, response: NextResponse): Promise<BankCreditResult> {
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    return {
        bankReference,
        replay,
        status: typeof body?.status === "string" ? body.status : "error",
        reason: typeof body?.reason === "string" ? body.reason : null,
        scheduleId: typeof body?.scheduleId === "string" ? body.scheduleId : null,
        qbPaymentId: typeof body?.qbPaymentId === "string" ? body.qbPaymentId : null,
        officeTaskId: typeof body?.officeTaskId === "string" ? body.officeTaskId : null,
        ...(body?.alreadyApplied === true ? { alreadyApplied: true } : {}),
    };
}

type BankClaim = { kind: "claimed"; row: DepositIngest } | { kind: "settled"; response: NextResponse };

/**
 * Claim ONE bank credit's row. Mirrors the photo path's claim above, minus
 * `?force=1` (an unattended daily job must never re-run a row a human has
 * already been asked about) and plus `proposed`, which every daily POST
 * re-evaluates.
 */
async function claimBankRow(payload: BankPayload): Promise<BankClaim> {
    const fingerprint = bankCreditFingerprint(payload);
    const columns = {
        source: BANK_DEPOSIT_SOURCE,
        bankReference: payload.bankReference,
        postDate: isoDateToUtc(payload.postDate),
        amountCents: payload.amountCents,
        bankFingerprint: fingerprint,
    };
    let row = await prisma.depositIngest.findUnique({ where: { fileId: payload.fileId } });

    // A replay is only a replay if it is the SAME credit. `bank:<reference>` is
    // the idempotency key, so a bank that reuses a reference for different
    // money would otherwise have its new deposit silently swallowed as a
    // duplicate of the old one.
    // A row created before this column existed carries no fingerprint. Backfill
    // it from the credit in hand ONLY when the two agree on the facts that were
    // already stored (post date and amount); if they disagree, the reference has
    // been reused and this is not a replay at all.
    if (row && row.source === BANK_DEPOSIT_SOURCE && !row.bankFingerprint) {
        const storedMatches = row.amountCents === payload.amountCents
            && isoOf(row.postDate) === payload.postDate;
        if (storedMatches) {
            await prisma.depositIngest.updateMany({
                where: { id: row.id, bankFingerprint: null },
                data: { bankFingerprint: fingerprint },
            });
            row = (await prisma.depositIngest.findUnique({ where: { id: row.id } })) ?? row;
        }
    }

    if (row && row.source === BANK_DEPOSIT_SOURCE && row.bankFingerprint !== fingerprint) {
        const reason = `bank reference reused with different data — this row was created from ` +
            `[${row.bankFingerprint ?? "an unrecorded credit"}] but the batch now posts [${fingerprint}]; ` +
            `a human must work out which deposit is which`;
        await prisma.depositIngest.updateMany({
            where: { id: row.id, status: { not: "reconcile" } },
            data: { status: "reconcile", lastError: reason.slice(0, 1000) },
        });
        const fresh = (await prisma.depositIngest.findUnique({ where: { id: row.id } })) ?? row;
        const officeTaskId = fresh.officeTaskId ?? await ensureReviewTask(fresh, reason, "reconcile");
        return { kind: "settled", response: NextResponse.json({ ok: true, status: "reconcile", reason, officeTaskId }) };
    }
    if (!row) {
        try {
            return {
                kind: "claimed",
                row: await prisma.depositIngest.create({
                    data: {
                        fileId: payload.fileId, status: "processing", extracted: JSON.stringify(payload),
                        attempts: 1, processingStartedAt: new Date(), ...columns,
                    },
                }),
            };
        } catch (e: any) {
            if (e?.code !== "P2002") throw e;
            // Lost the create race to a concurrent duplicate — fall through.
            row = await prisma.depositIngest.findUnique({ where: { fileId: payload.fileId } });
        }
    }
    if (!row) return { kind: "settled", response: NextResponse.json({ ok: false, status: "claim-race" }) };

    if (row.status === "applied") {
        let invoiceCode: string | undefined;
        if (row.paymentScheduleId) {
            const s = await prisma.paymentSchedule.findUnique({
                where: { id: row.paymentScheduleId },
                select: { invoice: { select: { code: true } } },
            });
            invoiceCode = s?.invoice.code;
        }
        return {
            kind: "settled",
            response: NextResponse.json({
                ok: true, status: "applied", alreadyApplied: true,
                scheduleId: row.paymentScheduleId, qbPaymentId: row.qbPaymentId, invoiceCode,
            }),
        };
    }
    if (row.status === "unmatched" || row.status === "reconcile") {
        const kind = row.status === "reconcile" ? "reconcile" : "unmatched";
        // Heal a task lost to a crash — EXCEPT for a row that deliberately never
        // had one (a credit that is not a customer deposit). Without this the
        // daily replay would file the very task the class gate declined to file.
        const heals = !isNotCustomerDepositReason(row.lastError);
        const officeTaskId = heals ? (row.officeTaskId ?? await ensureReviewTask(row, row.lastError ?? kind, kind)) : row.officeTaskId;
        // A replay that STILL cannot file the task must not keep answering
        // "unmatched, all handled" every day for a review nobody can see.
        if (heals && row.status === "unmatched") {
            const escalated = await escalateUnseenBankReview(row, row.lastError ?? kind, officeTaskId);
            if (escalated) return { kind: "settled", response: escalated };
        }
        return { kind: "settled", response: NextResponse.json({ ok: true, status: row.status, reason: row.lastError, officeTaskId }) };
    }

    const reclaimable = ["proposed", "processing", "qbo_unknown", "qbo_created", "failed"];
    if (!reclaimable.includes(row.status)) {
        return { kind: "settled", response: NextResponse.json({ ok: true, status: row.status, reason: row.lastError }) };
    }
    // `failed` has no lease, and `proposed` is deliberately re-evaluated by
    // every daily POST — both reclaim immediately. The in-flight states only
    // reclaim once their 5-minute lease is stale.
    const needsLease = row.status !== "failed" && row.status !== "proposed";
    const retriable = row.status === "processing" || row.status === "failed" || row.status === "proposed";
    const boundaryMarked = !!(row.qbPaymentId || row.qbRequestPayload || row.settleStartedAt);
    // A `proposed` row is re-evaluated by EVERY daily POST — that is its whole
    // purpose — so those replays must not consume the retry budget. Counting
    // them turned a clean shadow-week row into a fabricated `reconcile`
    // incident on the ninth day, for a credit that had never failed at anything.
    const consumesAttempt = row.status !== "proposed";
    const claim = await prisma.depositIngest.updateMany({
        where: {
            id: row.id, status: row.status,
            ...(needsLease ? { processingStartedAt: { lt: new Date(Date.now() - STALE_PROCESSING_MS) } } : {}),
        },
        data: {
            status: retriable ? "processing" : row.status,
            ...(consumesAttempt ? { attempts: { increment: 1 } } : {}),
            processingStartedAt: new Date(),
            ...(retriable && !boundaryMarked ? { extracted: JSON.stringify(payload), paymentScheduleId: null, ...columns } : {}),
        },
    });
    if (claim.count === 0) {
        const current = await prisma.depositIngest.findUnique({ where: { id: row.id }, select: { status: true } });
        return {
            kind: "settled",
            response: NextResponse.json({ ok: true, status: current?.status ?? row.status, reason: "in progress — retry shortly" }),
        };
    }
    return { kind: "claimed", row: (await prisma.depositIngest.findUnique({ where: { id: row.id } }))! };
}

/**
 * Match ONE bank credit. Two photo-path rules do not apply here, because a
 * bank line has neither a project name nor a check number: project-first
 * matching is skipped (the candidate query runs across ALL projects), and a
 * missing check number is not `unmatched`. Everything else is stricter:
 *
 *  - candidates must be REQUESTED (PaymentSchedule.qbInvoiceSentAt, the
 *    rail-neutral request marker billing-core.ts stamps only once the client
 *    email actually went out). A qbInvoiceId-only milestone was created in
 *    QuickBooks but never asked for, so it is not a candidate — that is what
 *    resolves the Hoppe case, where three Pending milestones sat at exactly
 *    $13,447.68 and only one had been requested;
 *  - uniqueness is taken over a UNION with anything at this amount settled in
 *    the last 14 days by ANY source, so money the photo path just booked still
 *    counts against uniqueness even though its milestone is now Paid;
 *  - auto-apply additionally requires qbInvoiceId (the QBO write path needs
 *    the linked invoice);
 *  - the credit must be at least 2 days old (younger credits are held
 *    `proposed`), and the reservation carries a cross-source claim check.
 */
async function matchAndApplyBank(row: DepositIngest, payload: BankPayload, opts: { dryRun: boolean }): Promise<NextResponse> {
    if (row.paymentScheduleId) {
        // A prior crashed attempt already reserved a milestone: resume THAT
        // reservation with the PRESERVED payload rather than re-matching, same
        // as the photo path's reserved branch.
        let preserved: BankPayload;
        try {
            preserved = JSON.parse(row.extracted) as BankPayload;
        } catch {
            return await finalizeReconcile(row, "reserved row has unreadable extracted payload", {});
        }
        const reserved = await loadMatchedSchedule(row.paymentScheduleId);
        if (!reserved) return await finalizeReconcile(row, "reserved milestone no longer exists", {});
        if (!reserved.qbInvoiceId) {
            return await finalizeReconcile(row, "reserved milestone lost its QuickBooks invoice link mid-flight", {});
        }
        return await applyQboLinked(row, reserved, preserved);
    }

    const amountLabel = `$${payload.amount.toFixed(2)}`;

    // A bank credit is any money IN — an owner contribution, interest, an ACH
    // refund, a transfer between accounts. Any of those can land on the exact
    // cents of a requested milestone, and this sweep matches on amount alone,
    // so only an actual customer deposit may ever be booked as a customer
    // payment. Checked BEFORE anything else: no reservation, no QuickBooks.
    if (!isCustomerDepositClass(payload)) {
        const reason = notCustomerDepositNote(payload);
        // Most of these are routine noise (interest, transfers) and filing a
        // task for each would bury the real ones. A task is only worth a
        // human's attention when the amount could plausibly BE a milestone
        // payment — then somebody should look at why it arrived this way.
        const lookalikes = await requestedMilestonesAt(payload.amountCents);
        return await finalizeUnmatched(row, reason, { fileTask: lookalikes > 0 });
    }

    // Chronology: the milestone must already have been REQUESTED when the money
    // arrived. Money cannot pay a bill that had not been sent yet, and without
    // this bound, invoicing a new milestone for the same amount today would
    // retroactively make it a candidate for last week's deposit.
    const requestedBy = requestedByInstant(payload.postDate);
    const requested: BankCandidate[] = await prisma.paymentSchedule.findMany({
        where: {
            status: "Pending",
            qbInvoiceSentAt: { not: null, lte: requestedBy },
            invoice: { status: { in: OPEN_INVOICE_STATUSES } },
        },
        select: BANK_CANDIDATE_SELECT,
    });
    const pending = requested.filter(c => centsOf(c.amount) === payload.amountCents);

    const paid: BankCandidate[] = await prisma.paymentSchedule.findMany({
        where: {
            status: "Paid",
            paymentDate: { gte: isoDateToUtc(isoDaysBefore(payload.postDate, PAID_UNION_WINDOW_DAYS)) },
        },
        select: BANK_CANDIDATE_SELECT,
    });
    const union = [
        ...pending,
        ...paid.filter(p => centsOf(p.amount) === payload.amountCents && !pending.some(x => x.id === p.id)),
    ];

    if (union.length !== 1 || union[0].status !== "Pending") {
        return await finalizeUnmatched(row, await bankNoMatchReason(row, payload, union, amountLabel, requestedBy));
    }
    const picked = union[0];

    // Payer corroboration, when there is any. Images are selected by IDENTITY
    // (the bank reference, prefix-matched because the key carries a :front /
    // :back side suffix — scripts/post-bank-images.mjs), never by a date/amount
    // window. Zero payer-bearing images is the NORMAL case for a branch deposit
    // (docs/WTB-CHECK-IMAGES.md) and is not an error; two or more is a conflict.
    const images = await prisma.bankImage.findMany({
        where: {
            source: BANK_IMAGE_SOURCE,
            sourceExternalId: { startsWith: bankImageKeyPrefix(payload.bankReference) },
        },
        select: { payerName: true, memoText: true, normalizedCheckNumber: true, amountCents: true, documentDate: true },
    });
    const evidence = selectPayerBearingImage(images);
    if (evidence.kind === "conflict") {
        return await finalizeUnmatched(row,
            `${evidence.count} check images filed under bank reference ${payload.bankReference} name a payer — ` +
            `one deposit cannot have two payers, so a human must say what this is`);
    }
    const attribution = attributeDeposit(
        {
            id: payload.bankReference,
            postedDate: payload.postDate,
            amountCents: payload.amountCents,
            rawDescriptor: payload.transactionDetail ?? "",
        },
        {
            checkImage: evidence.kind === "one" ? {
                payerName: evidence.image.payerName,
                memo: evidence.image.memoText,
                checkNumber: evidence.image.normalizedCheckNumber,
                amountCents: evidence.image.amountCents,
                documentDate: isoOf(evidence.image.documentDate),
            } : null,
            milestones: union.map(toMilestoneCandidate),
        },
    );
    // namesAgree already encodes the wrong-family guards; any conflict it finds
    // (image vs milestone customer, or an image that isn't for this deposit) is
    // a human's call, reported with its own reason verbatim.
    if (attribution.confidence === "conflict") return await finalizeUnmatched(row, attribution.reason);

    if (!picked.qbInvoiceId) {
        return await finalizeUnmatched(row,
            `${amountLabel} uniquely matches ${describeCandidates([describeOne(picked)])}, but that milestone has no ` +
            `QuickBooks invoice link — the sweep only books QBO-linked milestones, so record this one by hand`);
    }
    if (opts.dryRun) {
        return await finalizeProposed(row, picked.id, `dry run — would apply to ${describeCandidates([describeOne(picked)])}`);
    }
    if (!bankCreditIsOldEnough(payload.postDate, new Date())) {
        return await finalizeProposed(row, picked.id,
            `waiting ${BANK_APPLY_MIN_AGE_DAYS} days from ${payload.postDate} before booking (a fresh check belongs to the ` +
            `photo path first) — would apply to ${describeCandidates([describeOne(picked)])}`);
    }

    // THE CORROBORATION LADDER (deposit-sweep.ts). Payer evidence books on its
    // own. Failing that, ask the FIELD whether this milestone's work is
    // actually done — Justin's rule: the money should align with the daily logs
    // from the chat spaces. Only a credit with neither needs the switch.
    let confidence = attribution.confidence as string;
    let corroborationDetail = "";
    if (!booksWithoutOverride(confidence)) {
        const progress = await checkProgressCorroboration(picked, payload.postDate);
        corroborationDetail = progress.detail;
        if (progress.corroborated) confidence = PROGRESS_CONFIDENCE;
    }

    if (!booksWithoutOverride(confidence) && !liveApplyEnabled()) {
        return await finalizeProposed(row, picked.id,
            `${amountLabel} matches ${describeCandidates([describeOne(picked)])} — phase not corroborated by any daily log ` +
            `or inspection; no payment was booked; set ${LIVE_APPLY_ENV_VAR}=true to book amount-only matches ` +
            `(${corroborationDetail})`);
    }

    const reserved = await reserveMilestone(row, picked.id, { amountCents: payload.amountCents, postDate: payload.postDate });
    if (!reserved.ok) return await finalizeUnmatched(row, reserved.reason);

    return await applyQboLinked(
        row,
        { id: picked.id, invoiceId: picked.invoiceId, qbInvoiceId: picked.qbInvoiceId, invoiceCode: picked.invoice.code },
        payload,
    );
}

/**
 * Fetch what the FIELD knows about the candidate's project around the deposit,
 * and let the pure rule decide (progressCorroboration). Four small reads, and
 * only on the payer-less path — a credit with a named payer never gets here.
 */
async function checkProgressCorroboration(picked: BankCandidate, postDate: string) {
    const projectId = picked.invoice.project?.id ?? null;
    if (!projectId) {
        return { corroborated: false, via: null, detail: "the milestone's invoice has no project, so no field evidence could be checked" };
    }
    const from = isoDateToUtc(isoDaysBefore(postDate, PROGRESS_WINDOW_DAYS));
    const to = isoDateToUtc(isoDaysAfter(postDate, 1)); // exclusive upper bound on the post day

    const [inspections, dailyLogs] = await Promise.all([
        prisma.inspection.findMany({
            where: { projectId, result: { in: ["PASSED", "APPROVED"] } },
            // `type` is what was inspected ("Rough-in", "Framing"): the rule
            // needs it, because a passed plumbing inspection says nothing about
            // a cabinetry milestone.
            select: { result: true, type: true, performedDate: true, scheduledDate: true },
            orderBy: { performedDate: "desc" },
            take: 50,
        }),
        prisma.dailyLog.findMany({
            where: { projectId, date: { gte: from, lt: to } },
            select: { date: true, workPerformed: true },
            orderBy: { date: "desc" },
            take: 100,
        }),
    ]);

    // NOTE: a percent-complete rung was considered and REMOVED. Project
    // .percentComplete has no historical snapshot — `percentCompleteAsOf` is
    // just when it was last written, and the nightly recalc refreshes it — so
    // progress made LAST WEEK would have vouched for a deposit that landed
    // before any of it happened. Corroboration has to be evidence dated around
    // the money, and only the inspection and daily-log rungs can be.
    return progressCorroboration({
        postDate,
        milestoneName: picked.name,
        inspections: inspections.map(i => ({ result: i.result, type: i.type, date: isoOf(i.performedDate ?? i.scheduledDate) })),
        dailyLogs: dailyLogs.map(l => ({ date: isoOf(l.date) ?? "", workPerformed: l.workPerformed ?? "" })),
    });
}

/** How many REQUESTED, still-pending milestones sit at exactly this amount.
 *  Used only to decide whether a non-deposit credit is worth a human's time. */
async function requestedMilestonesAt(amountCents: number): Promise<number> {
    const requested = await prisma.paymentSchedule.findMany({
        where: {
            status: "Pending",
            qbInvoiceSentAt: { not: null },
            invoice: { status: { in: OPEN_INVOICE_STATUSES } },
        },
        select: BANK_CANDIDATE_SELECT,
    });
    return requested.filter(c => centsOf(c.amount) === amountCents).length;
}

async function bankNoMatchReason(
    row: DepositIngest,
    payload: BankPayload,
    union: BankCandidate[],
    amountLabel: string,
    requestedBy: Date,
): Promise<string> {
    if (union.length > 1) {
        return `${amountLabel} matches ${union.length} milestones: ${describeCandidates(union.map(describeOne))} — ` +
            `a bank line carries nothing but an amount, so a human must say which one this deposit settles`;
    }
    // Say WHY when the only thing at this amount was requested too late: a bare
    // "no milestone matches" would send a human hunting for a row that is
    // sitting right there, looking like a perfect match.
    if (union.length === 0) {
        const late: BankCandidate[] = await prisma.paymentSchedule.findMany({
            where: {
                status: "Pending",
                qbInvoiceSentAt: { gt: requestedBy },
                invoice: { status: { in: OPEN_INVOICE_STATUSES } },
            },
            select: BANK_CANDIDATE_SELECT,
        });
        const lateMatches = late.filter(c => centsOf(c.amount) === payload.amountCents);
        if (lateMatches.length > 0) {
            return `milestone requested after the deposit — ${describeCandidates(lateMatches.map(describeOne))} ` +
                `matches ${amountLabel} but was not requested until after ${payload.postDate}, so this money cannot be paying it`;
        }
    }
    // Before the generic zero-match message: the photo path may already have
    // applied this same check, which makes the milestone Paid and therefore
    // invisible to the Pending query — the common SEQUENTIAL case.
    const base = union.length === 0
        ? `no requested pending milestone matches ${amountLabel} (a milestone only becomes a candidate once its invoice has actually been sent)`
        : `the only milestone at ${amountLabel} — ${describeCandidates(union.map(describeOne))} — is already ${union[0].status}`;
    const twin = await findAppliedTwin(row, payload.amountCents, payload.postDate, null);
    return twin ? `${base} — ${appliedTwinNote(twin)}` : base;
}

/** `proposed`: the match resolved, nothing was written. Terminal for today;
 *  the next daily POST re-evaluates it. The would-apply milestone is recorded
 *  so the shadow week can be compared against QuickBooks by hand — and so the
 *  cross-source claim check can see the intent. */
async function finalizeProposed(row: DepositIngest, scheduleId: string, note: string): Promise<NextResponse> {
    await prisma.depositIngest.update({
        where: { id: row.id },
        data: { status: "proposed", paymentScheduleId: scheduleId, lastError: note.slice(0, 1000) },
    });
    return NextResponse.json({ ok: true, status: "proposed", scheduleId, reason: note });
}

class CrossSourceClaimError extends Error {}

/**
 * Reserve a milestone for this deposit, with the CROSS-SOURCE CLAIM CHECK in
 * the same transaction (Codex round 2, R1). The partial unique index only
 * arbitrates two rows reaching for the SAME milestone; it says nothing about
 * two sources reaching for two DIFFERENT milestones with the same money, which
 * is the shape the photo and bank paths can collide in (photo candidates need
 * no qbInvoiceSentAt, so a photo can reserve an unrequested milestone while the
 * sweep reserves the requested one). Whoever writes first wins; the other
 * stands down and files for a human.
 *
 * Used by BOTH paths, which is why photo rows now persist amountCents/postDate:
 * the query has to work in both directions.
 *
 * Scoped to the OTHER source, deliberately. Two rows of the SAME source at the
 * same amount are not this hazard and must not be blocked: two deposit photos
 * each carry a project name, which is what disambiguates them (the photo path's
 * matching rules are untouched by this feature), and two bank credits are
 * already covered by the batch collision rule, the 14-day Paid union and the
 * applied-row lookup. The match is written as a POSITIVE source equality rather
 * than `not: row.source` because Prisma's `not` also matches NULL rows — with a
 * null source meaning "photo", `not` would make photo-vs-photo collide, which
 * is exactly the case being excluded here.
 */
async function reserveMilestone(
    row: DepositIngest,
    scheduleId: string,
    claim: { amountCents: number | null; postDate: string | null },
): Promise<{ ok: true } | { ok: false; reason: string }> {
    // null source = the photo path, the same normalisation findAppliedTwin uses.
    const otherSource = row.source === BANK_DEPOSIT_SOURCE ? null : BANK_DEPOSIT_SOURCE;
    // …and DIRECTIONAL statuses (see the two lists in deposit-sweep.ts): from the
    // photo side a `proposed` bank row is NOT a claim, because that state exists
    // precisely to hold the sweep back while the photo path gets first dibs.
    const claimStatuses = otherSource === BANK_DEPOSIT_SOURCE
        ? [...MONEY_BOUNDARY_CLAIM_STATUSES]
        : [...CLAIMING_STATUSES];
    try {
        await withTxRetry(() => prisma.$transaction(async (tx) => {
            if (claim.amountCents != null && claim.postDate) {
                // The claim check is a READ followed by a WRITE, and under READ
                // COMMITTED two transactions at the same amount can both read
                // "nobody else is claiming this" and then both write. Serialize
                // the domain first: an advisory lock keyed on the AMOUNT (the
                // only thing the two sources share) is held to the end of this
                // transaction, so the second entrant blocks here and then sees
                // the first one's row. Cheap, deadlock-free (one lock, always
                // taken first), and released by commit or rollback either way.
                await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`deposit-claim:${claim.amountCents}`}))`;
                const other = await tx.depositIngest.findFirst({
                    where: {
                        id: { not: row.id },
                        source: otherSource,
                        amountCents: claim.amountCents,
                        postDate: {
                            gte: isoDateToUtc(isoDaysBefore(claim.postDate, CROSS_SOURCE_CLAIM_WINDOW_DAYS)),
                            lte: isoDateToUtc(isoDaysAfter(claim.postDate, CROSS_SOURCE_CLAIM_WINDOW_DAYS)),
                        },
                        status: { in: claimStatuses },
                    },
                    select: { fileId: true, source: true, bankReference: true, status: true, paymentScheduleId: true, postDate: true },
                });
                if (other) throw new CrossSourceClaimError(crossSourceClaimNote({ ...other, postDate: isoOf(other.postDate) }));
            }
            await tx.depositIngest.update({ where: { id: row.id }, data: { paymentScheduleId: scheduleId } });
        }));
        return { ok: true };
    } catch (e: any) {
        if (e instanceof CrossSourceClaimError) return { ok: false, reason: e.message };
        if (e?.code === "P2002") {
            const winner = await prisma.depositIngest.findFirst({
                where: { id: { not: row.id }, paymentScheduleId: scheduleId },
                orderBy: { updatedAt: "desc" },
                select: { fileId: true, source: true, bankReference: true, status: true, paymentScheduleId: true, postDate: true },
            });
            return { ok: false, reason: reservationLostNote(winner ? { ...winner, postDate: isoOf(winner.postDate) } : null) };
        }
        throw e;
    }
}

/** The applied row from the OTHER source that most likely IS this same money
 *  (`wantSource` null = the photo path, "bank" = the sweep). */
async function findAppliedTwin(
    row: DepositIngest,
    amountCents: number | null,
    postDate: string | null,
    wantSource: string | null,
): Promise<{ source: string | null; fileId: string; bankReference: string | null; postDate: string | null } | null> {
    if (amountCents == null || !postDate) return null;
    const twin = await prisma.depositIngest.findFirst({
        where: {
            id: { not: row.id },
            status: "applied",
            source: wantSource,
            amountCents,
            postDate: {
                gte: isoDateToUtc(isoDaysBefore(postDate, CROSS_SOURCE_CLAIM_WINDOW_DAYS)),
                lte: isoDateToUtc(isoDaysAfter(postDate, CROSS_SOURCE_CLAIM_WINDOW_DAYS)),
            },
        },
        orderBy: { updatedAt: "desc" },
        select: { source: true, fileId: true, bankReference: true, postDate: true },
    });
    return twin ? { ...twin, postDate: isoOf(twin.postDate) } : null;
}

// ── Terminal-state helpers ───────────────────────────────────────────────────

// Terminal state is ALWAYS persisted before the review task is created: a crash
// between the two leaves a terminal row whose missing task is healed on the next
// re-POST (the terminal-state reads above call ensureReviewTask), whereas the
// reverse order would leave a NON-terminal row that re-runs the match on the next
// retry and files a duplicate task. A briefly-missing task is also visible
// elsewhere (the bot parks the file in _Needs Review); a duplicate would not be.
async function finalizeUnmatched(
    row: DepositIngest,
    reason: string,
    opts: { fileTask?: boolean } = {},
): Promise<NextResponse> {
    // "unmatched" is not in the partial reservation index's status list, so this
    // transition releases any held milestone reservation by itself.
    await prisma.depositIngest.update({ where: { id: row.id }, data: { status: "unmatched", lastError: reason.slice(0, 1000) } });
    // `fileTask: false` is for rows nobody needs to see — a bank credit that is
    // simply not a customer deposit. The row still exists (and still blocks a
    // re-sweep, since its reference is terminal), it just isn't noise on the
    // /tasks board.
    const fileTask = opts.fileTask ?? true;
    const officeTaskId = fileTask ? (row.officeTaskId ?? await ensureReviewTask(row, reason, "unmatched")) : row.officeTaskId;

    if (fileTask) {
        const escalated = await escalateUnseenBankReview(row, reason, officeTaskId);
        if (escalated) return escalated;
    }
    return NextResponse.json({ ok: true, status: "unmatched", reason, officeTaskId });
}

/**
 * A SWEPT credit that needs a human but has NO OfficeTask is invisible: the bot
 * is unattended, the row is terminal, and nothing anywhere would ever surface
 * it. Record it as `reconcile` instead — the batch tallies that as unresolved
 * and the runner turns it into a non-zero exit. A noisy failure beats a silent
 * one, and this is the money path.
 *
 * Every bank route that files a task goes through here — the match paths, the
 * collision preflight, and the replay healer — because "we asked a human" is
 * only true if the asking actually happened.
 *
 * The photo path is deliberately exempt: its files also park in Drive's
 * `_Needs Review` folder, so a missing task there is not the same dead end.
 *
 * Returns the response to send, or null when nothing needed escalating.
 */
async function escalateUnseenBankReview(
    row: DepositIngest,
    reason: string,
    officeTaskId: string | null,
): Promise<NextResponse | null> {
    if (officeTaskId || row.source !== BANK_DEPOSIT_SOURCE) return null;
    const escalated = `${reason} — AND the review task could not be filed, so nothing would have surfaced this`;
    await prisma.depositIngest.update({
        where: { id: row.id },
        data: { status: "reconcile", lastError: escalated.slice(0, 1000) },
    });
    return NextResponse.json({ ok: true, status: "reconcile", reason: escalated, officeTaskId: null });
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

// A local copy of this parser used to live here, building LOCAL midnight. That made
// this route a SECOND writer of the calendar-day sentinel, disagreeing with
// lib/payment-date.ts's isDateOnly under any non-UTC runtime. It now shares the one
// canonical writer, parsePaymentDateInput, so there is genuinely only one.
