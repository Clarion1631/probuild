export const dynamic = 'force-dynamic';
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { toNum } from "@/lib/prisma-helpers";
import { authenticateMobileOrSession, assertProjectAccess } from "@/lib/mobile-auth";
import { resolveScheduleTaskIdForPunch } from "@/lib/punch-task-binding";
import { toCompanyDayKey } from "@/lib/company-day";
import { isTaskActiveOnDay } from "@/app/company-dashboard/schedule-board/dispatch-exceptions";
import { resolveChargeableItems } from "@/lib/time-suggestion";
import { requiresPhaseForClockIn, checkLogisticsClockOutNotes, applyMealSkippedWaiver } from "@/lib/logistics-time-entry";
import { isCostCodeAllowedForProject, PHASE_ELIGIBLE_ESTIMATE_WHERE } from "@/lib/project-phases";
import { prismaPhaseDataSource } from "@/lib/project-phases-db";
import { applyNoAttestationNotice, applyRestBreakAttestation, computeMealDeduction, exceedsMaxShift, MAX_SHIFT_HOURS, staleDeferredReview, type DayEntry } from "@/lib/wa-breaks";
import { flagSettlementFailed, loadDayEntries, settleDay } from "@/lib/wa-breaks-db";

const VALID_SUGGESTION_SOURCES = ["dispatch", "daily_log", "today_schedule", "user_history"];

export interface SuggestionAuditInput {
    /** Raw client-supplied `body.suggestionSource` — untyped, unvalidated. */
    suggestionSourceRaw: unknown;
    /** Raw client-supplied `body.suggestedCostCodeId` — untyped, unvalidated. */
    suggestedCostCodeIdRaw: unknown;
    /**
     * Server-confirmed: the caller has a TaskAssignment on the request's
     * `suggestedScheduleTaskId` AND that task is active on the punch day.
     * The only fact that can substantiate a "dispatch" claim.
     */
    dispatchConfirmed: boolean;
    /**
     * The cost code the suggested task's chargeable item actually resolves
     * to. `null` = task resolved but has no chargeable cost code.
     * `undefined` = no ground truth available at all (no valid suggested
     * task, or it carries no estimate item) — nothing to cross-check against.
     */
    suggestedTaskResolvedCostCodeId: string | null | undefined;
}

export interface SuggestionAuditResult {
    /** Persisted `suggestionSource` — a "dispatch" claim the server can't confirm is downgraded to null. */
    suggestionSource: string | null;
    /** Persisted `suggestedCostCodeId` — downgraded to null on a confirmed mismatch against ground truth. */
    suggestedCostCodeId: string | null;
}

/**
 * Server-side provenance check for the client-supplied suggestion audit
 * fields (gate P2). These fields are best-effort telemetry riding along on a
 * clock-in — they feed manager review and (via the acceptedSuggestion
 * binding in punch-task-binding.ts) the task hours roll-up — never something
 * worth 400-ing the punch over, so a fabricated/stale claim is downgraded to
 * null rather than rejected, matching the existing style in this route for
 * unresolvable suggestedScheduleTaskId (see auditSuggestedTaskId above).
 *
 * Pure — no I/O, unit-tested directly in tests/punch-task-binding.test.ts
 * style (tests/time-entries-suggestion-audit.test.ts) without a database.
 */
