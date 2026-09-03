export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { toNum } from "@/lib/prisma-helpers";
import { authenticateMobileOrSession } from "@/lib/mobile-auth";
import { resolveScheduleTaskIdForPunch } from "@/lib/punch-task-binding";
import { toCompanyDayKey } from "@/lib/company-day";
import { checkLogisticsClockOutNotes, applyMealSkippedWaiver } from "@/lib/logistics-time-entry";
import { applyNoAttestationNotice, applyRestBreakAttestation, CLOSED_LATE_NOTE, computeMealDeduction, exceedsMaxShift, MAX_SHIFT_HOURS, type MealOutcome } from "@/lib/wa-breaks";
import { deleteEntryAndSettle, flagSettlementFailed, loadDayEntries, settleDay, settleDayWithinTx, settlementCandidateIds } from "@/lib/wa-breaks-db";
import { NO_ATTESTATION_NOTE } from "@/lib/wa-breaks";
import {
    assertEntriesUnlockedInTx,
    assertPeriodUnlocked,
    dayLockKey,
    isPeriodLockedError,
    periodLockedResponse,
    withPayrollWriteTx,
} from "@/lib/payroll-period";
import {
    appendZeroRateReview,
    canAcknowledgeZeroRate,
    readOwnerRatesForUpdate,
    zeroRateBlockedResponse,
    zeroRateBlocks,
} from "@/lib/pay-rate-guard";

// Mobile + web hybrid. Two distinct flows, both routed through PATCH:
//
//   1. Edit  — body has `startTime` and/or `endTime` and `editNotes`.
//              Captures the original times the FIRST time the entry is edited
//              (so the audit trail preserves the as-clocked values), recomputes
//              durationHours / laborCost / burdenCost from the OWNER's rates
//              (not the editor's), and stamps `editedByManagerId` + `editedAt`
//              when a manager edits someone else's punch.
//
//   2. Offsite telemetry — body has `offsiteMs` / `isOffsite` / `lastLocationCheck`.
//                          Mobile geofence watcher hits this every minute or on
//                          a state change; we accept the absolute offsite_ms the
//                          mobile reports so retries don't double-count.
/** The owner's rate became unusable between the pre-read and the write. */
class ZeroRateAtWriteError extends Error {
    constructor() {
        super("Zero rate at write time");
        this.name = "ZeroRateAtWriteError";
    }
}

/** Coded refusal so a client can recognise "this row is not what you were shown". */
const ENTRY_MOVED_CODE = "ENTRY_MOVED";

/** The targeted row moved (or vanished) between the pre-read and the write. */
class EntryMovedError extends Error {
    constructor() {
        super("Time entry moved");
        this.name = "EntryMovedError";
    }
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
    const auth = await authenticateMobileOrSession(req);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const { user } = auth;

    const { id } = await params;
    if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

    const existing = await prisma.timeEntry.findUnique({ where: { id } });
    if (!existing) return NextResponse.json({ error: "Time entry not found" }, { status: 404 });

    const isOwner = existing.userId === user.id;
    const isPrivileged = user.role === "MANAGER" || user.role === "ADMIN";

    // Field crew can edit their own; managers/admins can edit anyone's.
    if (!isOwner && !isPrivileged) {
        return NextResponse.json({ error: "Unauthorized to edit this entry" }, { status: 403 });
    }

    const body = await req.json();

    // -------- Branch detection. We refuse to mix the two flows in one request because
    // edits recompute laborCost while telemetry must NOT touch it; combining them would
    // either silently drop telemetry (the bug Codex flagged) or recompute cost off
    // partial inputs. Mobile sends one or the other.
    const telemetryFields = ["offsiteMs", "isOffsite", "lastLocationCheck"] as const;
    const editFields = ["startTime", "endTime", "editNotes"] as const;
    const hasTelemetry = telemetryFields.some((k) => body[k] !== undefined);
    const hasEdit = editFields.some((k) => body[k] !== undefined);

    if (hasTelemetry && hasEdit) {
        return NextResponse.json(
            { error: "Cannot mix telemetry fields with edit fields in one request" },
            { status: 400 }
        );
    }

