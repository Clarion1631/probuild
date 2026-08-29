// Washington meal/rest-break rules for the time clock — the AUTOMATIC-BREAK
// model (owner decision 2026-08-28): the crew no longer has to punch breaks.
//
//   Meal: 30 min UNPAID, required once the day's work passes 5 hours, a second
//         once it passes 11. Deducted AUTOMATICALLY at clock-out — UNLESS the
//         worker punched a real meal break (a ≥25-minute gap between entries),
//         a manager APPROVED a skip in advance (worker has a signed waiver on
//         file), or the worker attests at clock-out that they worked through
//         it. Worked-through time is PAID and flagged for manager review.
//         Auto-deduction is only lawful WITH that attestation escape hatch —
//         a silent deduction with no way to say "I worked through it" is the
//         classic wage-claim loser — so the clock-out question is not optional.
//   Rest: 10 min PAID per 4 hours. NEVER waivable, never deducted, never
//         offered as a skip. A missed rest break is pure documentation: paid
//         in full, flagged for the manager.
//
// Pure functions, no Prisma/Next imports (same convention as
// src/lib/logistics-time-entry.ts and src/lib/overtime.ts) — the routes fetch
// the day's entries and pass them in. `durationHours` on a TimeEntry is the
// PAID hours (every downstream consumer — Gusto export, pay-period summary,
// manager tables, variance — reads it as such); `shiftHours` is the raw
// clock-in→clock-out span; `mealDeductionHours` is the difference.

export const MEAL_REQUIRED_AFTER_HOURS = 5;
export const SECOND_MEAL_AFTER_HOURS = 11;
export const MEAL_DEDUCTION_HOURS = 0.5;
/** A gap this long between two of the day's entries counts as a punched (real) meal break. */
export const PUNCHED_MEAL_GAP_MINUTES = 25;

export type MealSkipStatus = "PENDING" | "APPROVED" | "DENIED";

export type MealOutcome =
    | "NOT_REQUIRED" // day's work ≤ 5h — nothing to deduct
    | "PUNCHED" // the worker actually took a meal break (gap between entries)
    | "AUTO_DEDUCTED" // 30 min deducted, no attestation to the contrary
    | "WORKED_THROUGH" // worker attested at clock-out — paid, flagged for review
    | "WAIVED_APPROVED" // manager approved the skip in advance — paid, not flagged
    | "DEFERRED"; // an INTERMEDIATE close (meal break, Switch Task) — the day settles on the final clock-out

/** The slice of a same-day TimeEntry the meal rule needs. */
export interface DayEntry {
    startTime: Date;
    endTime: Date;
    /** Already-applied deduction on that entry (0/null when none). */
    mealDeductionHours: number | null;
}

export interface MealDeductionInput {
    /** The worker's OTHER closed entries on the same company-local day (any order; the closing entry excluded). */
    dayEntries: DayEntry[];
    /** The entry being closed right now. */
    closing: { startTime: Date; endTime: Date };
    /** Clock-out attestation: true = "I worked through my meal". Only booleans are honored. */
    mealSkipped: unknown;
    /** The closing entry's skip-lunch request state, if any. */
    mealSkipStatus: MealSkipStatus | string | null | undefined;
    /**
     * True when this close is NOT the end of the worker's day — the app's own
     * "Clock out for lunch", Switch Task, and duplicate-cleanup closes. The
     * worker is about to clock straight back in, so nothing is settled here:
     * no deduction, no attestation, outcome DEFERRED. The final clock-out of
     * the day sees this entry in `dayEntries` and settles the whole day. A
     * deferred close that turns out to be the last of the day is under-, never
     * over-deducted, and the manager queue shows it as such.
     */
    deferMeal?: unknown;
}

export interface MealDeductionResult {
    outcome: MealOutcome;
    /** Hours to deduct from THIS entry (0 unless AUTO_DEDUCTED). */
    mealDeductionHours: number;
    /** Raw clock-in→clock-out hours of the closing entry. */
    shiftHours: number;
    /** shiftHours minus the deduction — what goes into TimeEntry.durationHours. */
    paidHours: number;
}

function hoursBetween(a: Date, b: Date): number {
    return Math.max(0, (b.getTime() - a.getTime()) / 3_600_000);
}

/**
 * Total hours covered by a set of intervals with overlaps MERGED — two
 * duplicate 07:00–15:00 punches are 8 hours of work, not 16 (the app has a
 * duplicate-entry recovery flow, so overlapping rows are reachable).
 */