export function resolveSuggestionAudit(input: SuggestionAuditInput): SuggestionAuditResult {
    const { suggestionSourceRaw, suggestedCostCodeIdRaw, dispatchConfirmed, suggestedTaskResolvedCostCodeId } = input;

    const requestedSource =
        typeof suggestionSourceRaw === "string" && VALID_SUGGESTION_SOURCES.includes(suggestionSourceRaw)
            ? suggestionSourceRaw
            : null;
    // A "dispatch" claim the server cannot itself confirm is downgraded —
    // never persist a "planned by office" attribution the caller forged.
    const suggestionSource = requestedSource === "dispatch" && !dispatchConfirmed ? null : requestedSource;

    let suggestedCostCodeId = typeof suggestedCostCodeIdRaw === "string" ? suggestedCostCodeIdRaw : null;
    // Only refute against real ground truth. `undefined` (no valid suggested
    // task, or no chargeable item to resolve) means there's nothing to check
    // against — leave the client's value as-is, same as today.
    if (
        suggestedCostCodeId &&
        suggestedTaskResolvedCostCodeId !== undefined &&
        suggestedTaskResolvedCostCodeId !== null &&
        suggestedCostCodeId !== suggestedTaskResolvedCostCodeId
    ) {
        suggestedCostCodeId = null;
    }

    return { suggestionSource, suggestedCostCodeId };
}

export async function GET(req: Request) {
    const auth = await authenticateMobileOrSession(req);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const { user } = auth;

    const { searchParams } = new URL(req.url);
    const projectId = searchParams.get('projectId');

    const whereClause: any = {};
    if (user.role !== 'MANAGER' && user.role !== 'ADMIN') {
        whereClause.userId = user.id;
    }
    if (projectId) {
        whereClause.projectId = projectId;
    }

    const timeEntries = await prisma.timeEntry.findMany({
        where: whereClause,
        include: {
            user: true,
            // Explicit select — a full Project row would serialize
            // chatWebhookUrl (a credential) to field crew.
            project: {
                select: {
                    id: true, name: true, status: true, location: true,
                    locationLat: true, locationLng: true, geofenceRadiusMeters: true,
                    color: true, code: true, clientId: true,
                },
            },
            costCode: true
        },
        orderBy: {
            createdAt: 'desc'
        }
    });

    return NextResponse.json(JSON.parse(JSON.stringify(timeEntries)));
}

