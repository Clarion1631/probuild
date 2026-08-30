import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { isTaskActiveOnDay } from "@/app/company-dashboard/schedule-board/dispatch-exceptions";
import { toCompanyDayKey, daysBetweenDayKeys } from "@/lib/company-day";

// Clock-in task suggestion (Stage B of the daily-log accuracy pipeline).
//
// Deterministic and fast — no AI call happens at clock-in. The AI runs earlier,
// at daily-log write time (daily-log-task-match.ts), and stores its pick on the
// log. This module ranks: dispatch (what the office planned for you today),
// then that stored daily-log pick, then a keyword match over the same log,
// then today's schedule, then the user's own recent history.
//
// Every suggestion must resolve to something the clock-in picker can actually
// select: a TOP-LEVEL estimate item (budget phase) on an eligible estimate,
// with a cost code. A suggestion the picker can't express — or whose leaf task
// cost code disagrees with the bucket that would actually be charged — is
// worse than none, so those are excluded rather than approximated.

export type TimeSuggestionSource = "dispatch" | "daily_log" | "today_schedule" | "user_history";

export interface TimeSuggestion {
    scheduleTaskId: string;
    /** Top-level estimate item the picker should preselect — the thing that gets charged. */
    clockInEstimateItemId: string;
    costCodeId: string;
    costCodeLabel: string; // "01-DEMO — Demolition"
    taskName: string;
    source: TimeSuggestionSource;
    confidence: "high" | "medium" | "low";
    reason: string | null;
    /** The suggested task's completion criteria — "the note that was sent to the crew guy". */
    note: string | null;
    /** True only when `source` is "dispatch" — this is what the office planned for today. */
    plannedByOffice: boolean;
}

export interface UncostedPlannedTask {
    id: string;
    name: string;
    /** The uncosted task's completion criteria — same meaning as TimeSuggestion.note. */
    note: string | null;
}

export interface TimeSuggestionResult {
    suggestion: TimeSuggestion | null;
    /**
     * Set when the caller is dispatched to a task today that has no chargeable
     * estimate item/cost code — so it can never be `suggestion` — but the app
     * should still surface it: "Planned: drywall start (not costed) — pick a phase".
     */
    uncostedPlannedTask: UncostedPlannedTask | null;
}

// Statuses under which an estimate's items appear in the clock-in picker
// (mirrors /api/projects/[id]/estimate-items).
const ELIGIBLE_ESTIMATE_STATUSES = ["Approved", "Invoiced", "Partially Paid", "Paid"];

const DAILY_LOG_LOOKBACK_DAYS = 7;
const HISTORY_LOOKBACK_DAYS = 3;

// ── Pure text matching (exercised directly by scripts/verify-time-suggestion.ts) ──

const STOPWORDS = new Set([
    "the", "and", "for", "with", "was", "were", "are", "have", "has", "had",
    "will", "then", "than", "that", "this", "them", "they", "there", "out",
    "our", "all", "any", "but", "not", "did", "done", "get", "got", "today",
    "tomorrow", "next", "steps", "day", "days", "morning", "afternoon",
    "finish", "finished", "start", "started", "continue", "continued",
    "work", "worked", "working", "crew", "site", "job", "more", "some",
]);

/** Lowercase word tokens, punctuation stripped, stopwords and short tokens dropped. */
export function tokenizeForMatch(text: string | null | undefined): string[] {
    if (!text) return [];
    return text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter(token => token.length >= 3 && !STOPWORDS.has(token) && !/^\d+$/.test(token));
}

export interface KeywordCandidate {
    taskId: string;
    taskName: string;
    costCodeCode: string | null;
    costCodeName: string | null;
}

export interface KeywordMatch {
    taskId: string;
    score: number;
    /** How many DISTINCT log tokens hit the winner — confidence needs breadth, not one hot word. */
    matchedTokens: number;
}

/**
 * Score candidate tasks against log text. `nextSteps` tokens count double —
 * a stated plan for tomorrow outweighs a description of finished work.
 * Returns the sole best match, or null when nothing scores or the top is tied
 * (a tie means the log doesn't disambiguate; guessing would misfile hours).
 */