export function unionHours(entries: { startTime: Date; endTime: Date }[]): number {
    const sorted = entries
        .filter((entry) => entry.endTime.getTime() > entry.startTime.getTime())
        .sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
    let total = 0;
    let curStart: number | null = null;
    let curEnd = 0;
    for (const entry of sorted) {
        const s = entry.startTime.getTime();
        const e = entry.endTime.getTime();
        if (curStart == null || s > curEnd) {
            if (curStart != null) total += curEnd - curStart;
            curStart = s;
            curEnd = e;
        } else if (e > curEnd) {
            curEnd = e;
        }
    }
    if (curStart != null) total += curEnd - curStart;
    return total / 3_600_000;
}

/** How many meals a day of `workedHours` requires under WA rules. */
export function mealsRequiredForDay(workedHours: number): number {
    if (workedHours > SECOND_MEAL_AFTER_HOURS) return 2;
    if (workedHours > MEAL_REQUIRED_AFTER_HOURS) return 1;
    return 0;
}

/**
 * Count punched meal breaks: gaps of at least PUNCHED_MEAL_GAP_MINUTES between
 * consecutive entries of the day (sorted by start). Overlapping/abutting
 * entries produce no gap. Callers pass the closing entry in `entries` too.
 */
export function countPunchedMeals(entries: { startTime: Date; endTime: Date }[]): number {
    const sorted = [...entries].sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
    let count = 0;
    let latestEnd: number | null = null;
    for (const entry of sorted) {
        if (latestEnd != null) {
            const gapMinutes = (entry.startTime.getTime() - latestEnd) / 60_000;
            if (gapMinutes >= PUNCHED_MEAL_GAP_MINUTES) count += 1;
        }
        latestEnd = latestEnd == null ? entry.endTime.getTime() : Math.max(latestEnd, entry.endTime.getTime());
    }
    return count;
}

/**
 * THE meal rule, evaluated once per clock-out against the whole day. Switch
 * Task splits a shift into several entries, so a single entry's own length
 * can never decide this — a crew member who switches jobs at 4h and 8h would
 * otherwise dodge every deduction.
 *
 * Precedence when a meal is still owed:
 *   1. a manager-approved skip           → WAIVED_APPROVED (paid, no flag)
 *   2. the worker says they worked through → WORKED_THROUGH (paid, flagged by
 *      applyMealSkippedWaiver in the route — this module never sets flags)
 *   3. otherwise                          → AUTO_DEDUCTED
 * Deduction is capped at the closing entry's own length: a 10-minute closing
 * punch on an 8-hour day cannot go negative.
 */
export function computeMealDeduction(input: MealDeductionInput): MealDeductionResult {
    const shiftHours = hoursBetween(input.closing.startTime, input.closing.endTime);
    if (input.deferMeal === true) {
        return { outcome: "DEFERRED", mealDeductionHours: 0, shiftHours, paidHours: shiftHours };
    }

    const others = input.dayEntries.filter((entry) => entry.endTime.getTime() > entry.startTime.getTime());
    // Overlaps merged: duplicate punches must not manufacture a second meal.
    const dayWorked = unionHours([...others, input.closing]);

    const required = mealsRequiredForDay(dayWorked);
    if (required === 0) {
        return { outcome: "NOT_REQUIRED", mealDeductionHours: 0, shiftHours, paidHours: shiftHours };
    }

    // Everything is in HOURS, not rounded meal counts: a deduction capped short
    // by a tiny closing punch leaves a remainder that the next close owes —
    // never a fresh full 30 minutes on top of it.
    const alreadyDeductedHours = others.reduce((sum, entry) => sum + (entry.mealDeductionHours ?? 0), 0);
    const punchedHours = countPunchedMeals([...others, input.closing]) * MEAL_DEDUCTION_HOURS;
    const owedHours = required * MEAL_DEDUCTION_HOURS - alreadyDeductedHours - punchedHours;
    if (owedHours <= 1e-9) {
        return { outcome: "PUNCHED", mealDeductionHours: 0, shiftHours, paidHours: shiftHours };
    }

    if (input.mealSkipStatus === "APPROVED") {
        return { outcome: "WAIVED_APPROVED", mealDeductionHours: 0, shiftHours, paidHours: shiftHours };
    }
    if (input.mealSkipped === true) {
        return { outcome: "WORKED_THROUGH", mealDeductionHours: 0, shiftHours, paidHours: shiftHours };
    }

    const mealDeductionHours = Math.min(owedHours, shiftHours);
    return {
        outcome: "AUTO_DEDUCTED",
        mealDeductionHours,
        shiftHours,
        paidHours: Math.max(0, shiftHours - mealDeductionHours),
    };
}

