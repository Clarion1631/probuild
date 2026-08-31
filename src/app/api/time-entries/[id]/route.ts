export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { toNum } from "@/lib/prisma-helpers";
import { authenticateMobileOrSession } from "@/lib/mobile-auth";
import { resolveScheduleTaskIdForPunch } from "@/lib/punch-task-binding";
import { toCompanyDayKey } from "@/lib/company-day";
import { checkLogisticsClockOutNotes, applyMealSkippedWaiver } from "@/lib/logistics-time-entry";
import { applyNoAttestationNotice, applyRestBreakAttestation, CLOSED_LATE_NOTE, computeMealDeduction, exceedsMaxShift, MAX_SHIFT_HOURS, type MealOutcome } from "@/lib/wa-breaks";
import { deleteEntryAndSettle, flagSettlementFailed, loadDayEntries, settleDay } from "@/lib/wa-breaks-db";
import { NO_ATTESTATION_NOTE } from "@/lib/wa-breaks";

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
        const updated = await prisma.timeEntry.update({ where: { id }, data });
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

    // Capture the as-clocked values exactly once. Subsequent edits update the latest
    // times but never overwrite the original snapshot.
    if (!existing.isEdited) {
        data.originalStartTime = existing.startTime;
        data.originalEndTime = existing.endTime;
    }

    // Every privileged edit is stamped — including a manager editing their OWN punch.
    // The manager page's "Edited"/"Original" badge reads this field, and a manager's
    // self-edit staying "Original" hid the audit trail (Codex gate, PR #437).
    if (isPrivileged) {
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

    const updated = await prisma.timeEntry.update({ where: { id }, data });

    // Re-plan every day this edit touched (the row may have moved days).
    const days = new Set<string>([toCompanyDayKey(existing.startTime), toCompanyDayKey(newStart)]);
    for (const dayKey of days) {
        const result = await settleDay(existing.userId, dayKey, newEnd ? { id: existing.id, mealSkipped: mealSkippedForEdit } : null);
        if (result < 0) await flagSettlementFailed(id);
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
    await deleteEntryAndSettle(id, toCompanyDayKey(existing.startTime), existing.userId);
    return NextResponse.json({ ok: true });
}
