/**
 * Front Desk v1 §3 — the transfer bridge's DB state machine: prepare-transfer
 * (§3.1), the bridge-twiml claim/screen/action transitions (§3.2), the
 * missed-transfer alert (§3.4), and the per-minute sweep (§3.4) that also
 * runs the booking reconciler (§2.3) — the cron touch point calls exactly
 * one function, `runFrontDeskSweeps`.
 */
import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { normalizeCallerPhoneE164 } from "@/lib/speed-to-lead/intake";
import { upsertFrontDeskLeadInTx } from "./intake";
import { reconcileFrontDeskBookings } from "./booking";
import {
    FRONT_DESK_TRANSFER_PREPARED_TTL_MS, FRONT_DESK_SWEEP_DIALING_MISS_MS, FRONT_DESK_SWEEP_CONNECTED_STALE_MS,
    isWithinTransferHours,
} from "./constants";

// ── §3.1 prepare-transfer tool ──────────────────────────────────────────

export type PrepareTransferReason =
    | "richard_unavailable" | "outside_hours" | "busy" | "already_transferred" | "invalid_phone" | "readback_incomplete";

export type PrepareTransferOutcome =
    | { kind: "transfer_ready" }
    | { kind: "no_transfer"; reason: PrepareTransferReason };

export interface PrepareTransferInput {
    conversationId: string;
    agentId: string | null;
    isTest: boolean;
    callerName: string;
    callbackPhone: string;
    city: string;
    project: string;
    spanish: boolean;
    readbackConfirmed: boolean;
}

function isUniqueViolation(err: unknown): boolean {
    return (err as { code?: string } | null)?.code === "P2002";
}

function violationMentions(err: unknown, needle: string): boolean {
    const meta = (err as { meta?: { target?: string[] | string } } | null)?.meta;
    const target = meta?.target;
    const targetStr = Array.isArray(target) ? target.join(",") : String(target ?? "");
    if (targetStr.toLowerCase().includes(needle.toLowerCase())) return true;
    return String((err as { message?: string } | null)?.message ?? "").toLowerCase().includes(needle.toLowerCase());
}

/**
 * §3.1. Assumes the caller has already checked `frontDeskMode() !== "OFF"`
 * (the route's own gate, like every other tool route) — this function starts
 * from "richard_unavailable".
 */
export async function handlePrepareTransferTool(db: PrismaClient, input: PrepareTransferInput, now: Date = new Date()): Promise<PrepareTransferOutcome> {
    if (!input.callerName?.trim() || !input.callbackPhone?.trim() || !input.city?.trim() || !input.project?.trim() || typeof input.spanish !== "boolean") {
        return { kind: "no_transfer", reason: "readback_incomplete" };
    }
    if (input.readbackConfirmed !== true) return { kind: "no_transfer", reason: "readback_incomplete" };
    const phoneE164 = normalizeCallerPhoneE164(input.callbackPhone);
    if (!phoneE164) return { kind: "no_transfer", reason: "invalid_phone" };

    const settings = await db.companySettings.findUnique({ where: { id: "singleton" }, select: { frontDeskTakingTransfers: true } });
    if (!settings?.frontDeskTakingTransfers) return { kind: "no_transfer", reason: "richard_unavailable" };
    if (!isWithinTransferHours(now)) return { kind: "no_transfer", reason: "outside_hours" };

    try {
        await db.$transaction(async tx => {
            await tx.$executeRaw`
                UPDATE "FrontDeskTransfer" SET status = 'EXPIRED', "resolvedAt" = now(), reason = 'stale-prepared'
                WHERE status = 'PREPARED' AND "preparedAt" < ${new Date(now.getTime() - FRONT_DESK_TRANSFER_PREPARED_TTL_MS)}`;

            await tx.frontDeskTransfer.create({
                data: {
                    id: randomUUID(),
                    conversationId: input.conversationId,
                    status: "PREPARED",
                    isTest: input.isTest,
                    callerName: input.callerName.trim(),
                    callbackPhoneE164: phoneE164,
                    city: input.city.trim(),
                    project: input.project.trim(),
                    spanish: input.spanish,
                    preparedAt: now,
                },
            });
        });
        return { kind: "transfer_ready" };
    } catch (err) {
        if (isUniqueViolation(err) && violationMentions(err, "conversationId")) {
            return { kind: "no_transfer", reason: "already_transferred" };
        }
        if (isUniqueViolation(err)) {
            return { kind: "no_transfer", reason: "busy" };
        }
        throw err;
    }
}

