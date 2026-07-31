// Verifier for Decision Templates + Schedule-Driven Due Dates
// (docs/superpowers/plans/2026-07-31-selection-templates-due-dates.md).
// Mirrors scripts/verify-selection-ai-sort.ts's structure: static regex
// assertions against source files, plus dynamic behavior checks against the
// real (pure/plain-module) exports.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
    validateTemplateItems,
    validateTemplateName,
    buildTemplateKey,
    normalizeForDedupe,
    DecisionTemplateValidationError,
    MAX_ITEMS,
    ITEM_NAME_MAX,
    LEAD_TIME_MIN,
    LEAD_TIME_MAX,
} from "../src/lib/decision-template-core";
import { computeEffectiveDueDate, dueDateUrgency } from "../src/lib/decision-due-date";
import {
    suggestScheduleLinksForDecisions,
    DecisionLinkUnavailableError,
    type DecisionLinkDecisionInput,
    type DecisionLinkTaskInput,
} from "../src/lib/decision-schedule-link-core";

const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

const schema = read("prisma/schema.prisma");
const applyScript = read("scripts/apply-selection-templates.mjs");
const templateCore = read("src/lib/decision-template-core.ts");
const templateCrudCore = read("src/lib/decision-template-crud-core.ts");
const templateApplyCore = read("src/lib/decision-template-apply-core.ts");
const linkCore = read("src/lib/decision-schedule-link-core.ts");
const linkDeps = read("src/lib/decision-schedule-link-dependencies.ts");
const linkActionsCore = read("src/lib/decision-link-actions-core.ts");
const aiSortCore = read("src/lib/selection-ai-sort-core.ts");
const permissions = read("src/lib/permissions.ts");
const actions = read("src/lib/actions.ts");
const proxy = read("src/proxy.ts");
const teamDecisionsSection = read("src/app/projects/[id]/selections/TeamDecisionsSection.tsx");
const portalDecisionsSection = read("src/app/portal/projects/[id]/selections/PortalDecisionsSection.tsx");
const dueDateEditPopover = read("src/app/projects/[id]/selections/DecisionDueDateEditPopover.tsx");
const templatesManager = read("src/app/templates/selections/DecisionTemplatesManager.tsx");
const applyTemplateModal = read("src/app/projects/[id]/selections/ApplyTemplateModal.tsx");

// ── Schema / migration ──────────────────────────────────────────────────────