export async function POST(req: Request) {
    const auth = await authenticateMobileOrSession(req);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const { user } = auth;

    const body = await req.json();
    const {
        projectId, costCodeId, estimateItemId, startTime, latitude, longitude,
        // Suggestion audit (newer clients only — older app versions omit all of these)
        suggestedScheduleTaskId, suggestedCostCodeId, suggestionSource, suggestionOverridden,
        // Logistics voice dump (plan 02) — what the worker said at clock-in.
        // Newer clients send it; on a logistics job it is REQUIRED when sent
        // at all (an old client that omits the key is not rejected).
        rawNote,
    } = body;

    if (!projectId) {
        return NextResponse.json({ error: "Project ID is required" }, { status: 400 });
    }

    const fail = await assertProjectAccess(user, projectId);
    if (fail) return fail;

    // A mid-day (DEFERRED) close that was never followed by a clock-in is the
    // end of that day with no meal settled — flag it now that the worker is
    // back (src/lib/wa-breaks.ts staleDeferredReview). Best-effort, never
    // blocks the clock-in.
    try {
        const latest = await prisma.timeEntry.findFirst({
            where: { userId: user.id, endTime: { not: null } },
            orderBy: { endTime: "desc" },
            select: { id: true, mealOutcome: true, startTime: true, endTime: true, needsReview: true, reviewReason: true },
        });
        const stale = staleDeferredReview({
            latest,
            now: new Date(),
            latestDayKey: latest ? toCompanyDayKey(latest.startTime) : undefined,
            todayKey: toCompanyDayKey(new Date()),
        });
        if (stale && latest) {
            // Optimistic: only if nobody composed a reason onto the row meanwhile.
            await prisma.timeEntry.updateMany({ where: { id: latest.id, reviewReason: latest.reviewReason }, data: stale });
            // And settle that day for real — the deferred close WAS the day's end.
            // Day keyed by START time, like every other reader of a row's day.
            await settleDay(user.id, toCompanyDayKey(latest.startTime), null);
        }
    } catch (error) {
        console.error("[time-entries] stale DEFERRED review check failed", error);
    }

    const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { isLogistics: true },
    });

    // Cost attribution: the estimate item is what actually gets charged, so it
    // must belong to this project (on an eligible estimate) and its cost code
    // wins over whatever the client sent. Mobile historically sent
    // costCodeId: null, which is exactly how wrong/missing cost codes happened.
    let resolvedEstimateItemId: string | null = null;
    let resolvedCostCodeId: string | null = null;
    if (estimateItemId) {
        const item = await prisma.estimateItem.findFirst({
            where: {
                id: estimateItemId,
                estimate: {
                    projectId,
                    // Shared constant, NOT an inline copy. Review finding: this list
                    // was duplicated here while GET .../cost-codes/[id]/items used
                    // PHASE_ELIGIBLE_ESTIMATE_WHERE. Identical today, but if
                    // eligibility ever changed in one place the picker would offer
                    // items this endpoint then rejects — turning a one-line config
                    // change into a crew-facing clock-in dead end.
                    ...PHASE_ELIGIBLE_ESTIMATE_WHERE,
                },
            },
            select: { id: true, costCodeId: true },
        });
        if (!item) {
            return NextResponse.json(
                {
                    error: "Estimate item does not belong to an eligible estimate on this project",
                    // Coded so the client can recognise this as the same
                    // stale-item case as ITEM_PHASE_MISMATCH and degrade to a
                    // phase-only punch instead of retrying an identical payload
                    // forever. Never make a crew member string-match an error.
                    code: "ITEM_NOT_ON_PROJECT",
                },
                { status: 400 }
            );
        }
        resolvedEstimateItemId = item.id;
        // The item alone decides the charge — a client-sent costCodeId must not
        // fill in for a codeless item, or crew can charge any code they like.
        resolvedCostCodeId = item.costCodeId ?? null;

        // Optional item step (2026-08): the client may send BOTH the phase the
        // crew tapped and the item it resolved underneath it. They must agree.
        // A disagreement means the client's phase list was stale — the item was
        // re-coded on the estimate between the phase tap and the punch — and
        // silently trusting the item would charge a phase the crew never chose.
        // That is precisely the item/phase mismatch that corrupted the variance
        // report (see reconcileAttribution in src/lib/job-variance.ts); reject
        // it at the door instead of letting it into the ledger.
        // A codeless item is ALSO stale data when the client sent a phase: the
        // office removed the cost code between the picker fetch and this punch.
        // Persisting it would store an entry with an item but NO phase (the item
        // cannot supply one), which reaches the variance report as labor that
        // belongs to no phase. Same class, same coded response, so the client
        // degrades to phase-only instead of silently recording a phase-less punch.
        if (costCodeId && typeof costCodeId === "string" && !resolvedCostCodeId) {
            return NextResponse.json(
                {
                    error: "That line item no longer has a phase. Reopen the phase list and pick again.",
                    code: "ITEM_PHASE_MISMATCH",
                },
                { status: 400 }
            );
        }
        if (
            costCodeId &&
            typeof costCodeId === "string" &&
            resolvedCostCodeId &&
            costCodeId !== resolvedCostCodeId
        ) {
            return NextResponse.json(
                {
                    error: "That line item belongs to a different phase. Reopen the phase list and pick again.",
                    code: "ITEM_PHASE_MISMATCH",
                },
                { status: 400 }
            );
        }
    } else if (costCodeId && typeof costCodeId === "string") {
        // Phase-only clock-in (the primary path since the mobile picker went
        // phases-only) — and the old legacy path. "The cost code exists" is NOT
        // a permission: this used to accept ANY CostCode row, so a crew member
        // could post labor against a code that has nothing to do with the job.
        // The code must be one of THIS project's phases — the exact list
        // /api/projects/[id]/cost-codes serves, computed by the same shared
        // helper so the picker and this check can never disagree. That includes
        // the Safety Meeting phase, but only on an In Progress project.
        const allowed = await isCostCodeAllowedForProject(prismaPhaseDataSource, projectId, costCodeId);
        if (!allowed) {
            return NextResponse.json(
                { error: "That phase is not available on this project", code: "PHASE_NOT_ON_PROJECT" },
                { status: 400 }
            );
        }
        resolvedCostCodeId = costCodeId;
    }

    // A phase (cost code or estimate item) is required to clock in on a normal
    // project — a logistics job (shop, travel, admin time) has no estimate to
    // attach to, so it's the deliberate exception.
    if (
        requiresPhaseForClockIn({
            isLogistics: project?.isLogistics ?? false,
            hasCostCode: !!resolvedCostCodeId,
            hasEstimateItem: !!resolvedEstimateItemId,
        })
    ) {
        return NextResponse.json(
            { error: "A phase or cost code is required to clock in on this project", code: "PHASE_REQUIRED" },
            { status: 400 }
        );
    }

    const entryStartTime = startTime ? new Date(startTime) : new Date();
    const punchDayKey = toCompanyDayKey(entryStartTime);

    // Suggestion audit fields: trust nothing about the suggested task without
    // re-checking it lives on this project (it feeds manager review, not cost,
    // AND — since the acceptedSuggestion binding below — the task hours
    // roll-up, so a forged claim here can misfile real labor).
    let auditSuggestedTaskId: string | null = null;
    let auditSuggestedTaskName: string | null = null;
    // True only when the server itself confirms the caller is assigned to the
    // suggested task and it's active on the punch day — the same "dispatched
    // to you today" fact dispatch's own ranking is built on. A client cannot
    // manufacture this by sending suggestionSource: "dispatch" alone.
    let dispatchConfirmed = false;
    // The cost code the suggested task's chargeable item actually resolves
    // to, when it has one — the ground truth suggestedCostCodeId is checked
    // against below. `undefined` = not resolvable (no valid task, or its
    // estimate item doesn't resolve to a chargeable target); in that case
    // there is nothing to cross-check.
    let suggestedTaskResolvedCostCodeId: string | null | undefined;
    if (suggestedScheduleTaskId && typeof suggestedScheduleTaskId === "string") {
        const suggestedTask = await prisma.scheduleTask.findFirst({
            where: { id: suggestedScheduleTaskId, projectId },
            select: {
                id: true, name: true, estimateItemId: true,
                startDate: true, endDate: true, type: true,
                assignments: { where: { userId: user.id }, select: { id: true } },
            },
        });
        if (suggestedTask) {
            auditSuggestedTaskId = suggestedTask.id;
            auditSuggestedTaskName = suggestedTask.name;
            const isAssigned = suggestedTask.assignments.length > 0;
            const isActive = isTaskActiveOnDay(
                {
                    startDate: suggestedTask.startDate.toISOString(),
                    endDate: suggestedTask.endDate.toISOString(),
                    type: suggestedTask.type,
                },
                punchDayKey,
            );
            dispatchConfirmed = isAssigned && isActive;

            if (suggestedTask.estimateItemId) {
                const { targetByItemId } = await resolveChargeableItems(projectId);
                const target = targetByItemId.get(suggestedTask.estimateItemId);
                suggestedTaskResolvedCostCodeId = target?.costCodeId ?? null;
            }
        }
    }
    const { suggestionSource: finalSuggestionSource, suggestedCostCodeId: finalSuggestedCostCodeId } =
        resolveSuggestionAudit({
            suggestionSourceRaw: suggestionSource,
            suggestedCostCodeIdRaw: suggestedCostCodeId,
            dispatchConfirmed,
            suggestedTaskResolvedCostCodeId,
        });

    const scheduleTaskId = await resolveScheduleTaskIdForPunch({
        userId: user.id,
        projectId,
        dayKey: punchDayKey,
        estimateItemId: resolvedEstimateItemId,
        // Only ever offered as a tie-break among candidates the resolver
        // itself already verified are assigned+active+on this project — see
        // punch-task-binding.ts "acceptedSuggestion". Passing the raw,
        // not-yet-project-checked id here is safe for that same reason: an
        // id that doesn't belong to this project's candidate set is simply
        // never a member of `candidateIds` and is ignored.
        suggestedScheduleTaskId: typeof suggestedScheduleTaskId === "string" ? suggestedScheduleTaskId : null,
    });

    const dumpText = typeof rawNote === "string" ? rawNote.trim().slice(0, 4000) : undefined;
    if (project?.isLogistics && rawNote !== undefined && !dumpText) {
        return NextResponse.json(
            { error: "Tell us what you're doing before clocking into Logistics", code: "LOGISTICS_NOTE_REQUIRED" },
            { status: 400 }
        );
    }

    const timeEntry = await prisma.timeEntry.create({
        data: {
            userId: user.id,
            projectId,
            costCodeId: resolvedCostCodeId,
            estimateItemId: resolvedEstimateItemId,
            startTime: entryStartTime,
            // The dump is the note until it is formalized; storing it in `notes`
            // too satisfies the logistics clock-out rule without a second prompt.
            ...(dumpText ? { rawNote: dumpText, notes: dumpText } : {}),
            latitude,
            longitude,
            scheduleTaskId,
            suggestedScheduleTaskId: auditSuggestedTaskId,
            suggestedTaskName: auditSuggestedTaskName,
            suggestedCostCodeId: finalSuggestedCostCodeId,
            suggestionSource: finalSuggestionSource,
            suggestionOverridden: suggestionOverridden === true,
        }
    });

    return NextResponse.json(timeEntry);
}