// ── §3.2 bridge-twiml transitions ────────────────────────────────────────

export type InboundClaimResult =
    | { kind: "retry"; transferId: string }
    | { kind: "claimed"; transferId: string }
    | { kind: "reject" };

/** §3.2 step "inbound": idempotent retry check, then the SKIP LOCKED claim. */
export async function resolveInboundBridgeClaim(db: PrismaClient, callSid: string, now: Date = new Date()): Promise<InboundClaimResult> {
    const existing = await db.frontDeskTransfer.findUnique({ where: { bridgeCallSid: callSid } });
    if (existing) {
        // A row can carry this CallSid and NOT be DIALING — the claim below
        // stamps bridgeCallSid and DIALING in one statement, but the
        // richard-unavailable-at-claim branch right after can immediately
        // flip it to EXPIRED. A retried inbound webhook for that CallSid
        // must not re-emit live dial TwiML for an already-expired row.
        return existing.status === "DIALING" ? { kind: "retry", transferId: existing.id } : { kind: "reject" };
    }

    return db.$transaction(async tx => {
        const rows = await tx.$queryRaw<{ id: string }[]>`
            UPDATE "FrontDeskTransfer" SET status = 'DIALING', "bridgeCallSid" = ${callSid}, "dialStartedAt" = now(), "updatedAt" = now()
            WHERE id = (
                SELECT id FROM "FrontDeskTransfer"
                WHERE status = 'PREPARED' AND "preparedAt" > ${new Date(now.getTime() - FRONT_DESK_TRANSFER_PREPARED_TTL_MS)}
                ORDER BY "preparedAt" LIMIT 1 FOR UPDATE SKIP LOCKED
            )
            RETURNING id`;
        const claimedId = rows[0]?.id;
        if (!claimedId) return { kind: "reject" as const };

        const settings = await tx.companySettings.findUnique({ where: { id: "singleton" }, select: { frontDeskTakingTransfers: true } });
        if (!settings?.frontDeskTakingTransfers) {
            await tx.frontDeskTransfer.update({ where: { id: claimedId }, data: { status: "EXPIRED", resolvedAt: now, reason: "richard-unavailable-at-claim" } });
            return { kind: "reject" as const };
        }
        return { kind: "claimed" as const, transferId: claimedId };
    });
}

/** §3.2 step "screen": the row `t` must be DIALING, and `ParentCallSid` (when present) must equal `bridgeCallSid`. */
export function isValidScreenRequest(transfer: { status: string; bridgeCallSid: string | null } | null, parentCallSid: string | null): boolean {
    if (!transfer || transfer.status !== "DIALING") return false;
    if (parentCallSid && transfer.bridgeCallSid && parentCallSid !== transfer.bridgeCallSid) return false;
    return true;
}

/** §3.2 step "screen-result": exactly `Digits === "1"` accepts. */
export async function resolveScreenResult(db: PrismaClient, transferId: string, digits: string | null, parentCallSid: string | null, now: Date = new Date()): Promise<boolean> {
    if (digits !== "1") return false;
    const transfer = await db.frontDeskTransfer.findUnique({ where: { id: transferId } });
    if (!isValidScreenRequest(transfer, parentCallSid)) return false;
    const updated = await db.frontDeskTransfer.updateMany({
        where: { id: transferId, status: "DIALING", screenAcceptedAt: null },
        data: { screenAcceptedAt: now },
    });
    return updated.count > 0;
}

export type ActionOutcome = "connected" | "missed" | "duplicate" | "not_found";

/**
 * §3.2 step "action": Connected = `DialBridged==="true"` AND `screenAcceptedAt`
 * set. `DialBridged=true` without acceptance is the anomaly case,
 * `bridged-without-screen` — MISSED, alerted (the safe side).
 */
export async function resolveActionStep(
    db: PrismaClient,
    params: { transferId: string; bridgeCallSid: string; dialCallStatus: string | null; dialBridged: string | null },
    now: Date = new Date(),
): Promise<ActionOutcome> {
    return db.$transaction(async tx => {
        const transfer = await tx.frontDeskTransfer.findUnique({ where: { id: params.transferId } });
        if (!transfer) return "not_found";
        if (transfer.status !== "DIALING") {
            return transfer.bridgeCallSid === params.bridgeCallSid ? "duplicate" : "not_found";
        }

        const dialBridgedBool = params.dialBridged === "true";
        const connected = dialBridgedBool && !!transfer.screenAcceptedAt;
        const reason = connected ? null : dialBridgedBool ? "bridged-without-screen" : "no-answer";

        const updated = await tx.frontDeskTransfer.updateMany({
            where: { id: params.transferId, bridgeCallSid: params.bridgeCallSid, status: "DIALING" },
            data: {
                status: connected ? "CONNECTED" : "MISSED",
                dialCallStatus: params.dialCallStatus,
                dialBridged: dialBridgedBool,
                resolvedAt: now,
                reason,
            },
        });
        if (updated.count === 0) return "duplicate";

        if (!connected) await sendMissedTransferAlert(tx, params.transferId);
        return connected ? "connected" : "missed";
    });
}

