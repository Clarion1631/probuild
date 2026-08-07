import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { isTaskActiveOnDay } from "@/app/company-dashboard/schedule-board/dispatch-exceptions";
import { toCompanyDayKey, daysBetweenDayKeys } from "@/lib/company-day";

// Clock-in task suggestion (Stage B of the daily-log accuracy pipeline).
//
// Deterministic and fast — no AI call happens at clock-in. The AI runs earlier,
// at daily-log write time (daily-log-task-match.ts), and stores its pick on the
// log. This module ranks: that stored pick, then a keyword match over the same
// log, then today's schedule, then the user's own recent history.
//
// Every suggestion must resolve to something the clock-in picker can actually
// select: a TOP-LEVEL estimate item (budget phase) on an eligible estimate,
// with a cost code. A suggestion the picker can't express — or whose leaf task
// cost code disagrees with the bucket that would actually be charged — is
// worse than none, so those are excluded rather than approximated.

export type TimeSuggestionSource = "daily_log" | "today_schedule" | "user_history";

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
    costCodeId: string | null;
    costCode: { code: string; name: string } | null;
}

export interface SuggestableTask {
    taskId: string;
    taskName: string;
    status: string;
    startDate: Date;
    endDate: Date;
    type: string;
    assignedToUser: boolean;
    /** Top-level estimate item this task charges to. */
    clockInEstimateItemId: string;
    costCodeId: string;
    costCodeLabel: string;
    costCodeCode: string;
    costCodeName: string;
}

/**
 * Load the project's leaf tasks that a suggestion is allowed to name:
 * non-Complete `type === "task"` leaves whose estimate item maps up to a
 * top-level item on an eligible estimate, where the bucket has a cost code
 * and the leaf's own cost code (if any) agrees with it.
 */
export async function loadSuggestableTasks(
    projectId: string,
    userId: string,
    db: DbClient = prisma,
): Promise<SuggestableTask[]> {
    const [tasks, items] = await Promise.all([
        db.scheduleTask.findMany({
            where: { projectId },
            select: {
                id: true,
                name: true,
                parentId: true,
                estimateItemId: true,
                startDate: true,
                endDate: true,
                status: true,
                type: true,
                assignments: { where: { userId }, select: { id: true } },
            },
        }),
        db.estimateItem.findMany({
            where: {
                estimate: { projectId, status: { in: ELIGIBLE_ESTIMATE_STATUSES }, archivedAt: null },
            },
            select: {
                id: true,
                parentId: true,
                costCodeId: true,
                costCode: { select: { code: true, name: true } },
            },
        }),
    ]);

    const itemById = new Map<string, EligibleItem>(items.map(item => [item.id, item]));
    const parentIds = new Set(tasks.map(task => task.parentId).filter((id): id is string => !!id));

    // The picker offers COST-CODED items at any depth (see the estimate-items
    // route): flat estimates code their top-level items, sectioned estimates
    // code the leaves under uncoded Section rows. The selectable target for a
    // task is therefore the nearest coded item at-or-above its linked item —
    // usually the item itself.
    const toNearestCoded = (itemId: string): EligibleItem | null => {
        let current = itemById.get(itemId);
        let hops = 0;
        while (current && hops < 10) {
            if (current.costCodeId && current.costCode) return current;
            current = current.parentId ? itemById.get(current.parentId) : undefined;
            hops += 1;
        }
        return null;
    };

    const out: SuggestableTask[] = [];
    for (const task of tasks) {
        if (task.type !== "task") continue;
        if (task.status === "Complete") continue;
        if (parentIds.has(task.id)) continue; // never suggest a phase parent
        if (!task.estimateItemId) continue;
        const leafItem = itemById.get(task.estimateItemId);
        if (!leafItem) continue; // item not on an eligible estimate
        const target = toNearestCoded(task.estimateItemId);
        if (!target) continue; // nothing chargeable anywhere up the chain
        // Walking up only happens when the task's own item is uncoded, so the
        // charged code can never contradict the leaf's — coded leaves map to
        // themselves.
        out.push({
            taskId: task.id,
            taskName: task.name,
            status: task.status,
            startDate: task.startDate,
            endDate: task.endDate,
            type: task.type,
            assignedToUser: task.assignments.length > 0,
            clockInEstimateItemId: target.id,
            costCodeId: target.costCodeId!,
            costCodeCode: target.costCode!.code,
            costCodeName: target.costCode!.name,
            costCodeLabel: `${target.costCode!.code} — ${target.costCode!.name}`,
        });
    }
    return out;
}

// ── Ranking ─────────────────────────────────────────────────────────────────

export async function suggestTaskForClockIn(
    input: { userId: string; projectId: string; now?: Date },
    db: DbClient = prisma,
): Promise<TimeSuggestion | null> {
    const { userId, projectId } = input;
    const now = input.now ?? new Date();
    const todayKey = toCompanyDayKey(now);

    const suggestable = await loadSuggestableTasks(projectId, userId, db);
    if (suggestable.length === 0) return null;
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
    });

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
                return toSuggestion(task, "daily_log", "high", latestLog.aiSuggestionReason ?? null);
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
                return toSuggestion(
                    task,
                    "daily_log",
                    match.matchedTokens >= 2 ? "high" : "medium",
                    "Matched from the latest daily log",
                );
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
        return toSuggestion(activeToday[0], "today_schedule", "medium", "Your only scheduled task today");
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
            return toSuggestion(task, "user_history", "low", "You clocked into this task last");
        }
    }

    return null;
}