    if (hasTelemetry) {
        // Telemetry only flows from the owner's own device — even a manager shouldn't
        // be writing geofence data for someone else.
        if (!isOwner) {
            return NextResponse.json(
                { error: "Telemetry can only be reported by the entry owner" },
                { status: 403 }
            );
        }
        const data: Record<string, unknown> = {};
        if (body.offsiteMs !== undefined) {
            if (
                typeof body.offsiteMs !== "number" ||
                !Number.isFinite(body.offsiteMs) ||
                body.offsiteMs < 0
            ) {
                return NextResponse.json({ error: "offsiteMs must be a non-negative number" }, { status: 400 });
            }
            data.offsiteMs = Math.floor(body.offsiteMs);
        }
        if (body.isOffsite !== undefined) {
            if (typeof body.isOffsite !== "boolean") {
                return NextResponse.json({ error: "isOffsite must be a boolean" }, { status: 400 });
            }
            data.isOffsite = body.isOffsite;
        }
        if (body.lastLocationCheck !== undefined) {
            if (typeof body.lastLocationCheck !== "string") {
                return NextResponse.json({ error: "lastLocationCheck must be an ISO string" }, { status: 400 });
            }
            const d = new Date(body.lastLocationCheck);
            if (Number.isNaN(d.getTime())) {
                return NextResponse.json({ error: "Invalid lastLocationCheck" }, { status: 400 });
            }
            data.lastLocationCheck = d;
        }
        if (Object.keys(data).length === 0) {
            return NextResponse.json({ error: "No telemetry fields supplied" }, { status: 400 });
        }
        // CONDITIONAL on the owner this request was authorized for. The
        // ownership check above ran against a copy read before this write, so a
        // reassignment in between would let one worker's phone stamp geofence
        // data onto somebody else's punch — and telemetry is deliberately
        // owner-only, even for a manager.
        //
        // Routed through the same payroll-period guard every other TimeEntry
        // writer uses (src/lib/payroll-period.ts), even though telemetry
        // touches no hours, cost or readiness flag: withPayrollWriteTx row-locks
        // `id` and checks its STORED startTime against any locked period before
        // this write runs. An unguarded raw call here was the one writer the
        // payroll-writer-manifest test could not tell apart from the guarded
        // edit claim below — both call the same TimeEntry write method on this
        // same file, and the manifest used to key on file+method, so one entry
        // silently vouched for both.
        let claimed: { count: number };
        try {
            claimed = await withPayrollWriteTx({ entryIds: [id] }, async (tx) => {
                const client = tx as unknown as typeof prisma;
                return client.timeEntry.updateMany({
                    where: { id, userId: user.id },
                    data,
                });
            });
        } catch (error) {
            if (isPeriodLockedError(error)) return periodLockedResponse(error.period);
            throw error;
        }
        if (claimed.count !== 1) {
            return NextResponse.json(
                {
                    error: "That time entry is no longer yours — it moved while this report was in flight.",
                    code: ENTRY_MOVED_CODE,
                },
                { status: 409 }
            );
        }
        const updated = await prisma.timeEntry.findUniqueOrThrow({ where: { id } });
        return NextResponse.json(JSON.parse(JSON.stringify(updated)));
    }

    // -------- Branch 2: edit with reason. Recompute costs from OWNER's rates. --------
    if (!hasEdit) {
        return NextResponse.json(
            { error: "Provide either telemetry fields or edit fields" },
            { status: 400 }
        );
    }
    if (!body.editNotes || typeof body.editNotes !== "string" || !body.editNotes.trim()) {
        return NextResponse.json({ error: "editNotes is required for time-entry edits" }, { status: 400 });
    }

    const newStart = body.startTime ? new Date(body.startTime) : existing.startTime;
    const newEnd =
        body.endTime === null ? null : body.endTime ? new Date(body.endTime) : existing.endTime;