export function keywordMatchTasks(
    input: { nextSteps?: string | null; workPerformed?: string | null; photoCaptions?: string[] },
    candidates: KeywordCandidate[],
): KeywordMatch | null {
    const weighted = new Map<string, number>();
    for (const token of tokenizeForMatch(input.nextSteps)) {
        weighted.set(token, 2);
    }
    const singleWeight = [
        ...tokenizeForMatch(input.workPerformed),
        ...(input.photoCaptions ?? []).flatMap(caption => tokenizeForMatch(caption)),
    ];
    for (const token of singleWeight) {
        if (!weighted.has(token)) weighted.set(token, 1);
    }
    if (weighted.size === 0) return null;

    let best: KeywordMatch | null = null;
    let tied = false;
    for (const candidate of candidates) {
        const candidateTokens = new Set([
            ...tokenizeForMatch(candidate.taskName),
            ...tokenizeForMatch(candidate.costCodeName),
            ...tokenizeForMatch(candidate.costCodeCode?.replace(/[-_]/g, " ")),
        ]);
        let score = 0;
        let matchedTokens = 0;
        for (const token of candidateTokens) {
            const weight = weighted.get(token) ?? 0;
            score += weight;
            if (weight > 0) matchedTokens += 1;
        }
        if (score === 0) continue;
        if (!best || score > best.score) {
            best = { taskId: candidate.taskId, score, matchedTokens };
            tied = false;
        } else if (score === best.score) {
            tied = true;
        }
    }
    if (!best || tied) return null;
    return best;
}

// ── Candidate loading + picker mapping ──────────────────────────────────────

type DbClient = PrismaClient | Prisma.TransactionClient;

interface EligibleItem {
    id: string;
    parentId: string | null;
    estimateId: string;
    costCodeId: string | null;
    costCode: { code: string; name: string } | null;
}

export interface ChargeableItem {
    id: string;
    name: string;
    total: unknown;
    estimateId: string;
    estimateTitle: string | null;
    costCodeId: string | null;
    costCode: { code: string; name: string } | null;
}

const CHARGEABLE_ESTIMATE_SELECT = {
    id: true,
    title: true,
    items: {
        orderBy: { order: "asc" as const },
        select: {
            id: true,
            name: true,
            total: true,
            parentId: true,
            costCodeId: true,
            costCode: { select: { code: true, name: true } },
        },
    },
} as const;

/** Raw estimate shape (Prisma result of CHARGEABLE_ESTIMATE_SELECT) the pure resolver below works over. */
export interface ChargeableEstimateInput {
    id: string;
    title: string | null;
    items: {
        id: string;
        name: string;
        total: unknown;
        parentId: string | null;
        costCodeId: string | null;
        costCode: { code: string; name: string } | null;
    }[];
}

/**
 * PURE per-estimate resolver — no I/O, exercised directly by
 * scripts/verify-time-suggestion.ts. Shared by both `resolveChargeableItems`
 * (single project) and `resolveChargeableItemsForProjects` (batch) so their
 * eligibility rules and leaf→nearest-coded-ancestor logic can never drift
 * apart.
 *
 * Enumerate LEAF items, resolve each leaf to its nearest coded item
 * at-or-above (same estimate only, visited-set guarded), and dedupe those
 * targets. A coded parent whose children are also coded is therefore never
 * offered alongside them (the children win), and a summary parent is offered
 * exactly once when its children are uncoded. An estimate with no coded
 * items at all falls back to its own top-level rows (legacy, chargeless).
 */
