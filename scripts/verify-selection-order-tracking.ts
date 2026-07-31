// Verifier for Selection Order Tracking + Delivery Risk
// (docs/superpowers/plans/2026-07-31-selection-order-tracking.md). Mirrors
// scripts/verify-selection-templates.ts's structure: static regex
// assertions against source files, plus dynamic behavior checks against the
// real (pure/plain-module) exports.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assessDeliveryRisk } from "../src/lib/selection-order-risk";
import { companyTodayAsUtcMidnight } from "../src/lib/decision-due-date";

const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

const schema = read("prisma/schema.prisma");
const applyScript = read("scripts/apply-selection-order-tracking.mjs");
const orderActionsCore = read("src/lib/decision-order-actions-core.ts");
const orderRisk = read("src/lib/selection-order-risk.ts");
const actions = read("src/lib/actions.ts");

// ── Schema / migration ──────────────────────────────────────────────────────

assert.match(schema, /orderedAt\s+DateTime\?/, "Decision.orderedAt must be an optional DateTime");
assert.match(schema, /orderedBy\s+String\?/, "Decision.orderedBy must be an optional String");
assert.match(schema, /expectedArrivalAt\s+DateTime\?/, "Decision.expectedArrivalAt must be an optional DateTime");
assert.match(applyScript, /ALTER TABLE "Decision" ADD COLUMN IF NOT EXISTS "orderedAt"/, "migration must add orderedAt idempotently");
assert.match(applyScript, /ALTER TABLE "Decision" ADD COLUMN IF NOT EXISTS "orderedBy"/, "migration must add orderedBy idempotently");
assert.match(applyScript, /ALTER TABLE "Decision" ADD COLUMN IF NOT EXISTS "expectedArrivalAt"/, "migration must add expectedArrivalAt idempotently");
// No new tables — additive columns on the existing Decision table only, so
// no RLS statements belong in this migration (unlike apply-selection-templates.mjs,
// which DOES need them for its two brand-new tables).
assert.ok(!/ENABLE ROW LEVEL SECURITY/.test(applyScript), "no new tables here — this migration must not touch RLS");
assert.ok(!/CREATE TABLE/.test(applyScript), "this migration must be columns-only, no new tables");

// ── Auth-before-lookup (house rule, Codex review precedent on the sibling
//    decision-link-actions-core.ts, issue 11): the actor resolution must
//    appear BEFORE the decision.findFirst lookup in source order. ──────────

const actorIdx = orderActionsCore.indexOf("const actor = await (deps.getActor ?? defaultGetActor)();");
const lookupIdx = orderActionsCore.indexOf("prisma.decision.findFirst(");
assert.ok(actorIdx > -1, "setDecisionOrderInfo must resolve the actor via deps.getActor / defaultGetActor");
assert.ok(lookupIdx > -1, "setDecisionOrderInfo must look up the decision");
assert.ok(actorIdx < lookupIdx, "actor resolution must run BEFORE the decision lookup (no existence oracle for unauthenticated callers)");
assert.match(orderActionsCore, /if \(!actor\) throw new Error\("Forbidden"\);/, "an unauthenticated caller must be rejected with Forbidden before any lookup");
assert.match(orderActionsCore, /canAccessProject/, "setDecisionOrderInfo must gate on canAccessProject (any project staff, not ADMIN/MANAGER-only)");
assert.ok(!/isAdminOrManager/.test(orderActionsCore), "setDecisionOrderInfo must NOT be ADMIN/MANAGER-gated — any project staff, same bar as linkDecisionToSchedule");

// ── CAS transition matrix: Decided/Ordered -> Ordered, Ordered -> Received,
//    Ordered/Received -> clear -> Decided. Each must be a single CAS
//    updateMany keyed on both id AND the allowed source status/statuses. ───

assert.match(
    orderActionsCore,
    /where:\s*\{\s*id:\s*decisionId,\s*deletedAt:\s*null,\s*status:\s*\{\s*in:\s*\["Decided",\s*"Ordered"\]\s*\}\s*\}/,
    "marking ordered must CAS from status in [Decided, Ordered] only",
);
assert.match(
    orderActionsCore,
    /where:\s*\{\s*id:\s*decisionId,\s*deletedAt:\s*null,\s*status:\s*"Ordered"\s*\}/,
    "marking received must CAS from status \"Ordered\" only",
);
assert.match(
    orderActionsCore,
    /where:\s*\{\s*id:\s*decisionId,\s*deletedAt:\s*null,\s*status:\s*\{\s*in:\s*\["Ordered",\s*"Received"\]\s*\}\s*\}/,
    "clearing must CAS from status in [Ordered, Received] only",
);
assert.match(
    orderActionsCore,
    /data:\s*\{\s*status:\s*"Decided",\s*orderedAt:\s*null,\s*orderedBy:\s*null,\s*expectedArrivalAt:\s*null\s*\}/,
    "clearing must null all three order fields and return status to Decided",
);
assert.match(orderActionsCore, /updated\.count === 0/, "every CAS write must check count === 0 (skipped/lost race)");