// ── PUT (clock-out) — extracted into a DI-testable factory ──────────────────
// This is the real clock-out path the mobile app calls (lib/api.ts
// timeEntries.clockOut -> PUT /api/time-entries; the PATCH [id] handler's
// edit-flow clock-out check is defense in depth for a different call site,
// not the primary one).

type ClockOutAuthedUser = { id: string; role: string; hourlyRate: number; burdenRate: number };
type ClockOutAuthResult =
    | { ok: true; user: ClockOutAuthedUser }
    | { ok: false; status: number; error: string };

export interface ClockOutTimeEntryRow {
    id: string;
    userId: string;
    projectId: string;
    startTime: Date;
    endTime: Date | null;
    notes: string | null;
    reviewReason: string | null;
    /** Skip-lunch request state (PENDING | APPROVED | DENIED | null) — feeds the meal rule. */
    mealSkipStatus?: string | null;
}

/** Client clock skew allowance for a supplied endTime — see the PUT handler. */
const CLOCK_OUT_FUTURE_SKEW_MS = 5 * 60 * 1000;

export interface ClockOutDependencies {
    authenticate(req: Request): Promise<ClockOutAuthResult>;
    findTimeEntry(id: string): Promise<ClockOutTimeEntryRow | null>;
    findProjectIsLogistics(projectId: string): Promise<boolean>;
    findOwnerRates(userId: string): Promise<{ hourlyRate: number; burdenRate: number } | null>;
    /**
     * The worker's OTHER closed entries on the same company-local day as the
     * entry being closed — the WA meal rule is a per-DAY rule (Switch Task
     * splits a shift into several entries), so the closing entry alone can
     * never decide it. See src/lib/wa-breaks.ts computeMealDeduction.
     */
    findDayEntries(userId: string, dayKey: string, excludeEntryId: string): Promise<DayEntry[]>;
    /**
     * Re-settle the worker's whole company-local day AFTER the close commits
     * (src/lib/wa-breaks-db.ts settleDay): moves the deduction to the day's
     * last entry, refunds an earlier one a later punched meal covers, and
     * serializes concurrent closes. Best-effort; never fails the response.
     */
    settleDay(userId: string, dayKey: string, closing: { id: string; mealSkipped: unknown }): Promise<number>;
    /** Flag the row when settleDay reports failure (-1) — visible, never silent. */
    flagSettlementFailed(entryId: string): Promise<void>;
    /**
     * Atomically close the entry: applies `data` (which always sets endTime)
     * ONLY IF the row is still open (endTime IS NULL) at the database — the
     * guard against two concurrent PUTs both passing the earlier in-memory
     * `existing.endTime != null` check and racing to overwrite each other's
     * close. `ok: false` means zero rows matched the guard (a lost race, or
     * the entry was already closed) — `current` is the row's present state,
     * for the caller to fold into the 409 body the same way the up-front
     * already-closed check does.
     */
    closeTimeEntry(
        id: string,
        userId: string,
        data: Record<string, unknown>
    ): Promise<{ ok: true; entry: unknown } | { ok: false; current: unknown | null }>;
}