// ── §3.4 missed-transfer alert ──────────────────────────────────────────

async function sendMissedTransferAlert(tx: Prisma.TransactionClient, transferId: string): Promise<void> {
    const transfer = await tx.frontDeskTransfer.findUniqueOrThrow({ where: { id: transferId } });
    const result = await upsertFrontDeskLeadInTx(tx, {
        conversationId: transfer.conversationId,
        source: "transfer",
        facts: {
            callerName: transfer.callerName,
            callbackPhone: transfer.callbackPhoneE164,
            email: null,
            city: transfer.city,
            projectType: transfer.project,
            projectSummary: null,
            preferredTimes: null,
            messageForRichard: null,
            transcriptSummary: null,
        },
        outcome: "MISSED_TRANSFER",
        reasons: ["front-desk-missed-transfer"],
        isTest: transfer.isTest,
        needLead: true,
        extraChannels: ["NTFY_URGENT"],
    });
    if (result.leadId && !transfer.leadId) {
        await tx.frontDeskTransfer.update({ where: { id: transferId }, data: { leadId: result.leadId } });
    }
}

// ── §3.4 sweep + §2.3 reconciler, run together every minute ─────────────

async function sweepTransfers(now: Date, db: PrismaClient): Promise<number> {
    let count = 0;

    const expiredPrepared = await db.frontDeskTransfer.updateMany({
        where: { status: "PREPARED", preparedAt: { lt: new Date(now.getTime() - FRONT_DESK_TRANSFER_PREPARED_TTL_MS) } },
        data: { status: "EXPIRED", resolvedAt: now, reason: "stale-prepared" },
    });
    count += expiredPrepared.count;

    // An accepted call keeps the row DIALING until the Dial ends, and that
    // correctly keeps other transfers `busy` too — only reclassified as
    // CONNECTED (no alert) once it has clearly run its course.
    const staleAccepted = await db.frontDeskTransfer.findMany({
        where: { status: "DIALING", screenAcceptedAt: { lt: new Date(now.getTime() - FRONT_DESK_SWEEP_CONNECTED_STALE_MS) } },
        select: { id: true },
    });
    for (const row of staleAccepted) {
        const updated = await db.frontDeskTransfer.updateMany({
            where: { id: row.id, status: "DIALING" },
            data: { status: "CONNECTED", resolvedAt: now, reason: "no-action-callback" },
        });
        count += updated.count;
    }

    // Covers a caller or ElevenLabs hanging up before Twilio's `action` ever arrives.
    const staleUnaccepted = await db.frontDeskTransfer.findMany({
        where: { status: "DIALING", screenAcceptedAt: null, dialStartedAt: { lt: new Date(now.getTime() - FRONT_DESK_SWEEP_DIALING_MISS_MS) } },
        select: { id: true },
    });
    for (const row of staleUnaccepted) {
        const swept = await db.$transaction(async tx => {
            const updated = await tx.frontDeskTransfer.updateMany({
                where: { id: row.id, status: "DIALING", screenAcceptedAt: null },
                data: { status: "MISSED", resolvedAt: now, reason: "no-action-callback" },
            });
            if (updated.count > 0) await sendMissedTransferAlert(tx, row.id);
            return updated.count;
        });
        count += swept;
    }

    return count;
}

/**
 * The cron touch point: called once a minute whenever `frontDeskMode() !==
 * "OFF"`. Runs the transfer sweep (§3.4) and the booking reconciler (§2.3).
 */
export async function runFrontDeskSweeps(now: Date = new Date(), db: PrismaClient = prisma): Promise<{ transfersSwept: number; bookingsChecked: number }> {
    const transfersSwept = await sweepTransfers(now, db);
    const { checked } = await reconcileFrontDeskBookings(now, db);
    return { transfersSwept, bookingsChecked: checked };
}