// ── Validation: orderedAt <= today+1d (company-day), expectedArrivalAt >=
//    orderedAt, both within the 2020..+5y sanity window ────────────────────

assert.match(orderActionsCore, /companyTodayAsUtcMidnight/, "the future-date check must use the company-local \"today\", not a bare UTC new Date()");
assert.match(orderActionsCore, /expectedArrivalAt\.getTime\(\) < input\.orderedAt\.getTime\(\)/, "expectedArrivalAt must be validated >= orderedAt");
assert.match(orderActionsCore, /2020-01-01/, "sanity bound must start at 2020-01-01");

// ── setDecisionOrderInfo is the ONLY writer of these three columns ─────────

assert.match(actions, /setDecisionOrderInfoCore/, "actions.ts must have a thin setDecisionOrderInfo wrapper over the core seam");
// actions.ts's existing chooseItem/unchooseItem paths only ever READ
// decision.status === "Ordered" (as a terminal-state guard) — they must
// never WRITE status: "Ordered". decision-order-actions-core.ts is asserted
// above to be the sole CAS writer of that transition.
assert.ok(!/data:\s*\{[^}]*status:\s*"Ordered"/.test(actions), "actions.ts must not contain a second writer of status: \"Ordered\" outside the core seam");

// ── Portal payload stripping: negative assertion covers all THREE raw
//    field names (orderedAt, orderedBy, expectedArrivalAt); only
//    orderStatusForPortal is derived/exposed ────────────────────────────────