export function resolveEstimateChargeableItems(
    estimate: ChargeableEstimateInput,
): { offered: ChargeableItem[]; targetByItemId: Map<string, ChargeableItem> } {
    const offered: ChargeableItem[] = [];
    const targetByItemId = new Map<string, ChargeableItem>();

    const byId = new Map(estimate.items.map(item => [item.id, item]));
    const hasChildren = new Set(
        estimate.items.map(item => item.parentId).filter((id): id is string => !!id),
    );

    const toChargeable = (item: (typeof estimate.items)[number]): ChargeableItem => ({
        id: item.id,
        name: item.name,
        total: item.total,
        estimateId: estimate.id,
        estimateTitle: estimate.title ?? null,
        costCodeId: item.costCodeId,
        costCode: item.costCode,
    });

    // Nearest coded item at-or-above, WITHIN this estimate, cycle-safe.
    const nearestCoded = (itemId: string): (typeof estimate.items)[number] | null => {
        const visited = new Set<string>();
        let current = byId.get(itemId);
        while (current && !visited.has(current.id)) {
            visited.add(current.id);
            if (current.costCodeId && current.costCode) return current;
            current = current.parentId ? byId.get(current.parentId) : undefined;
        }
        return null;
    };

    const seenTargets = new Set<string>();
    for (const item of estimate.items) {
        if (hasChildren.has(item.id)) continue; // leaves only drive the offer
        const target = nearestCoded(item.id);
        if (target && !seenTargets.has(target.id)) {
            seenTargets.add(target.id);
            offered.push(toChargeable(target));
        }
    }

    if (seenTargets.size === 0) {
        // Fully uncoded estimate — legacy top-level rows, chargeless.
        for (const item of estimate.items) {
            if (item.parentId === null) offered.push(toChargeable(item));
        }
    }

    // Resolution map for EVERY item on the estimate (engine + chat use it).
    for (const item of estimate.items) {
        const target = nearestCoded(item.id);
        if (target) targetByItemId.set(item.id, toChargeable(target));
    }

    return { offered, targetByItemId };
}

/**
 * THE one resolver for "what can a punch charge to" — used by the picker
 * route, the suggestion engine, and the chat post-back so they can never
 * disagree. See `resolveEstimateChargeableItems` for the per-estimate rules.
 */
export async function resolveChargeableItems(
    projectId: string,
    db: DbClient = prisma,
): Promise<{ items: ChargeableItem[]; targetByItemId: Map<string, ChargeableItem> }> {
    const estimates = await db.estimate.findMany({
        where: { projectId, status: { in: ELIGIBLE_ESTIMATE_STATUSES }, archivedAt: null },
        orderBy: { createdAt: "asc" },
        select: CHARGEABLE_ESTIMATE_SELECT,
    });

    const offered: ChargeableItem[] = [];
    const targetByItemId = new Map<string, ChargeableItem>();

    for (const estimate of estimates) {
        const resolved = resolveEstimateChargeableItems(estimate);
        offered.push(...resolved.offered);
        for (const [itemId, target] of resolved.targetByItemId) {
            targetByItemId.set(itemId, target);
        }
    }

    return { items: offered, targetByItemId };
}

/**
 * Batch form of `resolveChargeableItems` — ONE query loads eligible
 * estimates + items for every project in `projectIds`, instead of one query
 * per project. Same eligibility rules and per-estimate leaf→nearest-coded-
 * ancestor logic (both call `resolveEstimateChargeableItems`), so callers
 * get identical output to calling the single-project version once per id.
 *
 * Used by the company dashboard, which only needs `targetByItemId` for
 * projects that actually have tasks with `estimateItemId` set — callers
 * should filter `projectIds` down to that set before calling.
 */
export async function resolveChargeableItemsForProjects(
    projectIds: string[],
    db: DbClient = prisma,
): Promise<Map<string, { items: ChargeableItem[]; targetByItemId: Map<string, ChargeableItem> }>> {
    const result = new Map<string, { items: ChargeableItem[]; targetByItemId: Map<string, ChargeableItem> }>();
    if (projectIds.length === 0) return result;

    const estimates = await db.estimate.findMany({
        where: { projectId: { in: projectIds }, status: { in: ELIGIBLE_ESTIMATE_STATUSES }, archivedAt: null },
        orderBy: { createdAt: "asc" },
        select: { ...CHARGEABLE_ESTIMATE_SELECT, projectId: true },
    });

    for (const estimate of estimates) {
        if (!estimate.projectId) continue; // filtered on projectId: {in: projectIds} above, but the column is nullable
        const resolved = resolveEstimateChargeableItems(estimate);
        const entry = result.get(estimate.projectId) ?? { items: [], targetByItemId: new Map<string, ChargeableItem>() };
        entry.items.push(...resolved.offered);
        for (const [itemId, target] of resolved.targetByItemId) {
            entry.targetByItemId.set(itemId, target);
        }
        result.set(estimate.projectId, entry);
    }

    return result;
}