/** Sentinel — an automatic deduction that the worker was never asked about is visible to the manager, never silent. */
export const NO_ATTESTATION_NOTE = "Meal auto-deducted with no lunch answer captured at clock-out";
/** Sentinel — a mid-day (DEFERRED) close that turned out to be the last close of its day: the meal was never settled. */
export const STALE_DEFERRED_NOTE = "Mid-day close was the last of its day — meal never settled (worker did not clock back in)";
/** A DEFERRED close older than this with no later entry is treated as the end of that day. */
export const STALE_DEFERRED_AFTER_HOURS = 2;
/** Sentinel — this row overlaps another of the worker's rows the same day (duplicate punch?): both pay in full until a manager fixes it. */
export const OVERLAP_NOTE = "Overlaps another time entry the same day — duplicate punch? both are paid until corrected";
/** Sentinel — the day re-plan could not be written after a close/edit; the row holds close-time values. Verify by hand. */
export const SETTLEMENT_FAILED_NOTE = "Day settlement failed after this close — verify paid hours";

/**
 * Review finding: a DEFERRED close is client-asserted and, if the worker never
 * clocks back in (or someone curls deferMeal on a final clock-out), the day
 * would pay in full with only a muted label. Called on the worker's NEXT
 * clock-in: if their latest closed entry is DEFERRED and older than
 * STALE_DEFERRED_AFTER_HOURS, it is flagged for the manager.
 */
export function staleDeferredReview(input: {
    latest: { mealOutcome: string | null | undefined; endTime: Date | null; needsReview: boolean; reviewReason: string | null } | null | undefined;
    now: Date;
    /** Company-day keys: when the deferred close is on a DIFFERENT day than now, it is stale whatever its age. */
    latestDayKey?: string;
    todayKey?: string;
}): { needsReview: true; reviewReason: string } | null {
    const latest = input.latest;
    if (!latest || latest.mealOutcome !== "DEFERRED" || !latest.endTime) return null;
    const ageHours = (input.now.getTime() - latest.endTime.getTime()) / 3_600_000;
    const differentDay = !!input.latestDayKey && !!input.todayKey && input.latestDayKey !== input.todayKey;
    if (ageHours < STALE_DEFERRED_AFTER_HOURS && !differentDay) return null;
    const parts = reviewReasonParts(latest.reviewReason);
    if (parts.includes(STALE_DEFERRED_NOTE)) return null;
    return { needsReview: true, reviewReason: [...parts, STALE_DEFERRED_NOTE].join("; ") };
}

/**
 * Belt and braces for the wage-claim rule: if the server deducted a meal and
 * the client never captured a yes/no from the worker (old app build, a client
 * path that skipped the question), flag the entry so a manager looks at it.
 */
export function applyNoAttestationNotice(input: {
    outcome: MealOutcome;
    mealSkipped: unknown;
    existingReviewReason: string | null | undefined;
}): { needsReview?: boolean; reviewReason?: string } {
    if (input.outcome !== "AUTO_DEDUCTED") return {};
    if (input.mealSkipped === true || input.mealSkipped === false) return {};
    const parts = reviewReasonParts(input.existingReviewReason);
    if (parts.includes(NO_ATTESTATION_NOTE)) return { needsReview: true };
    return { needsReview: true, reviewReason: [...parts, NO_ATTESTATION_NOTE].join("; ") };
}

/**
 * Recompute paid hours for an EDITED entry (PATCH): the stored deduction is
 * kept as-is (a manager who wants it gone clears it deliberately), and paid
 * hours are the new raw span minus that deduction, never below zero.
 */
export function paidHoursAfterEdit(shiftHours: number, mealDeductionHours: number | null | undefined): number {
    return Math.max(0, shiftHours - (mealDeductionHours ?? 0));
}

// ── Rest-break attestation (documentation only, never pay) ─────────────────

/** Sentinel reason text — the ONE place it is defined (see MEAL_WAIVER_NOTE in logistics-time-entry.ts). */
export const REST_MISSED_NOTE = "Missed WA rest break(s) (reported at clock-out)";

function reviewReasonParts(reviewReason: string | null | undefined): string[] {
    return (reviewReason ?? "")
        .split("; ")
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
}