    if (Number.isNaN(newStart.getTime())) {
        return NextResponse.json({ error: "Invalid startTime" }, { status: 400 });
    }
    if (newEnd && Number.isNaN(newEnd.getTime())) {
        return NextResponse.json({ error: "Invalid endTime" }, { status: 400 });
    }
    if (newEnd && newEnd.getTime() <= newStart.getTime()) {
        return NextResponse.json({ error: "endTime must be after startTime" }, { status: 400 });
    }
    if (newEnd && exceedsMaxShift(newStart, newEnd)) {
        return NextResponse.json(
            { error: `Shift would be longer than ${MAX_SHIFT_HOURS} hours — check the day`, code: "SHIFT_TOO_LONG" },
            { status: 400 }
        );
    }

    // Locked pay periods (src/lib/payroll-period.ts). BOTH times are checked:
    // editing a punch that sits in a locked period changes hours that were
    // already paid, and MOVING a punch INTO a locked period adds hours to a
    // period that was already exported. Either one is a 423.
    const editLocked = await assertPeriodUnlocked([existing.startTime, newStart]);
    if (editLocked) return editLocked;

    // Logistics jobs carry no cost-code/estimate-item context on the entry, so
    // notes are the only record of what was actually done — require one
    // (already on the entry, or supplied in this request) before the entry can
    // be clocked out.
    //
    // "Clocked out" means OPEN → CLOSED. The mobile edit screen always sends
    // endTime for an already-closed entry (it re-sends both times with the
    // reason), and it has no job-notes field — so demanding logistics notes on
    // that edit made every old logistics punch un-editable from the phone
    // ("Update failed", CJ 2026-08-28). A closed entry keeps whatever notes it
    // has; only a genuine close-out is gated.
    const settingEndTime = body.endTime !== undefined && body.endTime !== null;
    const closingOpenEntry = settingEndTime && existing.endTime == null;
    let projectIsLogistics = false;
    if (closingOpenEntry) {
        const entryProject = await prisma.project.findUnique({
            where: { id: existing.projectId },
            select: { isLogistics: true },
        });
        projectIsLogistics = entryProject?.isLogistics ?? false;
    }
    const logisticsCheck = checkLogisticsClockOutNotes({
        isLogistics: projectIsLogistics,
        settingEndTime: closingOpenEntry,
        existingNotes: existing.notes,
        suppliedNotes: typeof body.notes === "string" ? body.notes : undefined,
    });
    if (!logisticsCheck.ok) {
        return NextResponse.json(
            { error: "Notes are required to clock out of a logistics job", code: "LOGISTICS_NOTES_REQUIRED" },
            { status: 400 }
        );
    }

    // Owner's labor + burden rates drive cost. A manager editing a field crew's
    // punch must NOT stamp manager rates onto the entry.
    const owner = isOwner
        ? user
        : await prisma.user.findUnique({ where: { id: existing.userId } });
    if (!owner) return NextResponse.json({ error: "Entry owner not found" }, { status: 404 });

    // Mirror of the PUT clock-out's $0-rate block (src/lib/pay-rate-guard.ts),
    // with the manager-facing message: this is the path a manager uses to close
    // a forgotten punch, and closing it at a $0 rate books a free shift. Only a
    // genuine OPEN -> CLOSED transition is gated; re-editing an already-closed
    // entry is left alone so an old punch never becomes uneditable.
    // Any edit that leaves the entry CLOSED recomputes laborCost/burdenCost from
    // the owner's rate — not just the OPEN -> CLOSED transition. Shrinking an 8h
    // entry to 4h at a $0 rate rewrites the cost just as silently as closing one
    // does, and the earlier `closingOpenEntry &&` let every such edit through.
    const recomputesCost = newEnd != null;
    const zeroRate =
        recomputesCost &&
        zeroRateBlocks({
            role: owner.role,
            email: owner.email,
            payType: owner.payType ?? null,
            hourlyRate: toNum(owner.hourlyRate),
        });
    // Refused for EVERYONE unless the office explicitly acknowledged it. The
    // escape exists so a $0 punch cannot become unclosable past
    // MAX_SHIFT_HOURS, but it is a deliberate separate action, not the default
    // outcome of an ordinary close. The acknowledged close is flagged, and the
    // payroll export refuses to run while that flag is set.
    // One rule, server-side (src/lib/pay-rate-guard.ts): an office role, and
    // never on your own entry.
    const acknowledgedZeroRate =
        body.acknowledgeZeroRate === true && canAcknowledgeZeroRate(user, existing.userId);
    if (zeroRate && !acknowledgedZeroRate) {
        return zeroRateBlockedResponse({ closerIsOwner: isOwner, ownerName: owner.name });
    }