export interface SuggestableTask {
    taskId: string;
    taskName: string;
    status: string;
    startDate: Date;
    endDate: Date;
    type: string;
    /** ScheduleTask.order — the canonical schedule sequence. */
    order: number;
    assignedToUser: boolean;
    /** Role of the caller's own TaskAssignment on this task ("assigned" | "lead"), null if unassigned. */
    assignmentRole: string | null;
    /** Completion criteria shown to the field crew — surfaced as the suggestion's `note`. */
    doneWhen: string | null;
    /** The chargeable estimate item this task resolves to (offered by the picker). */
    clockInEstimateItemId: string;
    costCodeId: string;
    costCodeLabel: string;
    costCodeCode: string;
    costCodeName: string;
}

/**
 * Load the project's leaf tasks that a suggestion is allowed to name:
 * non-Complete `type === "task"` leaves whose linked estimate item resolves —
 * via resolveChargeableItems, the same resolver the picker uses — to a
 * cost-coded chargeable target on an eligible estimate.
 */
export async function loadSuggestableTasks(
    projectId: string,
    userId: string,
    db: DbClient = prisma,
): Promise<SuggestableTask[]> {
    const [tasks, { targetByItemId }] = await Promise.all([
        db.scheduleTask.findMany({
            where: { projectId },
            orderBy: { order: "asc" },
            select: {
                id: true,
                name: true,
                parentId: true,
                estimateItemId: true,
                startDate: true,
                endDate: true,
                status: true,
                type: true,
                order: true,
                doneWhen: true,
                assignments: { where: { userId }, select: { id: true, role: true } },
            },
        }),
        resolveChargeableItems(projectId, db),
    ]);

    const parentIds = new Set(tasks.map(task => task.parentId).filter((id): id is string => !!id));

    const out: SuggestableTask[] = [];
    for (const task of tasks) {
        if (task.type !== "task") continue;
        if (task.status === "Complete") continue;
        if (parentIds.has(task.id)) continue; // never suggest a phase parent
        if (!task.estimateItemId) continue;
        const target = targetByItemId.get(task.estimateItemId);
        if (!target || !target.costCodeId || !target.costCode) continue; // nothing chargeable up the (same-estimate) chain
        out.push({
            taskId: task.id,
            taskName: task.name,
            status: task.status,
            startDate: task.startDate,
            endDate: task.endDate,
            type: task.type,
            order: task.order,
            assignedToUser: task.assignments.length > 0,
            assignmentRole: task.assignments[0]?.role ?? null,
            doneWhen: task.doneWhen,
            clockInEstimateItemId: target.id,
            costCodeId: target.costCodeId,
            costCodeCode: target.costCode.code,
            costCodeName: target.costCode.name,
            costCodeLabel: `${target.costCode.code} — ${target.costCode.name}`,
        });
    }
    return out;
}

// ── Ranking ─────────────────────────────────────────────────────────────────

/**
 * role "lead" first, then earliest startDate, then name, then schedule
 * `order`, then task id — the dispatch tie-break rule. The last two keys
 * exist only to make the sort deterministic when role/startDate/name are
 * ALL equal (e.g. two same-named tasks split across schedule rows); without
 * them the comparator returns 0 for that pair and the winner falls out to
 * whatever order the DB happened to return, which can flip between calls.
 * Applied across ALL of the caller's active dispatched assignments for
 * today, chargeable or not — a lead assignment on an uncosted task must be
 * able to beat an ordinary chargeable one. Exported for the pure regression
 * test in scripts/verify-time-suggestion.ts.
 */
