// Verifier for Selection Order Tracking + Delivery Risk
// (docs/superpowers/plans/2026-07-31-selection-order-tracking.md). Mirrors
// scripts/verify-selection-templates.ts's structure: static regex
// assertions against source files, plus dynamic behavior checks against the
// real (pure/plain-module) exports.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assessDeliveryRisk, formatDeliveryRiskWording } from "../src/lib/selection-order-risk";
import { companyTodayAsUtcMidnight } from "../src/lib/decision-due-date";

const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

const schema = read("prisma/schema.prisma");
const applyScript = read("scripts/apply-selection-order-tracking.mjs");
const orderActionsCore = read("src/lib/decision-order-actions-core.ts");
const orderRisk = read("src/lib/selection-order-risk.ts");
const actions = read("src/lib/actions.ts");
const orderPopover = read("src/app/projects/[id]/selections/DecisionOrderPopover.tsx");

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
//    appear BEFORE the decision lookup CALL SITE in source order (not
//    wherever defaultFind's own body happens to be defined — Codex review
//    round 1, nit c moved the lookup behind an injectable `find` dep). ─────

const actorIdx = orderActionsCore.indexOf("const actor = await (deps.getActor ?? defaultGetActor)();");
const lookupIdx = orderActionsCore.indexOf("const decision = await (deps.find ?? defaultFind)(decisionId);");
assert.ok(actorIdx > -1, "setDecisionOrderInfo must resolve the actor via deps.getActor / defaultGetActor");
assert.ok(lookupIdx > -1, "setDecisionOrderInfo must look up the decision via deps.find / defaultFind");
assert.ok(actorIdx < lookupIdx, "actor resolution must run BEFORE the decision lookup (no existence oracle for unauthenticated callers)");
assert.match(orderActionsCore, /if \(!actor\) throw new Error\("Forbidden"\);/, "an unauthenticated caller must be rejected with Forbidden before any lookup");
assert.match(orderActionsCore, /canAccessProject/, "setDecisionOrderInfo must gate on canAccessProject (any project staff, not ADMIN/MANAGER-only)");
assert.ok(!/isAdminOrManager/.test(orderActionsCore), "setDecisionOrderInfo must NOT be ADMIN/MANAGER-gated — any project staff, same bar as linkDecisionToSchedule");

// ── Plan drift (Codex review round 1, nit c): the seam must inject
//    find/write, not just actor/revalidate — setDecisionOrderInfo's body
//    must call through the injectable seam, never prisma directly. ─────────

assert.match(orderActionsCore, /find\?:\s*\(decisionId: string\) => Promise<FindDecisionResult>/, "OrderActionDependencies must declare an injectable find");
assert.match(orderActionsCore, /write\?:\s*\(args: UpdateManyArgs\) => Promise<UpdateManyResult>/, "OrderActionDependencies must declare an injectable write");
assert.match(orderActionsCore, /const write = deps\.write \?\? defaultWrite;/, "setDecisionOrderInfo must resolve its write function through the injectable seam");
const setDecisionOrderInfoIdx = orderActionsCore.indexOf("export async function setDecisionOrderInfo(");
const setDecisionOrderInfoBody = orderActionsCore.slice(setDecisionOrderInfoIdx);
assert.ok(!/prisma\.decision\./.test(setDecisionOrderInfoBody), "setDecisionOrderInfo's own body must never call prisma.decision directly — only through deps.find/deps.write (defaultFind/defaultWrite are the only direct callers, and they live outside this function)");

// ── CAS transition matrix: Decided/Ordered -> Ordered, Ordered -> Received,
//    Ordered/Received -> clear -> Decided. Each must be a single CAS write
//    keyed on both id AND the allowed source status/statuses. The "ordered"
//    branch ALSO carries a field-level CAS on ALL THREE order fields
//    (Codex review round 1, issue 3; round 2, R3 residual — orderedAt alone
//    let two forms seeded from the SAME order date last-write-win on
//    orderedBy/expectedArrivalAt) so a stale form can't clobber a
//    concurrent change to any of the three. ─────────────────────────────────