assert.match(actions, /function stripOrderFields</, "actions.ts must define stripOrderFields");
assert.match(actions, /function attachOrderStatusForPortal</, "actions.ts must define attachOrderStatusForPortal");
const portalDecisionsIdx = actions.indexOf("export async function getProjectDecisionsForPortal(");
const portalDecisionsSlice = actions.slice(portalDecisionsIdx, portalDecisionsIdx + 1500);
assert.match(portalDecisionsSlice, /stripOrderFields\(/, "getProjectDecisionsForPortal must strip the raw order-tracking fields");
assert.match(portalDecisionsSlice, /attachOrderStatusForPortal\(/, "getProjectDecisionsForPortal must attach orderStatusForPortal");
assert.ok(!/attachOrderRisk/.test(portalDecisionsSlice), "the portal read must NEVER attach the risk object — staff-only");
const stripOrderFieldsIdx = actions.indexOf("function stripOrderFields<");
const stripOrderFieldsSlice = actions.slice(stripOrderFieldsIdx, stripOrderFieldsIdx + 400);
assert.match(stripOrderFieldsSlice, /orderedAt/);
assert.match(stripOrderFieldsSlice, /orderedBy/);
assert.match(stripOrderFieldsSlice, /expectedArrivalAt/);

// Staff read attaches risk via the SAME batched schedule-task lookup — no
// new N+1 query.
const staffDecisionsIdx = actions.indexOf("export async function getProjectDecisions(");
const staffDecisionsSlice = actions.slice(staffDecisionsIdx, staffDecisionsIdx + 1500);
assert.match(staffDecisionsSlice, /attachOrderRisk\(/, "getProjectDecisions (staff) must attach computed risk");
assert.ok(
    (staffDecisionsSlice.match(/loadScheduleTaskStartDates\(/g) || []).length === 1,
    "the staff loader must call loadScheduleTaskStartDates exactly ONCE — risk must reuse the existing batched lookup, not add a second query",
);

// ── selection-order-risk.ts: pure module, no prisma/server-only imports ────

assert.ok(!/from ".\/prisma"/.test(orderRisk), "selection-order-risk.ts must not import prisma — pure module");
assert.ok(!/^import\s+"server-only"/m.test(orderRisk), "selection-order-risk.ts must not import the server-only package");

// ── assessDeliveryRisk: boundary cases (late/tight/null) + UTC midnight
//    normalization (payment-reminders.ts's calendar-day convention) ────────

function verifyLateBoundaryArrivalOnReference(): void {
    const reference = new Date("2026-09-01T00:00:00.000Z");
    const risk = assessDeliveryRisk({
        status: "Ordered",
        expectedArrivalAt: reference,
        linkedTaskStartAt: reference,
        effectiveDueDate: null,
    });
    assert.equal(risk.level, "late", "arrival == reference must be late");
    assert.equal(risk.daysLate, 0);
}

function verifyTightBoundaryArrivalThreeDaysBeforeReference(): void {
    const reference = new Date("2026-09-01T00:00:00.000Z");
    const arrival = new Date("2026-08-29T00:00:00.000Z"); // reference - 3
    const risk = assessDeliveryRisk({
        status: "Ordered",
        expectedArrivalAt: arrival,
        linkedTaskStartAt: reference,
        effectiveDueDate: null,
    });
    assert.equal(risk.level, "tight", "arrival == reference - 3 must be tight");
    assert.equal(risk.daysLate, -3);
}

function verifyNoRiskBoundaryArrivalFourDaysBeforeReference(): void {
    const reference = new Date("2026-09-01T00:00:00.000Z");
    const arrival = new Date("2026-08-28T00:00:00.000Z"); // reference - 4
    const risk = assessDeliveryRisk({
        status: "Ordered",
        expectedArrivalAt: arrival,
        linkedTaskStartAt: reference,
        effectiveDueDate: null,
    });
    assert.equal(risk.level, null, "arrival == reference - 4 must show no risk");
}

function verifyLateArrivalTwoDaysAfterReference(): void {
    const reference = new Date("2026-09-01T00:00:00.000Z");
    const arrival = new Date("2026-09-03T00:00:00.000Z"); // reference + 2
    const risk = assessDeliveryRisk({
        status: "Ordered",
        expectedArrivalAt: arrival,
        linkedTaskStartAt: reference,
        effectiveDueDate: null,
    });
    assert.equal(risk.level, "late");
    assert.equal(risk.daysLate, 2);
}

function verifyUtcMidnightNormalizationIgnoresTimeOfDay(): void {
    // Reference at 23:00 UTC, arrival at 01:00 UTC the SAME calendar day one
    // day later — a naive millisecond diff would read < 24h and round down;
    // the UTC-midnight day-diff must still read exactly 1 day.
    const reference = new Date("2026-09-01T23:00:00.000Z");
    const arrival = new Date("2026-09-02T01:00:00.000Z");
    const risk = assessDeliveryRisk({
        status: "Ordered",
        expectedArrivalAt: arrival,
        linkedTaskStartAt: reference,
        effectiveDueDate: null,
    });
    assert.equal(risk.level, "late");
    assert.equal(risk.daysLate, 1, "day-diff must be calendar-day-based (UTC midnight), not a raw <24h millisecond comparison");
}

function verifyReceivedNeverShowsRisk(): void {
    const risk = assessDeliveryRisk({
        status: "Received",
        expectedArrivalAt: new Date("2026-09-10T00:00:00.000Z"),
        linkedTaskStartAt: new Date("2026-09-01T00:00:00.000Z"),
        effectiveDueDate: null,
    });
    assert.equal(risk.level, null, "Received decisions must never show risk, however late the arrival was");
}

function verifyUnlinkedFallsBackToEffectiveDueDate(): void {
    const effectiveDueDate = new Date("2026-09-01T00:00:00.000Z");
    const arrival = new Date("2026-09-05T00:00:00.000Z");
    const risk = assessDeliveryRisk({
        status: "Ordered",
        expectedArrivalAt: arrival,
        linkedTaskStartAt: null, // not linked
        effectiveDueDate,
    });
    assert.equal(risk.level, "late", "an unlinked decision must fall back to effectiveDueDate as the reference");
    assert.equal(risk.referenceDate?.toISOString(), effectiveDueDate.toISOString());
}

function verifyNoDatesYieldsNoRisk(): void {
    assert.equal(assessDeliveryRisk({ status: "Ordered", expectedArrivalAt: null, linkedTaskStartAt: null, effectiveDueDate: null }).level, null);
    assert.equal(
        assessDeliveryRisk({ status: "Ordered", expectedArrivalAt: new Date(), linkedTaskStartAt: null, effectiveDueDate: null }).level,
        null,
        "no reference date at all (unlinked, no due date) must show no risk",
    );
}

verifyLateBoundaryArrivalOnReference();
verifyTightBoundaryArrivalThreeDaysBeforeReference();
verifyNoRiskBoundaryArrivalFourDaysBeforeReference();
verifyLateArrivalTwoDaysAfterReference();
verifyUtcMidnightNormalizationIgnoresTimeOfDay();
verifyReceivedNeverShowsRisk();
verifyUnlinkedFallsBackToEffectiveDueDate();
verifyNoDatesYieldsNoRisk();

// ── Company-day contract: after-5pm-Pacific boundary (the whole reason
//    companyTodayAsUtcMidnight exists instead of a bare UTC new Date()) ────

function verifyAfterFivePmPacificResolvesToThePacificCalendarDay(): void {
    // 2026-08-01T00:30:00Z is 2026-07-31 17:30 PDT (UTC-7) — 5:30pm Pacific.
    // The UTC calendar day has already rolled to Aug 1; company-local it's
    // still July 31.
    const fivePmPacific = new Date("2026-08-01T00:30:00.000Z");
    const companyToday = companyTodayAsUtcMidnight(fivePmPacific);
    assert.equal(
        companyToday.toISOString().slice(0, 10),
        "2026-07-31",
        "5:30pm Pacific must resolve to the Pacific calendar day (Jul 31), not the already-rolled-over UTC day (Aug 1)",
    );
}
verifyAfterFivePmPacificResolvesToThePacificCalendarDay();

console.log("selection order tracking + delivery risk contract verified");