export function pickDispatchWinner<T extends {
    assignmentRole?: string | null;
    startDate: Date;
    taskName?: string;
    name?: string;
    order?: number;
    taskId?: string;
    id?: string;
}>(
    candidates: T[],
): T {
    return [...candidates].sort((a, b) => {
        const aLead = a.assignmentRole === "lead" ? 0 : 1;
        const bLead = b.assignmentRole === "lead" ? 0 : 1;
        if (aLead !== bLead) return aLead - bLead;
        const dateDiff = a.startDate.getTime() - b.startDate.getTime();
        if (dateDiff !== 0) return dateDiff;
        const nameDiff = (a.taskName ?? a.name ?? "").localeCompare(b.taskName ?? b.name ?? "");
        if (nameDiff !== 0) return nameDiff;
        const orderDiff = (a.order ?? 0) - (b.order ?? 0);
        if (orderDiff !== 0) return orderDiff;
        return (a.taskId ?? a.id ?? "").localeCompare(b.taskId ?? b.id ?? "");
    })[0];
}

/** One of the caller's active-today dispatched assignments, ranked alongside every other one regardless of chargeability. */
interface DispatchCandidate {
    taskId: string;
    taskName: string;
    startDate: Date;
    assignmentRole: string | null;
    doneWhen: string | null;
    /** ScheduleTask.order — final stable tie-break key, after role/startDate/name. */
    order: number;
    chargeable: boolean;
    /** Populated only when `chargeable` — the full suggestable row, for building the TimeSuggestion. */
    suggestable: SuggestableTask | null;
}

/**
 * Raw (not-necessarily-chargeable) leaf tasks the caller is dispatched to
 * today, restricted to ones that DON'T resolve to a chargeable item — the
 * chargeable ones are already present in `suggestable`. Merged with those in
 * `loadDispatchCandidates` so the tie-break ranks the caller's ENTIRE active
 * dispatch together, not chargeable-first.
 */
async function loadUncostedDispatchedCandidates(
    projectId: string,
    userId: string,
    todayKey: string,
    db: DbClient,
): Promise<DispatchCandidate[]> {
    const [assigned, allTasks, { targetByItemId }] = await Promise.all([
        db.scheduleTask.findMany({
            where: { projectId, type: "task", status: { not: "Complete" }, assignments: { some: { userId } } },
            orderBy: { order: "asc" },
            select: {
                id: true,
                name: true,
                startDate: true,
                endDate: true,
                type: true,
                estimateItemId: true,
                doneWhen: true,
                order: true,
                assignments: { where: { userId }, select: { role: true } },
            },
        }),
        db.scheduleTask.findMany({ where: { projectId }, select: { parentId: true } }),
        resolveChargeableItems(projectId, db),
    ]);
    const parentIds = new Set(allTasks.map(task => task.parentId).filter((id): id is string => !!id));

    return assigned
        .filter(task => !parentIds.has(task.id))
        .filter(task => isTaskActiveOnDay(
            { startDate: task.startDate.toISOString(), endDate: task.endDate.toISOString(), type: task.type },
            todayKey,
        ))
        .filter(task => {
            if (!task.estimateItemId) return true; // nothing linked at all
            const target = targetByItemId.get(task.estimateItemId);
            return !target || !target.costCodeId || !target.costCode; // linked, but not chargeable
        })
        .map(task => ({
            taskId: task.id,
            taskName: task.name,
            startDate: task.startDate,
            assignmentRole: task.assignments[0]?.role ?? null,
            doneWhen: task.doneWhen,
            order: task.order,
            chargeable: false as const,
            suggestable: null,
        }));
}

/**
 * ALL of the caller's active-today dispatched assignments, chargeable and
 * uncosted alike, as one ranking pool — so the tie-break (lead, then
 * earliest start, then name) decides across the whole dispatch rather than
 * only within the chargeable subset.
 */