assert.match(
    orderActionsCore,
    /where:\s*\{\s*id:\s*decisionId,\s*deletedAt:\s*null,\s*status:\s*\{\s*in:\s*\["Decided",\s*"Ordered"\]\s*\},\s*orderedAt:\s*expectedOrderedAt,\s*orderedBy:\s*expectedOrderedBy,\s*expectedArrivalAt:\s*expectedExpectedArrivalAt,?\s*\}/,
    "marking ordered must CAS from status in [Decided, Ordered] AND match ALL THREE client-seeded fields (expectedOrderedAt, expectedOrderedBy, expectedExpectedArrivalAt) — the full field-level CAS",
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

// ── Exhaustive kind switch (Codex review round 1, issue 6): a malformed
//    kind must NOT silently fall through to the clear branch. ─────────────

assert.match(orderActionsCore, /switch \(input\.kind\) \{/, "setDecisionOrderInfo must switch explicitly on input.kind");
assert.match(orderActionsCore, /case "ordered":/, "must have an explicit case for \"ordered\"");
assert.match(orderActionsCore, /case "received":/, "must have an explicit case for \"received\"");
assert.match(orderActionsCore, /case "clear":/, "must have an explicit case for \"clear\"");
assert.match(orderActionsCore, /default:\s*\{[\s\S]*?const _exhaustive: never = input;/, "the default branch must be a compile-time-checked exhaustiveness guard, not a silent fallthrough");

// ── Typed results (Codex review round 1, issue 1): expected validation/CAS
//    failures RETURN { ok: false, code, message } instead of throwing — a
//    thrown Server Action error message is redacted in production builds,
//    which would degrade the popover's specific feedback to a generic
//    string. Only auth ("Forbidden"/"Decision not found") still throws. ───

assert.match(orderActionsCore, /export type DecisionOrderResult =\s*\|\s*\{\s*ok:\s*true\s*\}\s*\|\s*\{\s*ok:\s*false;\s*code:\s*DecisionOrderErrorCode;\s*message:\s*string\s*\}/, "DecisionOrderResult must be a discriminated { ok: true } | { ok: false, code, message } union");
assert.ok(!/throw new Error\("Order date/.test(orderActionsCore), "date/CAS validation must never throw — it must return a typed result");
const okFalseCount = (orderActionsCore.match(/\{ ok: false, code:/g) || []).length;
assert.ok(okFalseCount >= 6, `expected at least 6 typed failure returns (orderedBy, 2x date-sanity, future-date, eta-before-order, 3x CAS conflict, unknown kind) — found ${okFalseCount}`);
assert.match(orderActionsCore, /throw new Error\("Forbidden"\);/, "auth failures (no actor / no project access) must still throw");
assert.match(orderActionsCore, /throw new Error\("Decision not found"\);/, "a nonexistent decision must still throw (not an actionable retry case)");

// ── Server-side UTC-midnight normalization (Codex review round 1, issue 7):
//    the core must normalize orderedAt/expectedArrivalAt itself — never
//    trust the caller. ──────────────────────────────────────────────────────

assert.match(orderActionsCore, /const orderedAt = utcMidnight\(input\.orderedAt\);/, "orderedAt must be normalized to UTC midnight server-side");
assert.match(orderActionsCore, /const expectedArrivalAt = input\.expectedArrivalAt \? utcMidnight\(input\.expectedArrivalAt\) : null;/, "expectedArrivalAt must be normalized to UTC midnight server-side");
assert.match(orderActionsCore, /const expectedOrderedAt = input\.expectedOrderedAt \? utcMidnight\(input\.expectedOrderedAt\) : null;/, "expectedOrderedAt must be normalized to UTC midnight server-side too (it's compared against the stored, normalized orderedAt)");
assert.match(orderActionsCore, /const expectedOrderedBy = input\.expectedOrderedBy \?\? null;/, "expectedOrderedBy must be resolved server-side (round 2, R3 residual)");
assert.match(orderActionsCore, /const expectedExpectedArrivalAt = input\.expectedExpectedArrivalAt \? utcMidnight\(input\.expectedExpectedArrivalAt\) : null;/, "expectedExpectedArrivalAt must be normalized to UTC midnight server-side too (round 2, R3 residual)");
assert.match(orderActionsCore, /expectedArrivalAt\.getTime\(\) < orderedAt\.getTime\(\)/, "expectedArrivalAt must be validated >= orderedAt using the NORMALIZED local values, not the raw input");

// ── +5y sanity bound must be an exact company-today + 5 years, not a
//    year-end anchor (Codex review round 1, issue 8) ────────────────────────

assert.match(orderActionsCore, /2020-01-01/, "sanity bound must start at 2020-01-01");
assert.match(
    orderActionsCore,
    /function sanityMaxDate\(today: Date\): Date \{\s*return new Date\(Date\.UTC\(today\.getUTCFullYear\(\) \+ 5, today\.getUTCMonth\(\), today\.getUTCDate\(\)/,
    "sanityMaxDate must compute an EXACT +5 years from today (year/month/day), not Dec 31 of (year+5)",
);
assert.ok(!/Date\.UTC\(now\.getUTCFullYear\(\) \+ 5, 11, 31/.test(orderActionsCore), "the old year-end (month 11, day 31) +5y anchor must be gone");

// ── setDecisionOrderInfo is the ONLY writer of these three columns ─────────

assert.match(actions, /setDecisionOrderInfoCore/, "actions.ts must have a thin setDecisionOrderInfo wrapper over the core seam");
// actions.ts's existing chooseItem/unchooseItem paths only ever READ
// decision.status === "Ordered" (as a terminal-state guard) — they must
// never WRITE status: "Ordered". decision-order-actions-core.ts is asserted
// above to be the sole CAS writer of that transition.
assert.ok(!/data:\s*\{[^}]*status:\s*"Ordered"/.test(actions), "actions.ts must not contain a second writer of status: \"Ordered\" outside the core seam");

// ── deleteDecision BLOCKER fix (Codex review round 1): the terminal-status
//    guard must be a CAS INSIDE the transaction (status NOT IN
//    [Ordered,Received], re-evaluated atomically at write time), not a
//    pre-transaction read-then-check that a concurrent order could race
//    past. The reset must also null the three order fields explicitly as
//    defense-in-depth. restoreDecision must leave no stranded fields. ─────

const deleteDecisionIdx = actions.indexOf("export async function deleteDecision(");
assert.ok(deleteDecisionIdx > -1, "actions.ts must export deleteDecision");
const deleteDecisionSlice = actions.slice(deleteDecisionIdx, deleteDecisionIdx + 4000);
assert.match(
    deleteDecisionSlice,
    /status:\s*\{\s*notIn:\s*\["Ordered",\s*"Received"\]\s*\}/,
    "deleteDecision's terminal-status guard must be a CAS (status NOT IN [Ordered,Received]) evaluated inside the transaction's write, not a pre-transaction read-then-check",
);
assert.match(
    deleteDecisionSlice,
    /orderedAt:\s*null,\s*orderedBy:\s*null,\s*expectedArrivalAt:\s*null/,
    "deleteDecision's soft-delete reset must explicitly null the three order fields (defense-in-depth)",
);
assert.match(deleteDecisionSlice, /await prisma\.\$transaction\(async \(tx\) => \{/, "the CAS + chosenItem/candidate reset must run inside one transaction");
assert.match(deleteDecisionSlice, /claim\.count === 0/, "the delete must check the CAS write's count, not a value read before the transaction");
// The OLD pattern — a plain status check BEFORE the transaction that then
// unconditionally writes — must be gone.
assert.ok(
    !/if \(decision\.status === "Ordered" \|\| decision\.status === "Received"\) \{\s*throw new Error\("This decision has already been ordered/.test(deleteDecisionSlice),
    "the pre-transaction TOCTOU guard must be removed — the CAS write is now the only guard",
);

const restoreDecisionIdx = actions.indexOf("export async function restoreDecision(");
assert.ok(restoreDecisionIdx > -1, "actions.ts must export restoreDecision");
const restoreDecisionSlice = actions.slice(restoreDecisionIdx, restoreDecisionIdx + 1200);
assert.match(
    restoreDecisionSlice,
    /orderedAt:\s*null,\s*orderedBy:\s*null,\s*expectedArrivalAt:\s*null/,
    "restoreDecision must also null the three order fields (defense-in-depth — a restored decision must never surface stranded order info)",
);

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

// ── formatDeliveryRiskWording: zero-day special case (Codex review round 1,
//    issue 5) — "arrives 0 day(s) after <date>" reads as nonsense; the
//    boundary case is "arrives the day <date> starts". ─────────────────────

function verifyZeroDayWordingIsSpecialCased(): void {
    const reference = new Date("2026-09-01T00:00:00.000Z");
    const wording = formatDeliveryRiskWording({ level: "late", referenceDate: reference, daysLate: 0 });
    assert.equal(wording, "arrives the day Sep 1 starts", "daysLate === 0 must NOT read '0 days after'");
}

function verifyNonZeroLateWording(): void {
    const reference = new Date("2026-09-01T00:00:00.000Z");
    const wording = formatDeliveryRiskWording({ level: "late", referenceDate: reference, daysLate: 2 });
    assert.equal(wording, "arrives 2 days after Sep 1");
}

function verifyTightWording(): void {
    const reference = new Date("2026-09-01T00:00:00.000Z");
    const wording = formatDeliveryRiskWording({ level: "tight", referenceDate: reference, daysLate: -2 });
    assert.equal(wording, "arrives 2 days before Sep 1");
}

function verifySingularDayWording(): void {
    const reference = new Date("2026-09-01T00:00:00.000Z");
    assert.equal(formatDeliveryRiskWording({ level: "late", referenceDate: reference, daysLate: 1 }), "arrives 1 day after Sep 1");
    assert.equal(formatDeliveryRiskWording({ level: "tight", referenceDate: reference, daysLate: -1 }), "arrives 1 day before Sep 1");
}

function verifyNullLevelWordingIsEmpty(): void {
    assert.equal(formatDeliveryRiskWording({ level: null, referenceDate: null, daysLate: null }), "");
}

verifyZeroDayWordingIsSpecialCased();
verifyNonZeroLateWording();
verifyTightWording();
verifySingularDayWording();
verifyNullLevelWordingIsEmpty();

// The UI must call the shared formatter, not a locally duplicated wording
// builder (Codex review round 1, issue 5).
const teamDecisionsSection = read("src/app/projects/[id]/selections/TeamDecisionsSection.tsx");
assert.match(teamDecisionsSection, /formatDeliveryRiskWording/, "TeamDecisionsSection must use the shared formatDeliveryRiskWording, not a local duplicate");
assert.ok(!/function riskWording/.test(teamDecisionsSection), "the old locally-duplicated riskWording must be gone");

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

// ── Popover UI: Received is read-only + Clear-only (issue 2), a single
//    pending flag disables Save AND Clear together (issue 3), and both date
//    inputs carry a real label/id pair (nit b) ──────────────────────────────

assert.match(orderPopover, /const isReceived = status === "Received";/, "the popover must branch on Received to render read-only history");
const receivedBranchIdx = orderPopover.indexOf("{isReceived ? (");
const receivedBranchSlice = orderPopover.slice(receivedBranchIdx, receivedBranchIdx + 600);
assert.match(receivedBranchSlice, /order-history-/, "Received state must render the read-only order-history line");
assert.ok(!/order-date-input/.test(receivedBranchSlice), "Received state must NOT render the editable order-date input");
assert.ok(!/order-save-/.test(receivedBranchSlice), "Received state must NOT render a Save button that could send kind \"ordered\"");

assert.match(orderPopover, /const \[pending, setPending\] = useState<"save" \| "receive" \| "clear" \| null>\(null\);/, "Save/Receive/Clear must share ONE pending flag");
assert.match(orderPopover, /disabled=\{pending !== null\}/, "action buttons must disable on the shared pending flag");
assert.ok(!/\[saving, setSaving\]/.test(orderPopover), "the old separate `saving` state must be gone");
assert.ok(!/\[busyAction, setBusyAction\]/.test(orderPopover), "the old separate `busyAction` state must be gone");

assert.match(orderPopover, /htmlFor=\{orderDateInputId\}/, "the order-date label must be paired to its input via htmlFor/id (nit b)");
assert.match(orderPopover, /id=\{orderDateInputId\}/, "the order-date input must carry the matching id");
assert.match(orderPopover, /htmlFor=\{orderEtaInputId\}/, "the ETA label must be paired to its input via htmlFor/id (nit b)");
assert.match(orderPopover, /id=\{orderEtaInputId\}/, "the ETA input must carry the matching id");

assert.match(orderPopover, /expectedOrderedAt:/, "the popover must send expectedOrderedAt (field-level CAS) on every \"ordered\" call");
assert.match(orderPopover, /expectedOrderedBy:/, "the popover must send expectedOrderedBy too (round 2, R3 residual — full 3-field CAS)");
assert.match(orderPopover, /expectedExpectedArrivalAt:/, "the popover must send expectedExpectedArrivalAt too (round 2, R3 residual — full 3-field CAS)");
assert.match(orderPopover, /if \(!result\.ok\) \{/, "the popover must branch on the typed result, not rely solely on a catch block, for expected failures");

console.log("selection order tracking + delivery risk contract verified");