    // Automatic-break model (src/lib/wa-breaks.ts): the meal is re-settled on
    // EVERY edit that leaves the entry closed — a manager closing a forgotten
    // punch gets the same deduction a normal clock-out would, and shrinking an
    // 8h entry to 4h drops a deduction the shorter day no longer owes. Inputs
    // are the entry's own recorded state: an intermediate (DEFERRED) close
    // stays deferred, a worked-through attestation stays honored. durationHours
    // = PAID hours, shiftHours = raw — same contract as the PUT path.
    const shiftHours = newEnd ? (newEnd.getTime() - newStart.getTime()) / 3_600_000 : null;
    let durationHours: number | null = null;
    let mealFields: Record<string, unknown> = {};
    let mealOutcomeForNotice: MealOutcome | null = null;
    // The attestation to honor: an explicit boolean in this request; else, for
    // an entry that already CLOSED with a worker answer, that answer; else
    // nothing (an OPEN entry's stored `mealSkipped` is just the column default
    // — the worker was never asked, and the notice below must say so).
    // Only the OWNER's answer counts; a closed row's durable answer is read
    // off its outcome (WORKED_THROUGH = "worked through"; AUTO_DEDUCTED without
    // the no-answer note = "took lunch"), never off the column default.
    const storedAnswer: boolean | undefined =
        existing.mealOutcome === "WORKED_THROUGH"
            ? true
            : existing.mealOutcome === "AUTO_DEDUCTED" && !(existing.reviewReason ?? "").includes(NO_ATTESTATION_NOTE)
              ? false
              : undefined;
    const mealSkippedForEdit: boolean | undefined =
        isOwner && typeof body.mealSkipped === "boolean" ? body.mealSkipped : storedAnswer;
    if (newEnd) {
        const dayEntries = await loadDayEntries(existing.userId, toCompanyDayKey(newStart), existing.id);
        const meal = computeMealDeduction({
            dayEntries,
            closing: { startTime: newStart, endTime: newEnd },
            mealSkipped: mealSkippedForEdit,
            mealSkipStatus: existing.mealSkipStatus,
            deferMeal: existing.mealOutcome === "DEFERRED",
        });
        durationHours = meal.paidHours;
        mealFields = { mealDeductionHours: meal.mealDeductionHours, mealOutcome: meal.outcome };
        mealOutcomeForNotice = meal.outcome;
    } else {
        // Re-opened entry: nothing is settled until it closes again.
        mealFields = { mealDeductionHours: null, mealOutcome: null };
    }
    const laborCost = durationHours != null ? durationHours * toNum(owner.hourlyRate) : null;
    const burdenCost = durationHours != null ? durationHours * toNum(owner.burdenRate) : null;

    const data: Record<string, unknown> = {
        startTime: newStart,
        endTime: newEnd,
        durationHours,
        shiftHours,
        ...mealFields,
        laborCost,
        burdenCost,
        editNotes: body.editNotes.trim(),
        isEdited: true,
    };
    if (logisticsCheck.notes !== undefined) {
        data.notes = logisticsCheck.notes;
    }

    // WA meal-break voluntary waiver attestation — same rule as the PUT
    // clock-out path (src/app/api/time-entries/route.ts): applies only when
    // this PATCH is actually setting endTime (a clock-out), never on a plain
    // edit. Defense in depth for a call site mobile doesn't currently use for
    // this flag (see PUT), same posture as the notes check above.
    // Same owner-gated value the settlement uses — never the raw body from a manager.
    const mealWaiver = applyMealSkippedWaiver({
        mealSkipped: mealOutcomeForNotice === "WORKED_THROUGH" ? true : mealSkippedForEdit === false ? false : undefined,
        settingEndTime,
        existingReviewReason: existing.reviewReason,
    });
    Object.assign(data, mealWaiver);
    const rest = applyRestBreakAttestation({
        // The worker's word only — a manager cannot answer for them.
        restBreaksMissed: isOwner ? body.restBreaksMissed : undefined,
        settingEndTime,
        existingReviewReason: mealWaiver.reviewReason ?? existing.reviewReason,
    });
    Object.assign(data, rest);
    // Same rule as the PUT clock-out: a deduction nobody asked the worker about
    // is flagged — a manager closing a forgotten punch included.
    if (mealOutcomeForNotice) {
        Object.assign(
            data,
            applyNoAttestationNotice({
                outcome: mealOutcomeForNotice,
                mealSkipped: mealSkippedForEdit,
                existingReviewReason: rest.reviewReason ?? mealWaiver.reviewReason ?? existing.reviewReason,
            })
        );
    }