export interface RestAttestationInput {
    /** Raw request value — only `true`/`false` are honored. */
    restBreaksMissed: unknown;
    settingEndTime: boolean;
    existingReviewReason: string | null | undefined;
}

export interface RestAttestationResult {
    restBreaksMissed?: boolean;
    needsReview?: boolean;
    reviewReason?: string;
}

/**
 * Mirrors applyMealSkippedWaiver's shape and idempotence: `true` appends
 * REST_MISSED_NOTE once and sets needsReview; `false` removes the note and
 * clears needsReview only if no other reason remains. Rest breaks are paid,
 * so this never touches hours or cost. Apply AFTER the meal waiver so the two
 * reasons compose in the same string.
 */
export function applyRestBreakAttestation(input: RestAttestationInput): RestAttestationResult {
    if (!input.settingEndTime) return {};
    if (input.restBreaksMissed !== true && input.restBreaksMissed !== false) return {};

    const existingParts = reviewReasonParts(input.existingReviewReason);
    const hasNote = existingParts.includes(REST_MISSED_NOTE);

    if (input.restBreaksMissed === false) {
        if (!hasNote) return { restBreaksMissed: false };
        const remaining = existingParts.filter((part) => part !== REST_MISSED_NOTE);
        const result: RestAttestationResult = { restBreaksMissed: false, reviewReason: remaining.join("; ") };
        if (remaining.length === 0) result.needsReview = false;
        return result;
    }

    return {
        restBreaksMissed: true,
        needsReview: true,
        reviewReason: hasNote ? existingParts.join("; ") : [...existingParts, REST_MISSED_NOTE].join("; "),
    };
}

// ── Skip-lunch approval ─────────────────────────────────────────────────────

/** Decision X4 (Justin, 2026-08-28): the named approvers. Overridable via MEAL_SKIP_APPROVER_EMAILS. */
export const DEFAULT_MEAL_SKIP_APPROVER_EMAILS = [
    "cj@goldentouchremodeling.com",
    "rlord@goldentouchremodeling.com",
    "jadkins@goldentouchremodeling.com",
    "justin@constructionio.com",
];

export function mealSkipApproverEmails(envValue: string | undefined = process.env.MEAL_SKIP_APPROVER_EMAILS): string[] {
    const configured = (envValue ?? "")
        .split(",")
        .map((email) => email.trim().toLowerCase())
        .filter((email) => email.length > 0);
    return configured.length > 0 ? configured : DEFAULT_MEAL_SKIP_APPROVER_EMAILS;
}

/**
 * Who may approve/deny a skip-lunch request: a MANAGER/ADMIN whose email is
 * on the approver list. Role alone is not enough — the office has managers
 * who are not the crew's supervisors, and the announcement names CJ/Richard.
 */
export function canApproveMealSkip(
    user: { role: string; email: string | null | undefined },
    approverEmails: string[] = mealSkipApproverEmails()
): boolean {
    if (user.role !== "MANAGER" && user.role !== "ADMIN") return false;
    const email = (user.email ?? "").trim().toLowerCase();
    return email.length > 0 && approverEmails.includes(email);
}

export type MealSkipDecisionCheck =
    | { ok: true }
    | { ok: false; code: "NOT_PENDING" | "WAIVER_NOT_SIGNED" | "ENTRY_CLOSED" };

/**
 * Express permission, the WA way: a skip may only be APPROVED for a worker
 * with a signed meal-period waiver on file, on a still-open entry with a
 * pending request. Denial needs none of that (it changes nothing about pay).
 */
export function checkMealSkipDecision(input: {
    decision: "APPROVED" | "DENIED";
    currentStatus: string | null | undefined;
    entryClosed: boolean;
    waiverSignedAt: Date | null | undefined;
}): MealSkipDecisionCheck {
    if (input.currentStatus !== "PENDING") return { ok: false, code: "NOT_PENDING" };
    if (input.decision === "DENIED") return { ok: true };
    if (input.entryClosed) return { ok: false, code: "ENTRY_CLOSED" };
    if (!input.waiverSignedAt) return { ok: false, code: "WAIVER_NOT_SIGNED" };
    return { ok: true };
}

