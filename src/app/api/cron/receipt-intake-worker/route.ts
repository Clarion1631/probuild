import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { isPaused, PAUSE_KEYS } from "@/lib/automation-settings";
import { logAutomationEvent } from "@/lib/automation-events";
import { downloadDocBytes, toSecureRef } from "@/lib/secure-storage";
import { getFreshQBTokens } from "@/lib/quickbooks-payments";
import { createQBReceiptPurchase } from "@/lib/qbo-receipt-push";
import { readReceipt } from "@/lib/receipt-intake/read";
import { bookReceipt, type BookPrismaClient } from "@/lib/receipt-intake/book";
import { backoffMs } from "@/lib/receipt-intake/route-state";
import {
    BATCH_SIZE,
    CLAIM_LEASE_MINUTES,
    CLAIM_LOCK_KEY,
    isStrongKeyConflict,
    runIntakeWorker,
    type ReadPatch,
    type WorkerDependencies,
    type WorkerRow,
} from "@/lib/receipt-intake/worker";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Receipt Pipeline v2 worker (docs/plans/PHASE-1-INTAKE-CORE-SPEC.md §5).
 * Every 5 minutes: claim at most 10 due rows, read/dedup/route the new ones,
 * and book the ones that are cleared to book.
 *
 * OVERLAP SAFETY. pgbouncer forbids SESSION advisory locks (a pooled
 * connection is not the same connection twice — see review-alert-rollout.ts:8),
 * so the claim runs `pg_try_advisory_xact_lock` inside ONE SHORT transaction
 * and the work happens outside it. Two defences behind that, because a lock is
 * not a correctness argument on its own:
 *   - the claim bumps every taken row's `nextRetryAt`, so even interleaved runs
 *     never hand the same row to two workers, and
 *   - QBO's DocNumber/requestid idempotency means a double booking creates one
 *     Purchase, not two.
 *
 * Auth is the fail-closed drain-notifications pattern: whenever CRON_SECRET is
 * configured it is ALWAYS required; the only unauthenticated path is a genuinely
 * local dev run (not on Vercel, not production, and no secret set).
 */

const LEASE_MS = CLAIM_LEASE_MINUTES * 60_000;

const WORKER_ROW_SELECT = {
    id: true, source: true, sourceRef: true, state: true, dryRun: true,
    projectId: true, costCodeId: true, suggestedCostCodeId: true,
    storagePath: true, fileName: true, mimeType: true, fileSize: true,
    vendor: true, txnDate: true, totalCents: true, taxCents: true,
    docType: true, refNumber: true, memo: true, attempts: true, readAt: true,
    createdAt: true,
} as const;