    // A punch the worker closes from History more than a day after it started is
    // a forgotten clock-out with a remembered end time — pay it, but a manager
    // looks at it. Runs LAST so it composes onto whatever reason the meal/rest
    // notices above already wrote.
    if (closingOpenEntry && isOwner && Date.now() - existing.startTime.getTime() > MAX_SHIFT_HOURS * 3_600_000) {
        const parts = String((data.reviewReason as string | undefined) ?? existing.reviewReason ?? "")
            .split("; ")
            .map((part) => part.trim())
            .filter(Boolean);
        if (!parts.includes(CLOSED_LATE_NOTE)) parts.push(CLOSED_LATE_NOTE);
        data.reviewReason = parts.join("; ");
        data.needsReview = true;
    }

    // NO zero-rate flag here, deliberately. `zeroRate` above was decided from an
    // UNLOCKED read taken before the transaction; it is a cheap fail-fast, not a
    // fact. Writing the flag from it produced a "$0 pay rate" warning on entries
    // whose rate had since been fixed, and missed entries whose rate had since
    // been zeroed. The flag is decided from the LOCKED read inside the
    // transaction instead (see liveZeroRate below).

    // The as-clocked snapshot is captured INSIDE the transaction, from the
    // locked row -- see `stored.isEdited` below.

    if (isPrivileged && !isOwner) {
        data.editedByManagerId = user.id;
        data.editedAt = new Date();
    }

    // Re-resolve the schedule-task binding only when the edit moves the punch to a
    // different local day — the board may have changed mid-shift, so we must not
    // repick the day on every edit. Binding follows the entry's OWNER, not the
    // editing manager (costs already follow the owner).
    if (toCompanyDayKey(newStart) !== toCompanyDayKey(existing.startTime)) {
        data.scheduleTaskId = await resolveScheduleTaskIdForPunch({
            userId: existing.userId,
            projectId: existing.projectId,
            dayKey: toCompanyDayKey(newStart),
            estimateItemId: existing.estimateItemId,
        });
    }