async function loadDispatchCandidates(
    projectId: string,
    userId: string,
    todayKey: string,
    suggestable: SuggestableTask[],
    db: DbClient,
): Promise<DispatchCandidate[]> {
    const chargeable: DispatchCandidate[] = suggestable
        .filter(task =>
            task.assignedToUser
            && isTaskActiveOnDay(
                { startDate: task.startDate.toISOString(), endDate: task.endDate.toISOString(), type: task.type },
                todayKey,
            ))
        .map(task => ({
            taskId: task.taskId,
            taskName: task.taskName,
            startDate: task.startDate,
            assignmentRole: task.assignmentRole,
            doneWhen: task.doneWhen,
            order: task.order,
            chargeable: true,
            suggestable: task,
        }));
    const uncosted = await loadUncostedDispatchedCandidates(projectId, userId, todayKey, db);
    return [...chargeable, ...uncosted];
}

export interface DispatchWinner {
    taskId: string;
    /** True when the winner resolves to a chargeable item (has a real cost code). */
    chargeable: boolean;
    /** The winner's chargeable cost code, when `chargeable` — null otherwise. */
    costCodeId: string | null;
}

/**
 * THE dispatch-winner computation — the same eligibility + ranking
 * `suggestTaskForClockIn`'s tier 0 uses (loadDispatchCandidates +
 * pickDispatchWinner), exposed standalone so the punch-provenance check in
 * the time-entries route (gate P2) can ask "is the id the client claims
 * actually today's dispatch winner for this user?" without re-deriving or
 * drifting from the engine's own ranking. Returns null when the caller has
 * no active-today dispatched assignment at all — completed/milestone/
 * appointment/parent tasks and anything not assigned to `userId` are never
 * candidates (see loadSuggestableTasks / loadUncostedDispatchedCandidates),
 * so those can never come back as the winner.
 */
export async function computeDispatchWinnerForUser(
    userId: string,
    projectId: string,
    dayKey: string,
    db: DbClient = prisma,
): Promise<DispatchWinner | null> {
    const suggestable = await loadSuggestableTasks(projectId, userId, db);
    const dispatchCandidates = await loadDispatchCandidates(projectId, userId, dayKey, suggestable, db);
    if (dispatchCandidates.length === 0) return null;
    const winner = pickDispatchWinner(dispatchCandidates);
    return {
        taskId: winner.taskId,
        chargeable: winner.chargeable,
        costCodeId: winner.chargeable && winner.suggestable ? winner.suggestable.costCodeId : null,
    };
}

