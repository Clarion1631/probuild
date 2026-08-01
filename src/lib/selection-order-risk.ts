// Pure delivery-risk assessment for Ordered decisions (Phase 4 — Selection
// Order Tracking + Delivery Risk,
// docs/superpowers/plans/2026-07-31-selection-order-tracking.md). No prisma,
// no server-only imports — importable directly by the staff loader (server),
// the E2E specs, and the verifier, same convention as decision-due-date.ts.
import { daysBetweenUtc } from "./date-utils";
import { formatDueDateShort } from "./decision-due-date";

export type DeliveryRiskLevel = "late" | "tight" | null;

export type DeliveryRisk = {
    level: DeliveryRiskLevel;
    // The date the arrival is being compared against — the linked schedule
    // task's startDate, or (unlinked) the decision's effectiveDueDate. Null
    // when there's nothing to compare against.
    referenceDate: Date | null;
    // Arrival minus reference, in whole UTC-midnight calendar days. Positive
    // (>= 0) for "late" (arrival on/after the reference day), negative for
    // "tight" (arrival within the buffer before it). Null when level is null.
    daysLate: number | null;
};

const NO_RISK: DeliveryRisk = { level: null, referenceDate: null, daysLate: null };

// Arrival within this many calendar days BEFORE the reference date is
// "tight" (amber) rather than clear.
const TIGHT_BUFFER_DAYS = 3;

/**
 * `linkedTaskStartAt` must be passed ONLY when the decision's schedule link
 * is genuinely live — i.e. the caller already resolved `linkState ===
 * "linked"` (see computeLinkState in decision-due-date.ts) — never for a
 * dangling or absent link. That keeps this function's fallback rule exactly
 * the plan's spec: "unlinked decisions fall back to the decision's
 * effectiveDueDate" — a dangling link is "unlinked" for this purpose too.
 *
 * "Received" decisions never show risk (status must be exactly "Ordered"),
 * and a decision with no expectedArrivalAt has nothing to assess.
 */
export function assessDeliveryRisk(input: {
    status: string;
    expectedArrivalAt: Date | string | null;
    linkedTaskStartAt: Date | string | null;
    effectiveDueDate: Date | string | null;
}): DeliveryRisk {
    if (input.status !== "Ordered") return NO_RISK;
    if (!input.expectedArrivalAt) return NO_RISK;

    const referenceRaw = input.linkedTaskStartAt ?? input.effectiveDueDate ?? null;
    if (!referenceRaw) return NO_RISK;

    const arrival = new Date(input.expectedArrivalAt);
    const reference = new Date(referenceRaw);
    if (Number.isNaN(arrival.getTime()) || Number.isNaN(reference.getTime())) return NO_RISK;

    // UTC-midnight calendar-day diff (payment-reminders.ts's convention,
    // reused via daysBetweenUtc) — arrival minus reference.
    const diff = daysBetweenUtc(reference, arrival);

    if (diff >= 0) return { level: "late", referenceDate: reference, daysLate: diff };
    if (diff >= -TIGHT_BUFFER_DAYS) return { level: "tight", referenceDate: reference, daysLate: diff };
    return NO_RISK;
}

/**
 * Shared wording builder (Codex review round 1, issue 5) — lives here
 * instead of being duplicated in the badge/banner UI so it's unit-tested
 * once, in the verifier. `arrives 0 day(s) after <date>` read as nonsense on
 * the boundary case (arrival lands exactly ON the reference day) — that's
 * "arrives the day <ref> starts", not a "0 days after" count.
 */
export function formatDeliveryRiskWording(risk: {
    level: DeliveryRiskLevel;
    referenceDate: Date | string | null;
    daysLate: number | null;
}): string {
    if (!risk.level || !risk.referenceDate || risk.daysLate === null) return "";
    const refLabel = formatDueDateShort(new Date(risk.referenceDate));
    if (risk.level === "late") {
        if (risk.daysLate === 0) return `arrives the day ${refLabel} starts`;
        return `arrives ${risk.daysLate} day${risk.daysLate === 1 ? "" : "s"} after ${refLabel}`;
    }
    const daysBefore = Math.abs(risk.daysLate);
    return `arrives ${daysBefore} day${daysBefore === 1 ? "" : "s"} before ${refLabel}`;
}