    // The real guard: check and write in ONE transaction under the shared
    // payroll advisory lock. The check at the top of this handler is fail-fast
    // only — everything between it and here is awaited work (day load, meal
    // settlement, task re-binding) during which a period can be locked.
    // The edit AND the day re-plan it triggers commit together. The entry's
    // STORED startTime is re-read under FOR UPDATE inside the transaction (a
    // concurrent writer may have moved the row since this request read it), and
    // `newStart` is checked as the value about to be written.
    let updated;
    try {
        // Every lock this write needs, declared up front and taken in the
        // global order (payroll -> days -> rows). Both days: the edit can move
        // the punch, and settlement then re-plans the old day AND the new one.
        //
        // Both days' settlement candidates are folded into entryIds here too —
        // this edit always re-plans BOTH days below (settleDayWithinTx), and
        // locking only `id` up front, then letting settlement lock each day's
        // wider 72-hour window afterward, is what let two adjacent-day edits
        // deadlock on each other's rows (see settlementCandidateIds).
        const oldDayKey = toCompanyDayKey(existing.startTime);
        const newDayKey = toCompanyDayKey(newStart);
        const settlementCandidates = new Set<string>();
        for (const dayKey of new Set([oldDayKey, newDayKey])) {
            for (const cid of await settlementCandidateIds(prisma, existing.userId, dayKey)) {
                settlementCandidates.add(cid);
            }
        }
        updated = await withPayrollWriteTx(
            {
                entryIds: [id, ...settlementCandidates],
                instants: [newStart],
                dayKeys: [
                    dayLockKey(existing.userId, oldDayKey),
                    dayLockKey(existing.userId, newDayKey),
                ],
            },
            async (tx) => {
                const client = tx as unknown as typeof prisma;

                // The row as it ACTUALLY stands, re-read under the FOR UPDATE
                // acquired above. The copy read before the transaction is stale
                // the moment a concurrent writer moves the punch, and the days
                // locked above were derived from it.
                const [stored] = (await client.$queryRawUnsafe(
                    `SELECT "userId", "projectId", "startTime", "endTime", "updatedAt",
                            "mealOutcome", "mealSkipStatus", "reviewReason", "needsReview", "isEdited"
                       FROM "TimeEntry" WHERE "id" = $1`,
                    id
                )) as Array<{
                    userId: string;
                    projectId: string;
                    startTime: Date;
                    endTime: Date | null;
                    updatedAt: Date;
                    mealOutcome: string | null;
                    mealSkipStatus: string | null;
                    reviewReason: string | null;
                    needsReview: boolean;
                    isEdited: boolean;
                }>;
                if (!stored) throw new EntryMovedError();

                // THE OPTIMISTIC LOCK, checked against the row this request was
                // COMPUTED FROM. Every state-dependent field above -- the end
                // time, the meal settlement, the review notices, the original-
                // values snapshot -- was derived from `existing`, read before this
                // transaction existed. Asserting the locked row still carries the
                // same updatedAt is what makes all of that sound: from here on,
                // `existing` and `stored` describe the same row state.
                //
                // Comparing against `stored.updatedAt` instead (which the CAS in
                // the write below used to do) proves nothing at all: the row is
                // held FOR UPDATE, so a value re-read inside the transaction can
                // never differ from itself.
                if (stored.updatedAt.getTime() !== existing.updatedAt.getTime()) {
                    throw new EntryMovedError();
                }

                // WHO OWNS IT NOW. Everything above — the authorization, the
                // period check, the pricing target, the day locks — was decided
                // from a copy read before this transaction opened. A concurrent
                // reassignment makes every one of those answers about a
                // different person: the edit would be priced from the OLD
                // owner's rates, settled onto the OLD owner's day, and allowed
                // for a crew member who no longer owns the row.
                if (stored.userId !== existing.userId) throw new EntryMovedError();

                // Re-authorized against the re-read row, not the stale copy.
                // Same rule as above: your own, or a manager/admin.
                const stillOwner = stored.userId === user.id;
                const stillAllowed = stillOwner || user.role === "MANAGER" || user.role === "ADMIN";
                if (!stillAllowed) throw new EntryMovedError();

                // The OWNER's rate and pay type, re-read and row-locked inside
                // this transaction. The copy above was read before it, so a
                // concurrent rate import could set a rate to $0 in between and
                // this edit would price the shift from the stale value.
                const liveOwner = await readOwnerRatesForUpdate(client as never, stored.userId, toNum);
                if (liveOwner && newEnd != null) {
                    // THE ONLY zero-rate decision that writes anything. The
                    // pre-transaction check is a fail-fast; this one is the fact,
                    // because the owner row is held FOR UPDATE from here until
                    // commit and no rate import can move it underneath us.
                    const liveZeroRate = zeroRateBlocks({
                        role: liveOwner.role,
                        email: liveOwner.email,
                        payType: liveOwner.payType,
                        hourlyRate: liveOwner.hourlyRate,
                    });
                    if (liveZeroRate && !acknowledgedZeroRate) throw new ZeroRateAtWriteError();

                    // Re-price from the LOCKED read: the costs computed above
                    // came from a copy taken before this transaction opened.
                    data.laborCost = (durationHours ?? 0) * liveOwner.hourlyRate;
                    data.burdenCost = (durationHours ?? 0) * liveOwner.burdenRate;

                    // Flagged from the LOCKED rate, composed onto whatever the
                    // meal/rest notices already wrote. A rate fixed since the
                    // pre-read produces NO warning; a rate zeroed since it does.
                    if (liveZeroRate) {
                        Object.assign(
                            data,
                            appendZeroRateReview((data.reviewReason as string | undefined) ?? stored.reviewReason)
                        );
                    }
                }
                // The as-clocked snapshot, from the LOCKED row. Identical to
                // `existing` by the updatedAt assertion above; read from `stored`
                // so the source of truth inside the transaction is the locked row.
                if (!stored.isEdited) {
                    data.originalStartTime = stored.startTime;
                    data.originalEndTime = stored.endTime;
                }

                if (stored.startTime.getTime() !== existing.startTime.getTime()) {
                    // It moved days. The day locks we hold are for the old day,
                    // so we cannot safely settle — refuse and let the client
                    // retry against the row's real state.
                    throw new EntryMovedError();
                }

                // Compare-and-set on updatedAt, not just startTime: a
                // concurrent write can change the endTime, the meal outcome or
                // the attestations WITHOUT moving startTime, and this edit
                // recomputed duration and cost from a copy read before any of
                // that. updatedAt moves on every write, so it is the one value
                // that catches all of them.
                // CAS on the updatedAt this request was COMPUTED FROM, not on
                // the one just re-read under the lock. The latter is a tautology
                // -- the row cannot change while we hold it -- so it detected
                // nothing. This is the value that makes the write conditional on
                // the world not having moved.
                const claim = await client.timeEntry.updateMany({
                    where: { id, updatedAt: existing.updatedAt },
                    data,
                });
                if (claim.count !== 1) throw new EntryMovedError();
                const row = await client.timeEntry.findUniqueOrThrow({ where: { id } });
            // Re-plan every day this edit touched (the row may have moved days),
            // in THIS transaction — settling afterwards left a window in which
            // the period could be locked in between.
            const days = new Set<string>([toCompanyDayKey(existing.startTime), toCompanyDayKey(newStart)]);
            for (const dayKey of days) {
                const result = await settleDayWithinTx(
                    tx as never,
                    // The re-read owner. Settling the stale one would re-plan a
                    // day belonging to whoever used to hold this punch.
                    stored.userId,
                    dayKey,
                    newEnd ? { id: existing.id, mealSkipped: mealSkippedForEdit } : null
                );
                if (result < 0) await client.timeEntry.update({ where: { id }, data: { needsReview: true } });
            }
                return row;
            }
        );
    } catch (error) {
        if (isPeriodLockedError(error)) return periodLockedResponse(error.period);
        if (error instanceof EntryMovedError) {
            return NextResponse.json(
                {
                    error: "This entry was changed while you were editing it. Reload and try again.",
                    code: ENTRY_MOVED_CODE,
                },
                { status: 409 }
            );
        }
        if (error instanceof ZeroRateAtWriteError) {
            return zeroRateBlockedResponse({ closerIsOwner: isOwner, ownerName: owner.name });
        }
        throw error;
    }