export async function suggestTaskForClockIn(
    input: { userId: string; projectId: string; now?: Date },
    db: DbClient = prisma,
): Promise<TimeSuggestionResult> {
    const { userId, projectId } = input;
    const now = input.now ?? new Date();
    const todayKey = toCompanyDayKey(now);

    const suggestable = await loadSuggestableTasks(projectId, userId, db);
    const byTaskId = new Map(suggestable.map(task => [task.taskId, task]));

    const toSuggestion = (
        task: SuggestableTask,
        source: TimeSuggestionSource,
        confidence: TimeSuggestion["confidence"],
        reason: string | null,
    ): TimeSuggestion => ({
        scheduleTaskId: task.taskId,
        clockInEstimateItemId: task.clockInEstimateItemId,
        costCodeId: task.costCodeId,
        costCodeLabel: task.costCodeLabel,
        taskName: task.taskName,
        source,
        confidence,
        reason,
        note: task.doneWhen ?? null,
        plannedByOffice: source === "dispatch",
    });

    // 0 — dispatch: EVERY task active today that the caller is assigned to
    // (any role), chargeable or not, ranked together — "this is what was
    // planned for you today" beats everything inferred from logs or history,
    // and a lead assignment on an uncosted task must be able to beat an
    // ordinary chargeable one rather than losing by being considered second.
    // Ties resolve deterministically: lead role wins, then earliest start,
    // then name. If the winner is chargeable it becomes `suggestion`. If not,
    // it can never be `suggestion` — it's surfaced as `uncostedPlannedTask`
    // instead, and `suggestion` falls through to the lower tiers below.
    const dispatchCandidates = await loadDispatchCandidates(projectId, userId, todayKey, suggestable, db);
    let uncostedPlannedTask: UncostedPlannedTask | null = null;
    if (dispatchCandidates.length > 0) {
        const winner = pickDispatchWinner(dispatchCandidates);
        if (winner.chargeable && winner.suggestable) {
            return { suggestion: toSuggestion(winner.suggestable, "dispatch", "high", "Dispatched to you today"), uncostedPlannedTask: null };
        }
        uncostedPlannedTask = { id: winner.taskId, name: winner.taskName, note: winner.doneWhen };
    }

    // 1 + 2 — the latest daily log (within lookback), AI pick first, keywords
    // second. DailyLog.date is stored as UTC midnight of a date-only input, so
    // the intended calendar day is the ISO date part — running it through a
    // timezone conversion would shift it back a day. Future-dated logs are
    // excluded outright: tomorrow's plan can't be evidence for today.
    const latestLog = await db.dailyLog.findFirst({
        where: { projectId, date: { lte: new Date(`${todayKey}T23:59:59.999Z`) } },
        orderBy: [{ date: "desc" }, { createdAt: "desc" }],
        select: {
            date: true,
            nextSteps: true,
            workPerformed: true,
            aiSuggestedTaskId: true,
            aiSuggestionReason: true,
            photos: { select: { caption: true } },
        },
    });
    const logDayKey = latestLog ? latestLog.date.toISOString().slice(0, 10) : null;
    const logAge = logDayKey ? daysBetweenDayKeys(logDayKey, todayKey) : null;
    const logIsFresh = logAge !== null && logAge >= 0 && logAge <= DAILY_LOG_LOOKBACK_DAYS;

    if (latestLog && logIsFresh) {
        if (latestLog.aiSuggestedTaskId) {
            const task = byTaskId.get(latestLog.aiSuggestedTaskId);
            if (task) {
                return { suggestion: toSuggestion(task, "daily_log", "high", latestLog.aiSuggestionReason ?? null), uncostedPlannedTask };
            }
            // Stored pick points at a task that is gone/complete/unmappable — fall through.
        }
        const match = keywordMatchTasks(
            {
                nextSteps: latestLog.nextSteps,
                workPerformed: latestLog.workPerformed,
                photoCaptions: latestLog.photos.map(photo => photo.caption ?? "").filter(Boolean),
            },
            suggestable.map(task => ({
                taskId: task.taskId,
                taskName: task.taskName,
                costCodeCode: task.costCodeCode,
                costCodeName: task.costCodeName,
            })),
        );
        if (match) {
            const task = byTaskId.get(match.taskId);
            if (task) {
                // "High" needs breadth: two distinct tokens agreeing, not one
                // hot word that happened to sit in nextSteps.
                return {
                    suggestion: toSuggestion(
                        task,
                        "daily_log",
                        match.matchedTokens >= 2 ? "high" : "medium",
                        "Matched from the latest daily log",
                    ),
                    uncostedPlannedTask,
                };
            }
        }
    }

    // 3 — sole assigned task active today.
    const activeToday = suggestable.filter(task =>
        task.assignedToUser
        && isTaskActiveOnDay(
            { startDate: task.startDate.toISOString(), endDate: task.endDate.toISOString(), type: task.type },
            todayKey,
        ));
    if (activeToday.length === 1) {
        return { suggestion: toSuggestion(activeToday[0], "today_schedule", "medium", "Your only scheduled task today"), uncostedPlannedTask };
    }

    // 4 — the user's most recent closed entry on this project, if its task still qualifies.
    const historyCutoff = new Date(now.getTime() - HISTORY_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    const lastEntry = await db.timeEntry.findFirst({
        where: {
            userId,
            projectId,
            endTime: { not: null, gte: historyCutoff },
            scheduleTaskId: { not: null },
        },
        orderBy: { endTime: "desc" },
        select: { scheduleTaskId: true },
    });
    if (lastEntry?.scheduleTaskId) {
        const task = byTaskId.get(lastEntry.scheduleTaskId);
        if (task) {
            return { suggestion: toSuggestion(task, "user_history", "low", "You clocked into this task last"), uncostedPlannedTask };
        }
    }

    return { suggestion: null, uncostedPlannedTask };
}