// ── Day settlement (Codex review, 2026-08-28) ───────────────────────────────
//
// A close settles ONE row; the day is what the law is about. So after every
// close, every closed-entry edit, and at the next clock-in following a stale
// mid-day close, the whole company-local day is re-planned from facts and
// every row that differs is rewritten (src/lib/wa-breaks-db.ts settleDay, under
// a per-worker/day advisory lock so concurrent closes cannot race each other).
// The deduction lives on the LAST entry of the day (spilling backwards only if
// that entry is too short to carry it); earlier entries read DEFERRED (mid-day)
// with no deduction. A later punched meal therefore REFUNDS an earlier
// deduction, and a sibling edit can never leave a stale one behind.

export interface SettleDayEntry {
    id: string;
    startTime: Date;
    endTime: Date;
    mealOutcome: string | null | undefined;
    mealSkipStatus: string | null | undefined;
    reviewReason: string | null | undefined;
}

export interface SettleDayUpdate {
    id: string;
    shiftHours: number;
    mealDeductionHours: number;
    paidHours: number;
    mealOutcome: MealOutcome;
    /**
     * Review-flag changes owned by settlement: set when this row newly carries
     * an unanswered deduction; CLEARED (needsReview false only if no other
     * reason remains) when a re-plan retires a settlement note this row still
     * carries. Absent = leave the row's flags alone.
     */
    needsReview?: boolean;
    reviewReason?: string;
}

/**
 * Notes a re-plan may retire on its own: the OUTCOME notes. The FAILED note is
 * deliberately NOT here — a later successful settle of a DIFFERENT day (an
 * edit that moved the row) must not erase the record that its old day failed;
 * only "Mark reviewed" (stripSettlementNotes) retires it.
 */
const SETTLEMENT_NOTES = [NO_ATTESTATION_NOTE, STALE_DEFERRED_NOTE, OVERLAP_NOTE];
/** Everything settlement owns — what "Mark reviewed" clears so a re-plan cannot re-flag a reviewed row. */
export const ALL_SETTLEMENT_NOTES = [NO_ATTESTATION_NOTE, STALE_DEFERRED_NOTE, OVERLAP_NOTE, SETTLEMENT_FAILED_NOTE];

/** Ids of rows whose interval intersects another row's (open-interval test; abutting rows do not overlap). */
export function overlappingEntryIds(entries: { id: string; startTime: Date; endTime: Date }[]): Set<string> {
    const out = new Set<string>();
    for (let i = 0; i < entries.length; i++) {
        for (let j = i + 1; j < entries.length; j++) {
            const a = entries[i];
            const b = entries[j];
            if (a.startTime.getTime() < b.endTime.getTime() && b.startTime.getTime() < a.endTime.getTime()) {
                out.add(a.id);
                out.add(b.id);
            }
        }
    }
    return out;
}

/** Drop settlement-owned notes from a reviewReason (a manager reviewed the row — a later re-plan must not re-flag it). */
export function stripSettlementNotes(reviewReason: string | null | undefined): string {
    return reviewReasonParts(reviewReason).filter((part) => !ALL_SETTLEMENT_NOTES.includes(part)).join("; ");
}

/**
 * The day's attestation facts, read off the rows themselves (an entry's stored
 * outcome is the durable record of what the worker answered at ITS close):
 *   WORKED_THROUGH                       → the worker said "worked through"
 *   AUTO_DEDUCTED without the no-answer note → the worker said "took lunch"
 *   anything else                        → no answer on that row
 */
function dayAttestation(entries: SettleDayEntry[]): { workedThrough: boolean; answered: boolean; approved: boolean } {
    let workedThrough = false;
    let answered = false;
    let approved = false;
    for (const entry of entries) {
        // Approval evidence is the authoritative request status ONLY — never a
        // previously DERIVED outcome, which a moved row would otherwise carry
        // into a second day as a second exemption.
        if (entry.mealSkipStatus === "APPROVED") approved = true;
        if (entry.mealOutcome === "WORKED_THROUGH") {
            workedThrough = true;
            answered = true;
        } else if (entry.mealOutcome === "AUTO_DEDUCTED" && !reviewReasonParts(entry.reviewReason).includes(NO_ATTESTATION_NOTE)) {
            answered = true;
        }
    }
    return { workedThrough, answered, approved };
}

/**
 * Plan the whole day. Returns one update per CLOSED entry (callers write only
 * the rows whose values actually changed). `closingAnswer` is the attestation
 * carried by the request that triggered this settlement (a clock-out), so a
 * fresh answer wins over the stored outcome of the row it is closing.
 */