assert.match(schema, /model DecisionTemplate \{/, "schema must declare DecisionTemplate");
assert.match(schema, /model DecisionTemplateItem \{/, "schema must declare DecisionTemplateItem");
assert.match(schema, /scheduleTaskId\s+String\?/, "Decision.scheduleTaskId must be an optional, non-FK column");
assert.match(schema, /leadTimeDays\s+Int\?/, "Decision.leadTimeDays must be optional");
assert.match(schema, /dueDate\s+DateTime\?/, "Decision.dueDate must be optional (override-only)");
assert.match(applyScript, /CREATE TABLE IF NOT EXISTS "DecisionTemplate"/, "migration must be idempotent");
assert.match(applyScript, /CREATE TABLE IF NOT EXISTS "DecisionTemplateItem"/, "migration must be idempotent");
assert.match(applyScript, /ALTER TABLE "Decision" ADD COLUMN IF NOT EXISTS "scheduleTaskId"/, "migration must add scheduleTaskId idempotently");
assert.match(applyScript, /ALTER TABLE "Decision" ADD COLUMN IF NOT EXISTS "leadTimeDays"/, "migration must add leadTimeDays idempotently");
assert.match(applyScript, /ALTER TABLE "Decision" ADD COLUMN IF NOT EXISTS "dueDate"/, "migration must add dueDate idempotently");
assert.match(applyScript, /ALTER TABLE "DecisionTemplate" ENABLE ROW LEVEL SECURITY/, "DecisionTemplate must have RLS enabled");
assert.match(applyScript, /ALTER TABLE "DecisionTemplateItem" ENABLE ROW LEVEL SECURITY/, "DecisionTemplateItem must have RLS enabled");
// No policies should be granted on either new table — server-only convention.
assert.ok(!/CREATE POLICY[\s\S]*"DecisionTemplate/i.test(applyScript), "DecisionTemplate must have NO policies (server-only table)");

// ── Authorization split: CRUD is ADMIN/MANAGER, apply is any project staff ──

assert.match(permissions, /export function isAdminOrManager/, "permissions.ts must export isAdminOrManager");
assert.match(templateCrudCore, /isAdminOrManager/, "template CRUD must gate on isAdminOrManager");
assert.match(templateCrudCore, /requireAdminOrManager/, "template CRUD must have an admin/manager requirement helper");
assert.match(templateApplyCore, /canAccessProject/, "applyDecisionTemplate must gate on canAccessProject");
assert.ok(!/isAdminOrManager/.test(templateApplyCore), "applyDecisionTemplate must NOT be gated by isAdminOrManager (any staff, not admin-only)");

// ── Apply races + non-atomicity (Codex review round 1, issues 1, 3, 4) ─────
assert.match(templateApplyCore, /archivedAt:\s*null/, "applyDecisionTemplate must reject archived templates");
assert.match(templateApplyCore, /\$transaction/, "applyDecisionTemplate must run inside one interactive transaction");
assert.match(templateApplyCore, /pg_advisory_xact_lock/, "applyDecisionTemplate must take a project-scoped advisory lock inside the transaction");
assert.match(templateApplyCore, /\$executeRaw/, "the advisory lock must be taken with $executeRaw (pg_advisory_xact_lock returns void, which $queryRaw cannot deserialize)");
assert.match(linkActionsCore, /canAccessProject/, "linkDecisionToSchedule must gate on canAccessProject");
assert.match(linkActionsCore, /isAdminOrManager/, "setDecisionDueDateOverride must gate on isAdminOrManager");

// ── Per-item templateKey + validation caps ──────────────────────────────────

assert.equal(buildTemplateKey("tmpl1", "item1"), "decision-template:tmpl1:item1", "templateKey must be per-item, not per-template");
assert.equal(MAX_ITEMS, 40);
assert.equal(ITEM_NAME_MAX, 120);
assert.equal(LEAD_TIME_MIN, 0);
assert.equal(LEAD_TIME_MAX, 365);

function verifyValidationCaps(): void {
    assert.throws(() => validateTemplateName(""), DecisionTemplateValidationError);
    assert.throws(() => validateTemplateName("x".repeat(121)), DecisionTemplateValidationError);
    assert.throws(
        () => validateTemplateItems(Array.from({ length: 41 }, (_, i) => ({ name: `Item ${i}` }))),
        DecisionTemplateValidationError,
        "must reject more than 40 items",
    );
    assert.throws(
        () => validateTemplateItems([{ name: "x".repeat(121) }]),
        DecisionTemplateValidationError,
        "must reject item name over 120 chars",
    );
    assert.throws(
        () => validateTemplateItems([{ name: "Cabinets", defaultLeadTimeDays: 400 }]),
        DecisionTemplateValidationError,
        "must reject leadTimeDays over 365",
    );
    assert.throws(
        () => validateTemplateItems([{ name: "Cabinets", defaultLeadTimeDays: -1 }]),
        DecisionTemplateValidationError,
        "must reject negative leadTimeDays",
    );
    const items = validateTemplateItems([{ name: "Cabinets", defaultLeadTimeDays: 0 }]);
    assert.equal(items[0].defaultLeadTimeDays, 0, "0 is a valid leadTimeDays, must not be treated as falsy/absent");
}
verifyValidationCaps();

// ── effectiveDueDate compute-on-read + override semantics ──────────────────

function verifyOverrideAlwaysWinsEvenWhenDangling(): void {
    const override = new Date("2026-05-01T00:00:00.000Z");
    const effective = computeEffectiveDueDate(
        { dueDate: override, scheduleTaskId: "dangling-task", leadTimeDays: 5 },
        new Map(), // task not present — dangling
    );
    assert.equal(effective?.toISOString(), override.toISOString(), "manual override must win even when the linked task is dangling");
}

function verifyDerivationSubtractsLeadTimeInUtc(): void {
    const startDate = new Date("2026-09-01T00:00:00.000Z");
    const effective = computeEffectiveDueDate(
        { dueDate: null, scheduleTaskId: "task-1", leadTimeDays: 14 },
        new Map([["task-1", startDate]]),
    );
    assert.equal(effective?.toISOString().slice(0, 10), "2026-08-18");
}

function verifyNoLinkOrDanglingYieldsNullNeverError(): void {
    assert.equal(computeEffectiveDueDate({ dueDate: null, scheduleTaskId: null, leadTimeDays: null }, new Map()), null);
    assert.equal(computeEffectiveDueDate({ dueDate: null, scheduleTaskId: "gone", leadTimeDays: 5 }, new Map()), null);
}

function verifyUrgencyThresholds(): void {
    const now = new Date("2026-01-15T00:00:00.000Z");
    assert.equal(dueDateUrgency(null, now), null);
    const overdue = dueDateUrgency(new Date("2026-01-10T00:00:00.000Z"), now);
    assert.ok(overdue && /overdue/.test(overdue.label) && /red/.test(overdue.className));
    const dueSoon = dueDateUrgency(new Date("2026-01-20T00:00:00.000Z"), now);
    assert.ok(dueSoon && /amber/.test(dueSoon.className));
    const farOut = dueDateUrgency(new Date("2026-03-01T00:00:00.000Z"), now);
    assert.equal(farOut, null, "more than 7 days out must show no urgency chip");
}

verifyOverrideAlwaysWinsEvenWhenDangling();
verifyDerivationSubtractsLeadTimeInUtc();
verifyNoLinkOrDanglingYieldsNullNeverError();
verifyUrgencyThresholds();

// ── Schedule-link AI seam: escapeFenceClosers reuse, mock guard reuse,
//    strict cardinality on decisionId, unknown scheduleTaskId dropped ──────

assert.match(aiSortCore, /export function escapeFenceClosers/, "escapeFenceClosers must be exported from selection-ai-sort-core for reuse");
assert.match(linkCore, /import\s*\{\s*escapeFenceClosers\s*\}\s*from\s*"\.\/selection-ai-sort-core"/, "decision-schedule-link-core must REUSE escapeFenceClosers, not duplicate it");
assert.ok(!/function escapeFenceClosers/.test(linkCore), "decision-schedule-link-core must not redefine escapeFenceClosers");
assert.match(linkDeps, /isSelectionAiMockEnabled/, "decision-schedule-link-dependencies must reuse the AI Auto-Sort mock guard, not duplicate it");
assert.match(proxy, /selections\\?\/\(\?:item-comments\|ai-sort\|link-schedule\)/, "proxy bypass regex must include link-schedule");
assert.match(proxy, /api\/selections\/link-schedule/, "proxy matcher must exclude api/selections/link-schedule");

const linkDecisions: DecisionLinkDecisionInput[] = [
    { id: "d1", name: "Cabinets", area: null },
    { id: "d2", name: "Countertops", area: null },
];
const linkTasks: DecisionLinkTaskInput[] = [
    { id: "t1", name: "Cabinet Install", startDate: "2026-09-01T00:00:00.000Z", endDate: "2026-09-05T00:00:00.000Z", parentId: null, type: "task" },
];

async function verifyDuplicateDecisionIdInvalidatesBatchRetriesOnceThenFails(): Promise<void> {
    let calls = 0;
    await assert.rejects(
        suggestScheduleLinksForDecisions(
            { decisions: linkDecisions, tasks: linkTasks },
            {
                complete: async () => {
                    calls++;
                    return JSON.stringify({
                        suggestions: [
                            { decisionId: "d1", scheduleTaskId: "t1", leadTimeDays: 5, confidence: "high", reason: "x" },
                            { decisionId: "d1", scheduleTaskId: null, leadTimeDays: 0, confidence: "low", reason: "dup" },
                        ],
                    });
                },
            },
        ),
        DecisionLinkUnavailableError,
    );
    assert.equal(calls, 2, "must retry exactly once on a duplicate decisionId before failing the batch");
}

async function verifyExtraUnknownDecisionIdInvalidatesBatchEvenWhenAllValidIdsArePresent(): Promise<void> {
    // Codex review round 1, nit b: BOTH real decisions present, PLUS one
    // bogus extra decisionId — cardinality (length) alone would match
    // (2 valid + the bogus one dropped = 2 == batch.length) if the bogus id
    // were silently dropped instead of invalidating the batch. Must still
    // fail, not silently pass with the 2 real suggestions.
    let calls = 0;
    await assert.rejects(
        suggestScheduleLinksForDecisions(
            { decisions: linkDecisions, tasks: linkTasks },
            {
                complete: async () => {
                    calls++;
                    return JSON.stringify({
                        suggestions: [
                            { decisionId: "d1", scheduleTaskId: "t1", leadTimeDays: 5, confidence: "high", reason: "x" },
                            { decisionId: "d2", scheduleTaskId: null, leadTimeDays: 0, confidence: "low", reason: "y" },
                            { decisionId: "not-a-real-decision", scheduleTaskId: null, leadTimeDays: 0, confidence: "low", reason: "bogus" },
                        ],
                    });
                },
            },
        ),
        DecisionLinkUnavailableError,
    );
    assert.equal(calls, 2, "must retry exactly once on an unrecognized decisionId before failing the batch");
}

async function verifyUnknownScheduleTaskIdIsDroppedNotBatchInvalidating(): Promise<void> {
    const { suggestions, failedDecisionIds } = await suggestScheduleLinksForDecisions(
        { decisions: linkDecisions, tasks: linkTasks },
        {
            complete: async () =>
                JSON.stringify({
                    suggestions: [
                        { decisionId: "d1", scheduleTaskId: "not-a-real-task", leadTimeDays: 900, confidence: "high", reason: "x" },
                        { decisionId: "d2", scheduleTaskId: "t1", leadTimeDays: 5, confidence: "medium", reason: "y" },
                    ],
                }),
        },
    );
    assert.equal(failedDecisionIds.length, 0, "an unknown scheduleTaskId must not invalidate the batch");
    const d1 = suggestions.find((s) => s.decisionId === "d1");
    assert.equal(d1?.scheduleTaskId, null, "an unrecognized scheduleTaskId must be dropped to null");
    assert.equal(d1?.leadTimeDays, 0, "leadTimeDays must reset to 0 when scheduleTaskId is dropped to null");
    const d2 = suggestions.find((s) => s.decisionId === "d2");
    assert.equal(d2?.scheduleTaskId, "t1");
}

async function verifyLeadTimeDaysIsClampedNotRejected(): Promise<void> {
    const { suggestions } = await suggestScheduleLinksForDecisions(
        { decisions: [linkDecisions[0]], tasks: linkTasks },
        {
            complete: async () =>
                JSON.stringify({
                    suggestions: [{ decisionId: "d1", scheduleTaskId: "t1", leadTimeDays: 9999, confidence: "high", reason: "x" }],
                }),
        },
    );
    assert.equal(suggestions[0].leadTimeDays, 365, "leadTimeDays must clamp to 365, not reject the suggestion");
}

async function verifyEmptyDecisionsShortCircuits(): Promise<void> {
    const result = await suggestScheduleLinksForDecisions(
        { decisions: [], tasks: linkTasks },
        { complete: async () => { throw new Error("must not be called"); } },
    );
    assert.deepEqual(result, { suggestions: [], failedDecisionIds: [] });
}

// ── linkDecisionToSchedule CAS contract: never touches dueDate ─────────────

assert.match(linkActionsCore, /data:\s*\{\s*scheduleTaskId,\s*leadTimeDays\s*\}/, "linkDecisionToSchedule must write ONLY scheduleTaskId/leadTimeDays — never dueDate");
assert.match(linkActionsCore, /data:\s*\{\s*dueDate\s*\}/, "setDecisionDueDateOverride must write ONLY dueDate");

// ── Portal payload stripping: negative assertion covers all three raw
//    field names (dueDate, scheduleTaskId, leadTimeDays) ────────────────────

assert.match(actions, /function stripDueDateFields</, "actions.ts must define stripDueDateFields");
const portalDecisionsIdx = actions.indexOf("export async function getProjectDecisionsForPortal(");
const portalDecisionsSlice = actions.slice(portalDecisionsIdx, portalDecisionsIdx + 1500);
assert.match(portalDecisionsSlice, /stripDueDateFields\(/, "getProjectDecisionsForPortal must strip raw due-date/link fields");
const stripDueDateFieldsIdx = actions.indexOf("function stripDueDateFields<");
const stripDueDateFieldsSlice = actions.slice(stripDueDateFieldsIdx, stripDueDateFieldsIdx + 400);
assert.match(stripDueDateFieldsSlice, /dueDate/);
assert.match(stripDueDateFieldsSlice, /scheduleTaskId/);
assert.match(stripDueDateFieldsSlice, /leadTimeDays/);

// ── Due-date display: undecided-only gating, ADMIN/MANAGER-only override
//    input, portal read-only (no write actions imported) ───────────────────

assert.match(teamDecisionsSection, /function DecideByBadge/, "staff selections page must render a Decide-by badge");
const decideByBadgeIdx = teamDecisionsSection.indexOf("function DecideByBadge");
const decideByBadgeSlice = teamDecisionsSection.slice(decideByBadgeIdx, decideByBadgeIdx + 400);
assert.match(decideByBadgeSlice, /status !== "Open" && status !== "Flagged"/, "Decide-by badge must gate on undecided statuses only (Open/Flagged)");

assert.match(portalDecisionsSection, /function DecideByLine/, "portal selections page must render a read-only Decide-by line");
const decideByLineIdx = portalDecisionsSection.indexOf("function DecideByLine");
const decideByLineSlice = portalDecisionsSection.slice(decideByLineIdx, decideByLineIdx + 400);
assert.match(decideByLineSlice, /status !== "Open" && status !== "Flagged"/, "portal Decide-by line must gate on undecided statuses only (Open/Flagged)");
assert.ok(
    !/linkDecisionToSchedule|setDecisionDueDateOverride/.test(portalDecisionsSection),
    "the portal component must never import/call linkDecisionToSchedule or setDecisionDueDateOverride — portal-side editing is out of scope for this phase",
);

assert.match(dueDateEditPopover, /isAdminOrManager/, "the edit popover must gate the manual override input on isAdminOrManager");
const popoverOverrideIdx = dueDateEditPopover.indexOf("Manual override");
assert.ok(popoverOverrideIdx > -1, "popover must label the override section");

// ── Codex review round 2 follow-ups ─────────────────────────────────────────

// R8: archive is reversible.
assert.match(templateCrudCore, /export async function unarchiveDecisionTemplate/, "must export unarchiveDecisionTemplate");
const unarchiveIdx = templateCrudCore.indexOf("export async function unarchiveDecisionTemplate");
const unarchiveSlice = templateCrudCore.slice(unarchiveIdx, unarchiveIdx + 500);
assert.match(unarchiveSlice, /requireAdminOrManager/, "unarchiveDecisionTemplate must be ADMIN/MANAGER-gated, same as the rest of template CRUD");
assert.match(unarchiveSlice, /archivedAt:\s*null/, "unarchiveDecisionTemplate must clear archivedAt");
assert.match(actions, /export async function unarchiveDecisionTemplate/, "actions.ts must export a thin unarchiveDecisionTemplate wrapper");
assert.match(templatesManager, /unarchive-template-/, "the manager UI must render an Unarchive control on archived rows");
assert.ok(
    !/no undo/i.test(templatesManager),
    "the archive-confirm copy must no longer claim there's no undo, now that unarchive exists",
);

// N1: shared NFKD + combining-mark-strip dedupe normalization (Turkish İ/ı,
// combining-mark accents — NFKC alone does not fold these).
function verifyDedupeNormalizationHandlesNfkdAndCombiningMarks(): void {
    // Turkish dotted capital I (U+0130) -- NFKD decomposes it to "I" plus a
    // combining dot above (U+0307), which is then stripped, folding to "i".
    const turkishDottedI = "İstanbul";
    assert.equal(normalizeForDedupe(turkishDottedI), normalizeForDedupe("istanbul"), "Turkish capital dotted I must fold to the same key as plain i");

    // "cafe with an accent" entered as a combining-mark sequence (plain "e"
    // U+0065 plus a combining acute accent U+0301) vs. the precomposed
    // character (U+00E9) -- built explicitly via escape sequences so the two
    // source strings are GUARANTEED to differ at the code-unit level (typing
    // both by hand in an editor tends to silently normalize to the same
    // form, which would make this assertion pass trivially regardless of
    // whether the fix works).
    const combining = "Cabinets caf" + "e" + "́";
    const precomposed = "Cabinets caf" + "é";
    assert.notEqual(combining, precomposed, "the two source strings must actually differ at the code-unit level for this test to mean anything");
    assert.equal(normalizeForDedupe(combining), normalizeForDedupe(precomposed), "a combining-mark accent must fold the same as its precomposed equivalent");

    assert.equal(normalizeForDedupe("  Cabinets  "), "cabinets", "must still trim and lowercase plain ASCII");
}
verifyDedupeNormalizationHandlesNfkdAndCombiningMarks();
assert.match(templateApplyCore, /normalizeForDedupe/, "applyDecisionTemplate must use the shared normalizeForDedupe helper, not a local reimplementation");
assert.ok(!/function normalizeForDedupe/.test(templateApplyCore), "normalizeForDedupe must live in decision-template-core.ts, not be redefined in apply-core");

// NEW 3: duplicate item ids in an update payload are rejected.
function verifyDuplicateItemIdInUpdatePayloadIsRejected(): void {
    assert.throws(
        () => validateTemplateItems([
            { id: "item-1", name: "Cabinets" },
            { id: "item-1", name: "Countertops" },
        ]),
        DecisionTemplateValidationError,
        "two items referencing the same existing row id must be rejected",
    );
    // Items with NO id (genuinely new rows) never collide with each other.
    const items = validateTemplateItems([{ name: "Cabinets" }, { name: "Countertops" }]);
    assert.equal(items.length, 2);
}
verifyDuplicateItemIdInUpdatePayloadIsRejected();

// NEW 1: ApplyTemplateModal resets stale state on every open and gates
// Confirm on loading/loadError, not just derived from `templates`.
assert.match(applyTemplateModal, /setTemplates\(\[\]\)/, "ApplyTemplateModal must clear templates on every open, not just the first");
assert.match(applyTemplateModal, /setSelectedId\(""\)/, "ApplyTemplateModal must clear selectedId on every open");
assert.match(applyTemplateModal, /disabled=\{applying \|\| loading \|\| !!loadError/, "Confirm must be explicitly disabled while loading or when loadError is set");

// NEW 2: archive confirmation is a real AlertDialog (role="alertdialog",
// focus trap/restore, Escape) — not a hand-rolled div overlay.
assert.match(templatesManager, /from "@radix-ui\/react-alert-dialog"/, "archive confirmation must be built on Radix AlertDialog");
assert.ok(!/onClick=\{\(\) => archiving === null && setConfirmArchive\(null\)\}/.test(templatesManager), "the old hand-rolled overlay click-to-dismiss must be gone");

Promise.all([
    verifyDuplicateDecisionIdInvalidatesBatchRetriesOnceThenFails(),
    verifyExtraUnknownDecisionIdInvalidatesBatchEvenWhenAllValidIdsArePresent(),
    verifyUnknownScheduleTaskIdIsDroppedNotBatchInvalidating(),
    verifyLeadTimeDaysIsClampedNotRejected(),
    verifyEmptyDecisionsShortCircuits(),
])
    .then(() => console.log("selection templates + schedule-driven due dates contract verified"))
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
