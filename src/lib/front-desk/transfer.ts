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
    FRONT_DESK_INTAKE_TX_TIMEOUT_MS, FRONT_DESK_INTAKE_TX_MAX_WAIT_MS,
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

    // SHIP-BLOCKING fix (round 3 review of PR #559): resolveInboundBridgeClaim,
    // below, still attributes a CallSid to a PREPARED row by timing — a
    // conference transfer carries no correlating value of its own for the
    // FIRST inbound leg to the bridge number (verified again here: Twilio's
    // params on that leg are CallSid/AccountSid/To/From only, and `From` is
    // always the front-desk number, never the caller's — there is nothing to
    // match on). So a delayed or racing claim can still mark the WRONG
    // transfer CONNECTED, leaving the real caller with no missed-transfer
    // alert and the sweep ignoring a row that already looks resolved. That
    // failure mode was only fatal because a mis-attributed caller had
    // NOTHING else on file. This closes it a different way, independent of
    // post-call delivery or of CONNECTED attribution ever being right: the
    // instant the caller's own details are confirmed (right here — before we
    // even know whether Richard can take the call, so this also covers
    // richard_unavailable/outside_hours/busy/already_transferred, every one
    // of which still means a real caller was just read back their own
    // details), durably create/enrich their lead through the same v1a intake
    // path post-call uses and queue the STANDARD alert immediately.
    // `conversationId` is upsertFrontDeskLeadInTx's idempotency key
    // (`fd:<conversationId>`), so a retried prepare_transfer call, or this
    // same call's later post-call/missed-transfer alert, only enriches this
    // one row — post-call (source: "post-call") always wins a field
    // conflict, and outcome/reasons are safely overwritten by whatever
    // resolves the call for real. A wrong or failed CONNECTED attribution,
    // or the post-call webhook never arriving at all, can now never lose
    // this caller: the lead and the standard alert already exist before the
    // bridge is ever dialed.
    const earlyLead = await db.$transaction(tx => upsertFrontDeskLeadInTx(tx, {
        conversationId: input.conversationId,
        source: "transfer",
        facts: {
            callerName: input.callerName.trim(),
            callbackPhone: phoneE164,
            email: null,
            city: input.city.trim(),
            projectType: input.project.trim(),
            projectSummary: null,
            preferredTimes: null,
            messageForRichard: null,
            transcriptSummary: null,
        },
        outcome: "MESSAGE",
        reasons: ["front-desk-transfer-pending"],
        isTest: input.isTest,
        needLead: true,
        extraChannels: [],
    }), { timeout: FRONT_DESK_INTAKE_TX_TIMEOUT_MS, maxWait: FRONT_DESK_INTAKE_TX_MAX_WAIT_MS });

    const settings = await db.companySettings.findUnique({ where: { id: "singleton" }, select: { frontDeskTakingTransfers: true } });
    if (!settings?.frontDeskTakingTransfers) return { kind: "no_transfer", reason: "richard_unavailable" };
    if (!isWithinTransferHours(now)) return { kind: "no_transfer", reason: "outside_hours" };

    try {
        await db.$transaction(async tx => {
            // Codex SHIP-BLOCKING finding #2 (round 1 review of PR #559):
            // this cleanup silently dropped its own caller with no alert and
            // no lead — the post-call webhook is this call's only remaining
            // safety net, and if it never arrives (agent crash, delivery
            // failure) that caller vanishes with zero trace. Every row this
            // expires gets the same missed-transfer alert a real MISSED
            // transition gets; `RETURNING id` is what lets us know which
            // rows to alert for without a second read.
            const expiredRows = await tx.$queryRaw<{ id: string }[]>`
                UPDATE "FrontDeskTransfer" SET status = 'EXPIRED', "resolvedAt" = now(), reason = 'stale-prepared'
                WHERE status = 'PREPARED' AND "preparedAt" < ${new Date(now.getTime() - FRONT_DESK_TRANSFER_PREPARED_TTL_MS)}
                RETURNING id`;
            for (const row of expiredRows) await sendMissedTransferAlert(tx, row.id);

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
                    leadId: earlyLead.leadId,
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

/**
 * Every caller/CallSid combination below shares this one advisory-lock key
 * space. Keying on the CallSid string (not a fixed constant, unlike
 * booking.ts's single global lock) means only concurrent requests for the
 * SAME CallSid ever contend — two different callers' inbound webhooks still
 * run fully in parallel.
 */
function callSidLockKey(callSid: string): string {
    return `front-desk-bridge-callsid:${callSid}`;
}

/**
 * §3.2 step "inbound": idempotent retry check, then the SKIP LOCKED claim.
 *
 * KNOWN-RISK, narrowed (Codex round-2 review of PR #559; round-3 follow-up
 * closed the concurrency half). The claim below still binds a CallSid to
 * whichever PREPARED row exists, by timing only — re-checked again in round
 * 3: there is genuinely no caller-supplied identifier to bind to instead,
 * because ElevenLabs' `transfer_to_number` (conference type) places the call
 * to the bridge number through the number's own static Voice URL, with no
 * custom headers or params of its own (spec `docs/plans/FRONT-DESK-V1.md`
 * line ~336, "Conference transfers don't support custom headers, so the
 * bridge gets its caller details from `prepare_transfer`" — the very reason
 * this table-based handoff exists). Twilio's own params on this leg —
 * CallSid, AccountSid, To, From — carry nothing to correlate on: `To`/`From`
 * are the same two fixed numbers on every single inbound leg. If one
 * caller's transfer attempt is delayed past this row's own
 * `FRONT_DESK_TRANSFER_PREPARED_TTL_MS` AND a second, unrelated caller
 * prepares in that gap, the first caller's late inbound webhook can still
 * claim the second caller's PREPARED row, and a successful bridge then marks
 * the second caller CONNECTED with the first caller's details spoken to
 * Richard. Closing THAT fully needs a correlator this architecture doesn't
 * have (e.g. a dedicated bridge number per active transfer); still accepted
 * as a known risk pending that product decision.
 *
 * What round 3 DOES close: this is no longer a way to silently lose a
 * caller. `handlePrepareTransferTool` now creates that caller's lead and
 * queues the standard alert the moment their details are confirmed, before
 * any bridge attempt — so a wrong claim can misfile which transfer gets
 * marked CONNECTED/MISSED and which reason a sweep or the settings page
 * shows, but it can never leave a caller with zero record. And separately,
 * every claim/reject decision for a given CallSid is now serialized behind
 * `pg_advisory_xact_lock` (below): two concurrent deliveries of what is
 * "the same" CallSid (a genuine race, not just a sequential retry) used to
 * be able to run the `existing` lookup and the SKIP LOCKED claim query
 * fully in parallel — one could see no `existing` row, lose the claim race
 * via SKIP LOCKED, and land in `persistUnmatchedInboundReject` at the same
 * moment the other was still mid-claim, racing two independent writers
 * against the same unique `bridgeCallSid` column with no ordering between
 * them. Now the whole decision (existing-lookup, claim-or-reject) runs
 * inside one lock per CallSid, so the second request always sees the
 * first's committed result before deciding anything of its own.
 */
export async function resolveInboundBridgeClaim(db: PrismaClient, callSid: string, now: Date = new Date()): Promise<InboundClaimResult> {
    return db.$transaction(async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${callSidLockKey(callSid)}))`;

        const existing = await tx.frontDeskTransfer.findUnique({ where: { bridgeCallSid: callSid } });
        if (existing) {
            // A row can carry this CallSid and NOT be DIALING — the claim below
            // stamps bridgeCallSid and DIALING in one statement, but the
            // richard-unavailable-at-claim branch right after can immediately
            // flip it to EXPIRED. A retried inbound webhook for that CallSid
            // must not re-emit live dial TwiML for an already-expired row.
            return existing.status === "DIALING" ? { kind: "retry" as const, transferId: existing.id } : { kind: "reject" as const };
        }

        const rows = await tx.$queryRaw<{ id: string }[]>`
            UPDATE "FrontDeskTransfer" SET status = 'DIALING', "bridgeCallSid" = ${callSid}, "dialStartedAt" = now(), "updatedAt" = now()
            WHERE id = (
                SELECT id FROM "FrontDeskTransfer"
                WHERE status = 'PREPARED' AND "preparedAt" > ${new Date(now.getTime() - FRONT_DESK_TRANSFER_PREPARED_TTL_MS)}
                ORDER BY "preparedAt" LIMIT 1 FOR UPDATE SKIP LOCKED
            )
            RETURNING id`;
        const claimedId = rows[0]?.id;
        if (!claimedId) {
            // Codex SHIP-BLOCKING finding #4 (round 1 review of PR #559): an
            // unmatched inbound request left NO record of this CallSid's
            // decision. A Twilio retry of the SAME request (its response was
            // lost in transit, not a real failure) re-ran this whole
            // function with nothing to find via the `existing` lookup above
            // — if a DIFFERENT caller had since become PREPARED, the retry
            // would claim THEIR transfer and stamp this stale CallSid onto
            // it, silently stealing it from its real inbound webhook (which
            // would then find no eligible row and reject THAT caller). Every
            // authenticated CallSid's decision must be persisted so a retry
            // is idempotent — see persistUnmatchedInboundReject. The
            // CallSid-keyed advisory lock above means nothing else can be
            // deciding this SAME CallSid's fate concurrently any more.
            await persistUnmatchedInboundReject(tx, callSid, now);
            return { kind: "reject" as const };
        }

        const settings = await tx.companySettings.findUnique({ where: { id: "singleton" }, select: { frontDeskTakingTransfers: true } });
        if (!settings?.frontDeskTakingTransfers) {
            await tx.frontDeskTransfer.update({ where: { id: claimedId }, data: { status: "EXPIRED", resolvedAt: now, reason: "richard-unavailable-at-claim" } });
            // Codex SHIP-BLOCKING finding #2: same reasoning as the
            // stale-PREPARED cleanup above — this caller was mid-transfer
            // (Twilio already dialed the bridge) when it failed, so it needs
            // the same safety net a real MISSED transition gets.
            await sendMissedTransferAlert(tx, claimedId);
            return { kind: "reject" as const };
        }
        return { kind: "claimed" as const, transferId: claimedId };
    }, { timeout: FRONT_DESK_INTAKE_TX_TIMEOUT_MS, maxWait: FRONT_DESK_INTAKE_TX_MAX_WAIT_MS });
}

/**
 * Codex SHIP-BLOCKING finding #4: persists an unmatched inbound CallSid's
 * reject decision, keyed by the SAME unique `bridgeCallSid` column the
 * claimed path already uses, so a retry finds it via `resolveInboundBridgeClaim`'s
 * `existing` lookup and never re-attempts a claim. This row is created
 * already EXPIRED with synthetic caller data — it is not a real call, never
 * participates in the one-active-transfer partial index (that only covers
 * PREPARED/DIALING), and never surfaces on the settings page (which only
 * queries PREPARED/DIALING for "active transfer"). A concurrent duplicate
 * write for the SAME CallSid (two overlapping retries) is fine to lose the
 * unique-violation race on — the other write already recorded the decision,
 * which is all this function exists to do. Both callers now hold the
 * CallSid-keyed advisory lock (`callSidLockKey`) for their whole transaction
 * before ever reaching here, so that race should no longer be reachable in
 * practice — the catch below stays as defense in depth, and now VERIFIES
 * the assumption instead of trusting the error code alone (round-3 fix).
 */
async function persistUnmatchedInboundReject(tx: Prisma.TransactionClient, callSid: string, now: Date, reason: string = "bridge-unmatched"): Promise<void> {
    try {
        await tx.frontDeskTransfer.create({
            data: {
                id: randomUUID(),
                conversationId: `reject:${callSid}`,
                status: "EXPIRED",
                isTest: false,
                callerName: "",
                callbackPhoneE164: "",
                city: "",
                project: "",
                spanish: false,
                bridgeCallSid: callSid,
                resolvedAt: now,
                reason,
            },
        });
    } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        // Round-3 fix: a bare P2002 is not, by itself, proof that THIS
        // CallSid's decision was recorded — it only proves SOME unique
        // constraint on this row conflicted (`bridgeCallSid`, the intended
        // case, but in principle also the synthetic `conversationId`).
        // Re-read by the unique column this write actually cares about and
        // confirm a decision for this exact CallSid now exists; if it
        // doesn't, this was not the benign race this catch exists for, so
        // surface the original error rather than silently swallowing it.
        const winner = await tx.frontDeskTransfer.findUnique({ where: { bridgeCallSid: callSid }, select: { id: true } });
        if (!winner) throw err;
    }
}

/**
 * Codex SHIP-BLOCKING finding #4 (round 2 follow-up, PR #559): the route's
 * own pre-checks — mode OFF, front desk not configured, To/From mismatch —
 * reject an authenticated inbound webhook WITHOUT ever calling
 * `resolveInboundBridgeClaim`, so no decision is persisted for that CallSid.
 * A Twilio retry of the identical signed request, replayed after whichever
 * gate rejected it changes (mode flips ON, config gets filled in), then
 * reaches `resolveInboundBridgeClaim` completely fresh and can claim a
 * DIFFERENT, later caller's PREPARED row — the exact bug finding #4
 * originally closed for the "no eligible row" case, reopened for these
 * three earlier exits. The route calls this directly on each of those
 * exits so every authenticated CallSid's decision is recorded, keyed by the
 * same unique `bridgeCallSid` column `resolveInboundBridgeClaim`'s own
 * `existing` lookup already checks first — a replay finds it there and
 * never reaches the claim query at all.
 *
 * Round-3 fix: this used to check `existing` and write its own reject
 * OUTSIDE any lock, so it could race `resolveInboundBridgeClaim` itself for
 * the identical CallSid — e.g. a route-level gate (mode OFF) rejecting one
 * delivery of a webhook at the same moment a concurrent delivery of "the
 * same" request reached the claim path fresh. It now takes the SAME
 * CallSid-keyed advisory lock `resolveInboundBridgeClaim` does, so whichever
 * of the two runs first fully commits its decision before the other is even
 * allowed to check `existing`.
 */
export async function recordInboundRejectIfAbsent(db: PrismaClient, callSid: string, reason: string, now: Date = new Date()): Promise<void> {
    await db.$transaction(async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${callSidLockKey(callSid)}))`;
        const existing = await tx.frontDeskTransfer.findUnique({ where: { bridgeCallSid: callSid }, select: { id: true } });
        if (existing) return;
        await persistUnmatchedInboundReject(tx, callSid, now, reason);
    }, { timeout: FRONT_DESK_INTAKE_TX_TIMEOUT_MS, maxWait: FRONT_DESK_INTAKE_TX_MAX_WAIT_MS });
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

    // Codex SHIP-BLOCKING finding #2: same "no caller left silently
    // stranded" reasoning as handlePrepareTransferTool's own stale-PREPARED
    // cleanup — this is the sweep's copy of that same cleanup, so it needs
    // the same per-row alert rather than a single bulk update.
    const stalePrepared = await db.frontDeskTransfer.findMany({
        where: { status: "PREPARED", preparedAt: { lt: new Date(now.getTime() - FRONT_DESK_TRANSFER_PREPARED_TTL_MS) } },
        select: { id: true },
    });
    for (const row of stalePrepared) {
        const swept = await db.$transaction(async tx => {
            const updated = await tx.frontDeskTransfer.updateMany({
                where: { id: row.id, status: "PREPARED" },
                data: { status: "EXPIRED", resolvedAt: now, reason: "stale-prepared" },
            });
            if (updated.count > 0) await sendMissedTransferAlert(tx, row.id);
            return updated.count;
        });
        count += swept;
    }

    // Codex SHIP-BLOCKING finding #3 (round 1 review of PR #559): pressing 1
    // (screenAcceptedAt) only proves Richard interacted with the screen
    // Gather — it is NOT confirmed bridge evidence. That's `DialBridged`,
    // set only by resolveActionStep, which always moves the row off DIALING
    // when it runs — so if this row is STILL DIALING this long after
    // acceptance, the `action` callback never arrived and we have no
    // evidence the parties ever actually connected (the TwiML response
    // could have failed, or the caller could have disconnected before the
    // bridge held). Resolve on the safe side, same as every other
    // unconfirmed-connection case in this file: MISSED, alerted — never
    // CONNECTED on an unconfirmed guess. An accepted call still keeps the
    // row DIALING (and other transfers correctly `busy`) for up to this
    // long, so a real, long call is never swept prematurely.
    const staleAccepted = await db.frontDeskTransfer.findMany({
        where: { status: "DIALING", screenAcceptedAt: { lt: new Date(now.getTime() - FRONT_DESK_SWEEP_CONNECTED_STALE_MS) } },
        select: { id: true },
    });
    for (const row of staleAccepted) {
        const swept = await db.$transaction(async tx => {
            const updated = await tx.frontDeskTransfer.updateMany({
                where: { id: row.id, status: "DIALING" },
                data: { status: "MISSED", resolvedAt: now, reason: "no-action-callback" },
            });
            if (updated.count > 0) await sendMissedTransferAlert(tx, row.id);
            return updated.count;
        });
        count += swept;
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