export function createClockOutHandler(dependencies: ClockOutDependencies) {
    return {
        async PUT(req: Request) {
            const auth = await dependencies.authenticate(req);
            if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
            const { user } = auth;

            const body = await req.json();
            const { id, endTime, latitude, longitude, notes, deferMeal } = body;
            // Attestations are the WORKER's word: a manager closing someone
            // else's punch cannot answer the lunch/rest questions for them —
            // those land as "no answer" and get the review flag instead.
            let mealSkipped: unknown = body.mealSkipped;
            let restBreaksMissed: unknown = body.restBreaksMissed;

            if (!id) return NextResponse.json({ error: "Time Entry ID is required" }, { status: 400 });

            const existing = await dependencies.findTimeEntry(id);
            if (!existing) return NextResponse.json({ error: "Time Entry not found" }, { status: 404 });

            if (existing.userId !== user.id && user.role !== "MANAGER" && user.role !== "ADMIN") {
                return NextResponse.json({ error: "Unauthorized to edit this entry" }, { status: 403 });
            }
            if (existing.userId !== user.id) {
                mealSkipped = undefined;
                restBreaksMissed = undefined;
            }

            // A closed entry can never be re-closed via PUT — the client must
            // use the PATCH edit flow to change an already-set endTime.
            // Include the existing (already-closed) entry in the body,
            // serialized the same way a 200 response would — a client that
            // actually succeeded on an earlier request but lost the response
            // (dropped connection, app killed mid-flight) can reconcile its
            // local "still clocked in" state against this instead of just
            // seeing a bare failure and retrying forever.
            if (existing.endTime != null) {
                return NextResponse.json(
                    {
                        error: "Time entry is already clocked out",
                        code: "ALREADY_CLOCKED_OUT",
                        entry: JSON.parse(JSON.stringify(existing)),
                    },
                    { status: 409 }
                );
            }

            // Validate a client-supplied endTime rather than trusting it outright:
            // it must parse, must be after the clock-in time, and must not be in
            // the future beyond a small clock-skew allowance. Reject with 400 on
            // any violation — the pattern this route already uses for bad input —
            // rather than silently clamping.
            let end: Date;
            if (endTime !== undefined && endTime !== null) {
                const parsedEnd = new Date(endTime);
                if (Number.isNaN(parsedEnd.getTime())) {
                    return NextResponse.json({ error: "Invalid endTime" }, { status: 400 });
                }
                if (parsedEnd.getTime() <= existing.startTime.getTime()) {
                    return NextResponse.json({ error: "endTime must be after the clock-in time" }, { status: 400 });
                }
                if (parsedEnd.getTime() > Date.now() + CLOCK_OUT_FUTURE_SKEW_MS) {
                    return NextResponse.json({ error: "endTime cannot be in the future" }, { status: 400 });
                }
                end = parsedEnd;
            } else {
                end = new Date();
            }
            if (exceedsMaxShift(existing.startTime, end)) {
                // A punch left open for over a day is a forgotten clock-out, not a
                // 24h+ shift — it must be closed by an edit with the right day.
                return NextResponse.json(
                    { error: `Shift would be longer than ${MAX_SHIFT_HOURS} hours — check the day`, code: "SHIFT_TOO_LONG" },
                    { status: 400 }
                );
            }

            // PUT always closes the entry (endTime resolved above), so every
            // call here is a clock-out. Logistics jobs carry no
            // cost-code/estimate-item context on the entry, so notes are the
            // only record of what was actually done — require one (already on
            // the entry, or supplied in this request).
            const isLogistics = await dependencies.findProjectIsLogistics(existing.projectId);
            const logisticsCheck = checkLogisticsClockOutNotes({
                isLogistics,
                settingEndTime: true,
                existingNotes: existing.notes,
                suppliedNotes: typeof notes === "string" ? notes : undefined,
            });
            if (!logisticsCheck.ok) {
                return NextResponse.json(
                    { error: "Notes are required to clock out of a logistics job", code: "LOGISTICS_NOTES_REQUIRED" },
                    { status: 400 }
                );
            }

            // WA automatic-break model (src/lib/wa-breaks.ts): the meal is deducted
            // HERE, at clock-out, against the whole company-local day — unless a
            // punched meal, a manager-approved skip, or the worker's own
            // worked-through attestation covers it. durationHours is PAID hours
            // (what payroll/export/summary read); shiftHours keeps the raw span.
            const dayEntries = await dependencies.findDayEntries(existing.userId, toCompanyDayKey(existing.startTime), existing.id);
            const meal = computeMealDeduction({
                dayEntries,
                closing: { startTime: existing.startTime, endTime: end },
                mealSkipped,
                mealSkipStatus: existing.mealSkipStatus ?? null,
                // Intermediate close (meal break / Switch Task / duplicate cleanup):
                // nothing settles here — see wa-breaks.ts MealDeductionInput.deferMeal.
                deferMeal: deferMeal === true,
            });
            const durationHours = meal.paidHours;

            // Cost is always calculated from the time-entry OWNER's rates, not the editing user's
            // (a manager editing a field crew's punch must not stamp manager rates onto the entry).
            const owner = existing.userId === user.id ? user : await dependencies.findOwnerRates(existing.userId);
            if (!owner) return NextResponse.json({ error: "Owner not found" }, { status: 404 });
            const laborCost = durationHours * owner.hourlyRate;
            const burdenCost = durationHours * owner.burdenRate;

            const updateData: Record<string, unknown> = {
                endTime: end,
                durationHours,
                shiftHours: meal.shiftHours,
                mealDeductionHours: meal.mealDeductionHours,
                mealOutcome: meal.outcome,
                laborCost,
                burdenCost,
            };

            if (latitude) updateData.latitude = latitude;
            if (longitude) updateData.longitude = longitude;
            if (logisticsCheck.notes !== undefined) updateData.notes = logisticsCheck.notes;

            // WA meal-break voluntary waiver attestation — PUT always closes the
            // entry, so this is always a clock-out. A manager-APPROVED skip is
            // express permission already on record: it is paid without a review
            // flag, so the worked-through attestation is not applied on top of it
            // (the outcome column still says WAIVED_APPROVED for the audit trail).
            // The waiver note is only meaningful when a meal was actually owed and
            // worked through — a "worked through" answer on a 4h day is not a
            // waiver of anything, and an APPROVED skip is permission already on
            // record (WAIVED_APPROVED, paid, unflagged).
            const mealWaiver = applyMealSkippedWaiver({
                mealSkipped: meal.outcome === "WORKED_THROUGH" ? true : mealSkipped === false ? false : undefined,
                settingEndTime: true,
                existingReviewReason: existing.reviewReason,
            });
            Object.assign(updateData, mealWaiver);
            // Rest-break attestation composes onto the same reviewReason string
            // (rest breaks are paid — this only ever documents and flags).
            const rest = applyRestBreakAttestation({
                restBreaksMissed,
                settingEndTime: true,
                existingReviewReason: mealWaiver.reviewReason ?? existing.reviewReason,
            });
            Object.assign(updateData, rest);
            // A deduction the worker was never asked about is flagged, never silent.
            Object.assign(
                updateData,
                applyNoAttestationNotice({
                    outcome: meal.outcome,
                    mealSkipped,
                    existingReviewReason: rest.reviewReason ?? mealWaiver.reviewReason ?? existing.reviewReason,
                })
            );

            if (user.role === "MANAGER" || user.role === "ADMIN") {
                if (existing.userId !== user.id) {
                    updateData.editedByManagerId = user.id;
                    updateData.editedAt = new Date();
                }
            }

            const closeResult = await dependencies.closeTimeEntry(id, existing.userId, updateData);
            if (!closeResult.ok) {
                // Lost the race to a concurrent PUT that closed the entry
                // between the check above and this call — same 409 shape as
                // the up-front already-closed check.
                return NextResponse.json(
                    {
                        error: "Time entry is already clocked out",
                        code: "ALREADY_CLOCKED_OUT",
                        entry: closeResult.current ? JSON.parse(JSON.stringify(closeResult.current)) : null,
                    },
                    { status: 409 }
                );
            }

            // The day, not the row, is the unit the law cares about — re-plan it
            // now that this close is committed (no-op on a single-entry day).
            if (deferMeal !== true) {
                const settled = await dependencies.settleDay(existing.userId, toCompanyDayKey(existing.startTime), { id: existing.id, mealSkipped });
                if (settled < 0) await dependencies.flagSettlementFailed(existing.id);
            }

            // Return what is STORED after settlement — the phone's "last entry"
            // card must never disagree with payroll about paid hours.
            const settled = deferMeal !== true ? await dependencies.findTimeEntry(existing.id) : null;
            return NextResponse.json(JSON.parse(JSON.stringify(settled ?? closeResult.entry)));
        },
    };
}