    const settled = await prisma.timeEntry.findUnique({ where: { id } });
    return NextResponse.json(JSON.parse(JSON.stringify(settled ?? updated)));
}

// Manager/admin only. Field crew correct mistakes via PATCH (with editNotes audit);
// outright deletion is a separate, stronger action that needs the audit-log gap to be
// explicit on the record (we just remove it; payroll already accounts for `isEdited`).
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
    const auth = await authenticateMobileOrSession(req);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const { user } = auth;

    if (user.role !== "MANAGER" && user.role !== "ADMIN") {
        return NextResponse.json({ error: "Only managers can delete time entries" }, { status: 403 });
    }

    const { id } = await params;
    if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

    const existing = await prisma.timeEntry.findUnique({ where: { id } });
    if (!existing) return NextResponse.json({ error: "Time entry not found" }, { status: 404 });

    // Delete + re-plan the day in one transaction under the day lock — a
    // concurrent edit that moved this row is seen inside the lock and its new
    // day is re-planned too (src/lib/wa-breaks-db.ts deleteEntryAndSettle).
    //
    // The payroll guard runs INSIDE that same transaction, via the `guard` hook,
    // so the lock check and the delete cannot be split by a concurrent lock
    // creation. Deleting a punch out of an exported period changes hours that
    // were already paid.
    // The row may move between the read above and the delete, and
    // deleteEntryAndSettle re-plans BOTH the day it thought the row was on and
    // the day it actually finds. Every one of those days has to be locked
    // BEFORE the row lock (the global order), so the candidate set is collected
    // up front from a fresh read and passed in sorted.
    //
    // If it moves again after that, we re-read once and try with the new set.
    // Once: a second miss means something is rewriting this row continuously,
    // and looping would just hold locks while it does.
    const deleteOnce = async (attempt: number): Promise<"ok" | "moved"> => {
        const fresh = await prisma.timeEntry.findUnique({
            where: { id },
            select: { userId: true, startTime: true },
        });
        if (!fresh) return "ok"; // already gone — deleting is idempotent

        // The COMPLETE day-lock set: the owner/day this row was read at, and
        // the owner/day it stands at now. Both, because a settlement has to be
        // able to re-plan whichever day the delete actually removes hours from,
        // and after a reassignment those are two different people's days.
        //
        // Recomputed on every attempt from `fresh`, so the retry locks the
        // CURRENT owner's day rather than the one that already moved.
        const dayKeys = [...new Set([
            dayLockKey(existing.userId, toCompanyDayKey(existing.startTime)),
            dayLockKey(fresh.userId, toCompanyDayKey(fresh.startTime)),
        ])].sort();

        try {
            await deleteEntryAndSettle(id, toCompanyDayKey(fresh.startTime), fresh.userId, {
                // Re-reads the row FOR UPDATE inside the delete transaction and
                // validates its STORED startTime — the values read above are
                // stale the moment another writer moves the row.
                guard: async (tx) => {
                    // Both days this delete can re-plan (deleteEntryAndSettle
                    // settles knownDayKey AND actualDay below) — folded into
                    // THIS row lock rather than left for settleDayInTx to lock
                    // separately afterward, for the same reason as the PATCH
                    // edit above: a narrow declared-row lock followed by a
                    // wider day-window lock, later in the same transaction,
                    // let two adjacent-day deletes deadlock on each other's
                    // rows. See settlementCandidateIds.
                    const settlementCandidates = new Set<string>();
                    for (const cid of await settlementCandidateIds(tx, existing.userId, toCompanyDayKey(existing.startTime))) {
                        settlementCandidates.add(cid);
                    }
                    for (const cid of await settlementCandidateIds(tx, fresh.userId, toCompanyDayKey(fresh.startTime))) {
                        settlementCandidates.add(cid);
                    }
                    await assertEntriesUnlockedInTx(tx, [id, ...settlementCandidates], { dayKeys });
                    const [now] = (await tx.$queryRawUnsafe(
                        `SELECT "userId", "startTime" FROM "TimeEntry" WHERE "id" = $1`,
                        id
                    )) as Array<{ userId: string; startTime: Date }>;
                    if (!now) return; // vanished — the delete is a no-op either way
                    // MOVEMENT IS OWNER *OR* DAY. Comparing the day alone missed
                    // the case that matters most: a same-date reassignment from
                    // A to B leaves the day key identical, so this guard passed
                    // while the locks held (and the settlement about to run)
                    // still belonged to A. B's day would never be re-planned and
                    // never locked. Bail so the outer retry collects the new
                    // owner's day-lock set.
                    if (
                        now.userId !== fresh.userId ||
                        toCompanyDayKey(now.startTime) !== toCompanyDayKey(fresh.startTime)
                    ) {
                        throw new EntryMovedError();
                    }
                },
            });
            return "ok";
        } catch (error) {
            if (error instanceof EntryMovedError && attempt === 0) return "moved";
            throw error;
        }
    };

    try {
        if ((await deleteOnce(0)) === "moved" && (await deleteOnce(1)) === "moved") {
            return NextResponse.json(
                {
                    error: "This entry kept changing while it was being deleted. Reload and try again.",
                    code: ENTRY_MOVED_CODE,
                },
                { status: 409 }
            );
        }
    } catch (error) {
        if (isPeriodLockedError(error)) return periodLockedResponse(error.period);
        if (error instanceof EntryMovedError) {
            return NextResponse.json(
                {
                    error: "This entry changed while it was being deleted. Reload and try again.",
                    code: ENTRY_MOVED_CODE,
                },
                { status: 409 }
            );
        }
        throw error;
    }
    return NextResponse.json({ ok: true });
}