async function claim(): Promise<WorkerRow[] | null> {
    const now = new Date();
    return prisma.$transaction(async tx => {
        const [lock] = await tx.$queryRaw<{ locked: boolean }[]>(
            Prisma.sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${CLAIM_LOCK_KEY}, 0)) AS locked`,
        );
        if (!lock?.locked) return null;

        const due = await tx.receiptIntake.findMany({
            where: {
                state: { in: ["RECEIVED", "READ", "BOOKING"] },
                OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }],
            },
            orderBy: { createdAt: "asc" },
            take: BATCH_SIZE,
            select: WORKER_ROW_SELECT,
        });
        if (due.length === 0) return [];

        // THE claim. Anything this run took is invisible to the next one for
        // the lease, whether or not the advisory lock held.
        await tx.receiptIntake.updateMany({
            where: { id: { in: due.map(r => r.id) } },
            data: { nextRetryAt: new Date(now.getTime() + LEASE_MS) },
        });
        return due as WorkerRow[];
    });
}

function buildDeps(): WorkerDependencies {
    return {
        claim,

        loadPhases: async () => prisma.costCode.findMany({
            where: { isActive: true },
            select: { id: true, code: true, name: true },
            orderBy: { code: "asc" },
        }),

        downloadBytes: (storagePath: string) => downloadDocBytes(toSecureRef(storagePath)),

        read: (bytes, mime, phases) => readReceipt(bytes, mime, phases),

        applyRead: async (rowId, patch: ReadPatch) => {
            try {
                await prisma.receiptIntake.update({
                    where: { id: rowId },
                    data: { ...patch, lastError: null, nextRetryAt: null },
                });
                return { strongOwner: null };
            } catch (error) {
                // The partial unique index refused the claim — the DATABASE is
                // the lock the Apps Script did with Script Properties. Load the
                // owner so the caller can compare totals.
                if (!isStrongKeyConflict(error) || !patch.dedupStrongKey) throw error;
                const owner = await prisma.receiptIntake.findFirst({
                    where: {
                        dedupStrongKey: patch.dedupStrongKey,
                        state: { notIn: ["DUPLICATE", "VOID"] },
                        id: { not: rowId },
                    },
                    select: { id: true, totalCents: true },
                });
                // A conflict with no findable owner would silently re-claim on
                // the next pass; treat it as a real error instead.
                if (!owner) throw error;
                return { strongOwner: owner };
            }
        },

        findWeakHit: async (rowId, weakKey) => prisma.receiptIntake.findFirst({
            where: {
                dedupWeakKey: weakKey,
                id: { not: rowId },
                state: { notIn: ["DUPLICATE", "VOID", "NON_RECEIPT"] },
            },
            select: { id: true },
            orderBy: { createdAt: "asc" },
        }),

        applyState: async (rowId, state, stateReason, patch) => {
            await prisma.receiptIntake.update({
                where: { id: rowId },
                data: { ...(patch ?? {}), state, stateReason, nextRetryAt: null },
            });
        },

        promoteToBooking: async rowId => {
            await prisma.receiptIntake.update({
                where: { id: rowId },
                data: { state: "BOOKING", stateReason: null },
            });
        },

        book: row => bookReceipt(row, {
            db: prisma as unknown as BookPrismaClient,
            isPushEnabled: () => process.env.QBO_RECEIPT_PUSH_ENABLED === "true",
            isPushPaused: () => isPaused(PAUSE_KEYS.receiptPush),
            getTokens: getFreshQBTokens,
            createPurchase: (tokens, input) => createQBReceiptPurchase(tokens, input),
            downloadBytes: downloadDocBytes,
            logEvent: logAutomationEvent,
            now: () => new Date(),
        }),

        applyBookResult: async (rowId, result) => {
            const now = new Date();
            if (result.outcome === "booked") return; // bookReceipt already committed it
            if (result.outcome === "needs-review") {
                await prisma.receiptIntake.update({
                    where: { id: rowId },
                    data: { state: "NEEDS_REVIEW", stateReason: result.reason, nextRetryAt: null },
                });
                return;
            }
            if (result.outcome === "deferred") {
                // A switch is off: hold in BOOKING, look again in an hour, and
                // do NOT spend an attempt — this document did nothing wrong.
                await prisma.receiptIntake.update({
                    where: { id: rowId },
                    data: {
                        state: "BOOKING",
                        stateReason: result.reason,
                        nextRetryAt: new Date(now.getTime() + 60 * 60_000),
                    },
                });
                return;
            }
            await prisma.receiptIntake.update({
                where: { id: rowId },
                data: {
                    state: "BOOKING",
                    attempts: result.attempts,
                    lastError: result.reason.slice(0, 400),
                    nextRetryAt: result.nextRetryAt,
                },
            });
        },

        deferRead: async (rowId, _decisive, reason) => {
            // The service was unavailable; the document was never read, so this
            // costs no attempt — only a delay. Reuses the booking backoff table
            // so one outage does not hammer Gemini from every row at once.
            await prisma.receiptIntake.update({
                where: { id: rowId },
                data: {
                    lastError: reason,
                    nextRetryAt: new Date(Date.now() + backoffMs(1)),
                },
            });
        },

        now: () => new Date(),
    };
}

export async function GET(request: Request) {
    const secret = process.env.CRON_SECRET;
    const authHeader = request.headers.get("authorization");
    const authed = !!secret && authHeader === `Bearer ${secret}`;
    const isLocalDev = !process.env.VERCEL && process.env.NODE_ENV !== "production" && !secret;
    if (!authed && !isLocalDev) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const summary = await runIntakeWorker(buildDeps());
    if (summary.processed > 0 || summary.skipped) {
        console.log("[cron/receipt-intake-worker]", JSON.stringify(summary));
    }
    return NextResponse.json(summary);
}
