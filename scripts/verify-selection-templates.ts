// Verifier for Decision Templates + Schedule-Driven Due Dates
// (docs/superpowers/plans/2026-07-31-selection-templates-due-dates.md).
// Mirrors scripts/verify-selection-ai-sort.ts's structure: static regex
// assertions against source files, plus dynamic behavior checks against the
// real (pure/plain-module) exports. Grows across the feature's commits —
// this version covers Task 1 (template CRUD + apply); schedule-linking and
// due-date derivation checks land with Task 2.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
    validateTemplateItems,
    validateTemplateName,
    buildTemplateKey,
    DecisionTemplateValidationError,
    MAX_ITEMS,
    ITEM_NAME_MAX,
    LEAD_TIME_MIN,
    LEAD_TIME_MAX,
} from "../src/lib/decision-template-core";

const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

const schema = read("prisma/schema.prisma");
const applyScript = read("scripts/apply-selection-templates.mjs");
const templateCrudCore = read("src/lib/decision-template-crud-core.ts");
const templateApplyCore = read("src/lib/decision-template-apply-core.ts");
const permissions = read("src/lib/permissions.ts");

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

console.log("decision templates (Task 1) contract verified");