const clockOutHandler = createClockOutHandler({
    authenticate: async (req) => {
        const result = await authenticateMobileOrSession(req);
        if (!result.ok) return result;
        return {
            ok: true,
            user: {
                id: result.user.id,
                role: result.user.role,
                hourlyRate: toNum(result.user.hourlyRate),
                burdenRate: toNum(result.user.burdenRate),
            },
        };
    },
    findTimeEntry: async (id) => {
        // Full row (no `select`) — this is also what's serialized into a
        // 409 ALREADY_CLOCKED_OUT body, which must match a 200's shape.
        return prisma.timeEntry.findUnique({ where: { id } });
    },
    findProjectIsLogistics: async (projectId) => {
        const project = await prisma.project.findUnique({ where: { id: projectId }, select: { isLogistics: true } });
        return project?.isLogistics ?? false;
    },
    findOwnerRates: async (userId) => {
        const owner = await prisma.user.findUnique({ where: { id: userId }, select: { hourlyRate: true, burdenRate: true } });
        if (!owner) return null;
        return { hourlyRate: toNum(owner.hourlyRate), burdenRate: toNum(owner.burdenRate) };
    },
    findDayEntries: loadDayEntries,
    settleDay,
    flagSettlementFailed,
    closeTimeEntry: async (id, userId, data) => {
        return prisma.$transaction(async (t) => {
            // The guard: only rows still open (endTime IS NULL), scoped to
            // the entry's own stored userId, actually get closed. Two
            // concurrent PUTs can both pass the in-memory already-closed
            // check above — only one of these updateMany calls can match.
            const claim = await t.timeEntry.updateMany({
                where: { id, userId, endTime: null },
                data,
            });
            if (claim.count === 0) {
                const current = await t.timeEntry.findUnique({ where: { id } });
                return { ok: false as const, current };
            }
            const entry = await t.timeEntry.findUniqueOrThrow({ where: { id } });
            return { ok: true as const, entry };
        });
    },
});

export async function PUT(req: Request) {
    return clockOutHandler.PUT(req);
}