export function settleDayPlan(input: {
    entries: SettleDayEntry[];
    closing?: { id: string; mealSkipped: unknown } | null;
}): SettleDayUpdate[] {
    const entries = input.entries
        .filter((entry) => entry.endTime.getTime() > entry.startTime.getTime())
        .sort((a, b) => a.startTime.getTime() - b.startTime.getTime() || a.endTime.getTime() - b.endTime.getTime());
    if (entries.length === 0) return [];

    const dayWorked = unionHours(entries);
    const required = mealsRequiredForDay(dayWorked);
    const punchedHours = countPunchedMeals(entries) * MEAL_DEDUCTION_HOURS;

    const facts = dayAttestation(entries);
    let workedThrough = facts.workedThrough;
    let answered = facts.answered;
    // A closing answer belongs to the day that actually contains the closing
    // row — an edit that moved the row to another day must not mark this one.
    if (input.closing && entries.some((entry) => entry.id === input.closing!.id)) {
        if (input.closing.mealSkipped === true) {
            workedThrough = true;
            answered = true;
        } else if (input.closing.mealSkipped === false) {
            answered = true;
        }
    }

    // Last entry of the day carries the outcome; by END time (a long entry
    // that started earlier but ended last is still the day's close). ONE
    // deterministic order — end desc, start desc, id desc — is used both here
    // and for deduction placement below, so the flag and the deduction can
    // never land on different rows when two entries end at the same instant.
    const byLatest = (a: SettleDayEntry, b: SettleDayEntry) =>
        b.endTime.getTime() - a.endTime.getTime() || b.startTime.getTime() - a.startTime.getTime() || (b.id < a.id ? -1 : b.id > a.id ? 1 : 0);
    const latestFirst = [...entries].sort(byLatest);
    const last = latestFirst[0];

    let dayOutcome: MealOutcome;
    let owedHours = 0;
    if (required === 0) dayOutcome = "NOT_REQUIRED";
    else if (required * MEAL_DEDUCTION_HOURS - punchedHours <= 1e-9) dayOutcome = "PUNCHED";
    else if (facts.approved) dayOutcome = "WAIVED_APPROVED";
    else if (workedThrough) dayOutcome = "WORKED_THROUGH";
    else {
        dayOutcome = "AUTO_DEDUCTED";
        owedHours = required * MEAL_DEDUCTION_HOURS - punchedHours;
    }

    // Place the deduction on the last entry, spilling backwards if it is too short.
    const deductions = new Map<string, number>();
    let remaining = owedHours;
    for (const entry of latestFirst) {
        if (remaining <= 1e-9) break;
        const shift = hoursBetween(entry.startTime, entry.endTime);
        const take = Math.min(shift, remaining);
        deductions.set(entry.id, take);
        remaining -= take;
    }

    // Overlapping rows (duplicate punches the app could not de-duplicate) are
    // each paid their own span — the union merge above only protects the MEAL
    // math. Pay is a manager's call, so both rows are flagged, never silent.
    const overlapping = overlappingEntryIds(entries);

    return entries.map((entry): SettleDayUpdate => {
        const shiftHours = hoursBetween(entry.startTime, entry.endTime);
        const mealDeductionHours = deductions.get(entry.id) ?? 0;
        const isLast = entry.id === last.id;
        const update: SettleDayUpdate = {
            id: entry.id,
            shiftHours,
            mealDeductionHours,
            paidHours: Math.max(0, shiftHours - mealDeductionHours),
            mealOutcome: isLast ? dayOutcome : "DEFERRED",
        };
        // Settlement-owned notes wanted on this row right now; everything else
        // on the row (GPS, waiver, failed-settle…) is preserved verbatim.
        const wanted: string[] = [];
        if (isLast && dayOutcome === "AUTO_DEDUCTED" && !answered) wanted.push(NO_ATTESTATION_NOTE);
        if (overlapping.has(entry.id)) wanted.push(OVERLAP_NOTE);
        const parts = reviewReasonParts(entry.reviewReason);
        const others = parts.filter((part) => !SETTLEMENT_NOTES.includes(part));
        const desired = [...others, ...wanted];
        const unchanged = desired.length === parts.length && desired.every((part, i) => part === parts[i]);
        if (wanted.length > 0) {
            update.needsReview = true;
            if (!unchanged) update.reviewReason = desired.join("; ");
        } else if (!unchanged) {
            // Our notes retired; keep everyone else's, clear the flag only if nothing remains.
            update.reviewReason = desired.join("; ");
            if (desired.length === 0) update.needsReview = false;
        }
        return update;
    });
}
