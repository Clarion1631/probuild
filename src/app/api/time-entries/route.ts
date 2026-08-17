export const dynamic = 'force-dynamic';
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { toNum } from "@/lib/prisma-helpers";
import { authenticateMobileOrSession, assertProjectAccess } from "@/lib/mobile-auth";
import { resolveScheduleTaskIdForPunch } from "@/lib/punch-task-binding";
import { toCompanyDayKey } from "@/lib/company-day";
import { requiresPhaseForClockIn, checkLogisticsClockOutNotes, applyMealSkippedWaiver } from "@/lib/logistics-time-entry";

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
    } = body;

    if (!projectId) {
        return NextResponse.json({ error: "Project ID is required" }, { status: 400 });
    }

    const fail = await assertProjectAccess(user, projectId);
    if (fail) return fail;

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
                    status: { in: ["Approved", "Invoiced", "Partially Paid", "Paid"] },
                    archivedAt: null,
                },
            },
            select: { id: true, costCodeId: true },
        });
        if (!item) {
            return NextResponse.json({ error: "Estimate item does not belong to an eligible estimate on this project" }, { status: 400 });
        }
        resolvedEstimateItemId = item.id;
        // The item alone decides the charge — a client-sent costCodeId must not
        // fill in for a codeless item, or crew can charge any code they like.
        resolvedCostCodeId = item.costCodeId ?? null;
    } else if (costCodeId && typeof costCodeId === "string") {
        // True legacy path (no estimate item): keep the client's code, but only
        // if it actually exists.
        const code = await prisma.costCode.findUnique({ where: { id: costCodeId }, select: { id: true } });
        resolvedCostCodeId = code?.id ?? null;
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

    // Suggestion audit fields: trust nothing about the suggested task without
    // re-checking it lives on this project (it feeds manager review, not cost).
    let auditSuggestedTaskId: string | null = null;
    let auditSuggestedTaskName: string | null = null;
    if (suggestedScheduleTaskId && typeof suggestedScheduleTaskId === "string") {
        const suggestedTask = await prisma.scheduleTask.findFirst({
            where: { id: suggestedScheduleTaskId, projectId },
            select: { id: true, name: true },
        });
        if (suggestedTask) {
            auditSuggestedTaskId = suggestedTask.id;
            auditSuggestedTaskName = suggestedTask.name;
        }
    }
    const validSources = ["daily_log", "today_schedule", "user_history"];

    const entryStartTime = startTime ? new Date(startTime) : new Date();
    const scheduleTaskId = await resolveScheduleTaskIdForPunch({
        userId: user.id,
        projectId,
        dayKey: toCompanyDayKey(entryStartTime),
        estimateItemId: resolvedEstimateItemId,
    });

    const timeEntry = await prisma.timeEntry.create({
        data: {
            userId: user.id,
            projectId,
            costCodeId: resolvedCostCodeId,
            estimateItemId: resolvedEstimateItemId,
            startTime: entryStartTime,
            latitude,
            longitude,
            scheduleTaskId,
            suggestedScheduleTaskId: auditSuggestedTaskId,
            suggestedTaskName: auditSuggestedTaskName,
            suggestedCostCodeId: typeof suggestedCostCodeId === "string" ? suggestedCostCodeId : null,
            suggestionSource: validSources.includes(suggestionSource) ? suggestionSource : null,
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
}

/** Client clock skew allowance for a supplied endTime — see the PUT handler. */
const CLOCK_OUT_FUTURE_SKEW_MS = 5 * 60 * 1000;

export interface ClockOutDependencies {
    authenticate(req: Request): Promise<ClockOutAuthResult>;
    findTimeEntry(id: string): Promise<ClockOutTimeEntryRow | null>;
    findProjectIsLogistics(projectId: string): Promise<boolean>;
    findOwnerRates(userId: string): Promise<{ hourlyRate: number; burdenRate: number } | null>;
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
            const { id, endTime, latitude, longitude, notes, mealSkipped } = body;

            if (!id) return NextResponse.json({ error: "Time Entry ID is required" }, { status: 400 });

            const existing = await dependencies.findTimeEntry(id);
            if (!existing) return NextResponse.json({ error: "Time Entry not found" }, { status: 404 });

            if (existing.userId !== user.id && user.role !== "MANAGER" && user.role !== "ADMIN") {
                return NextResponse.json({ error: "Unauthorized to edit this entry" }, { status: 403 });
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

            const durationMs = end.getTime() - existing.startTime.getTime();
            let durationHours = durationMs / (1000 * 60 * 60);
            if (durationHours < 0) durationHours = 0;

            // Cost is always calculated from the time-entry OWNER's rates, not the editing user's
            // (a manager editing a field crew's punch must not stamp manager rates onto the entry).
            const owner = existing.userId === user.id ? user : await dependencies.findOwnerRates(existing.userId);
            if (!owner) return NextResponse.json({ error: "Owner not found" }, { status: 404 });
            const laborCost = durationHours * owner.hourlyRate;
            const burdenCost = durationHours * owner.burdenRate;

            const updateData: Record<string, unknown> = {
                endTime: end,
                durationHours,
                laborCost,
                burdenCost,
            };

            if (latitude) updateData.latitude = latitude;
            if (longitude) updateData.longitude = longitude;
            if (logisticsCheck.notes !== undefined) updateData.notes = logisticsCheck.notes;

            // WA meal-break voluntary waiver attestation — PUT always closes the
            // entry, so this is always a clock-out.
            Object.assign(
                updateData,
                applyMealSkippedWaiver({
                    mealSkipped,
                    settingEndTime: true,
                    existingReviewReason: existing.reviewReason,
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

            return NextResponse.json(JSON.parse(JSON.stringify(closeResult.entry)));
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
