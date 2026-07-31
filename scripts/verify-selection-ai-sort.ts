import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
    AiSortUnavailableError,
    suggestDecisionsForItems,
    type AiSortDecisionInput,
    type AiSortItemInput,
} from "../src/lib/selection-ai-sort-core";
import { mockSelectionAiSortComplete } from "../src/lib/selection-ai-sort-mock";

const decisions: AiSortDecisionInput[] = [
    { id: "decision-fixtures", name: "Fixtures", area: "Kitchen" },
    { id: "decision-flooring", name: "Flooring", area: null },
];
const items: AiSortItemInput[] = [
    { id: "item-1", name: "Brushed Nickel Faucet", description: null, clientNote: null, vendorUrl: null },
    { id: "item-2", name: "Oak Flooring Sample", description: null, clientNote: null, vendorUrl: null },
];

async function verifyInvalidIdsDroppedAndConfidenceClamped(): Promise<void> {
    const { suggestions } = await suggestDecisionsForItems(
        { decisions, items },
        {
            complete: async () =>
                JSON.stringify({
                    suggestions: [
                        // Unknown itemId — must be dropped.
                        { itemId: "not-a-real-item", decisionId: "decision-fixtures", confidence: "high", reason: "x" },
                        // Unknown decisionId — decisionId must clamp to null, item still counted.
                        { itemId: "item-1", decisionId: "not-a-real-decision", confidence: "bogus", reason: "x".repeat(500) },
                        { itemId: "item-2", decisionId: "decision-flooring", confidence: "medium", reason: "Matches flooring" },
                    ],
                }),
        },
    );

    assert.equal(suggestions.length, 2, "unknown itemId must be dropped, leaving exactly the 2 real items");
    const item1 = suggestions.find((s) => s.itemId === "item-1");
    assert.ok(item1, "item-1 must still be present");
    assert.equal(item1!.decisionId, null, "an unrecognized decisionId must be dropped to null");
    assert.equal(item1!.confidence, "low", "an out-of-enum confidence must clamp to low");
    assert.equal(item1!.reason.length, 200, "reason must be truncated to 200 chars");

    const item2 = suggestions.find((s) => s.itemId === "item-2");
    assert.equal(item2!.decisionId, "decision-flooring");
    assert.equal(item2!.confidence, "medium");
}

async function verifyEmptyUnsortedShortCircuits(): Promise<void> {
    let calls = 0;
    const { suggestions } = await suggestDecisionsForItems(
        { decisions, items: [] },
        { complete: async () => { calls += 1; return "{}"; } },
    );
    assert.deepEqual(suggestions, []);
    assert.equal(calls, 0, "the AI must never be called when there are no unsorted items");
}

async function verifyMissingItemInBatchIsInvalidRetriesOnceThenFails(): Promise<void> {
    let calls = 0;
    await assert.rejects(
        suggestDecisionsForItems(
            { decisions, items },
            {
                complete: async () => {
                    calls += 1;
                    // Only ever returns item-1 — item-2 is missing from every
                    // response, which must never be silently converted to a
                    // null match.
                    return JSON.stringify({
                        suggestions: [{ itemId: "item-1", decisionId: null, confidence: "low", reason: "x" }],
                    });
                },
            },
        ),
        AiSortUnavailableError,
    );
    assert.equal(calls, 2, "a batch missing an item must be retried exactly once before failing");
}

async function verifyTruncatedResponseRetriesThenFails(): Promise<void> {
    let calls = 0;
    await assert.rejects(
        suggestDecisionsForItems(
            { decisions, items },
            {
                complete: async () => {
                    calls += 1;
                    return '{"suggestions": [{"itemId": "item-1"'; // truncated JSON
                },
            },
        ),
        AiSortUnavailableError,
    );
    assert.equal(calls, 2, "a truncated/unparseable response must be retried exactly once before failing");
}

async function verifyRetrySucceedsOnSecondAttempt(): Promise<void> {
    let calls = 0;
    const { suggestions } = await suggestDecisionsForItems(
        { decisions, items },
        {
            complete: async () => {
                calls += 1;
                if (calls === 1) return "not json at all";
                return JSON.stringify({
                    suggestions: [
                        { itemId: "item-1", decisionId: "decision-fixtures", confidence: "high", reason: "ok" },
                        { itemId: "item-2", decisionId: "decision-flooring", confidence: "high", reason: "ok" },
                    ],
                });
            },
        },
    );
    assert.equal(calls, 2);
    assert.equal(suggestions.length, 2);
}

async function verifyMockDeterministicKeywordMatch(): Promise<void> {
    const { suggestions } = await suggestDecisionsForItems(
        { decisions, items },
        { complete: mockSelectionAiSortComplete },
    );
    assert.equal(suggestions.length, 2);
    // The mock is a pure keyword matcher over item/decision names — neither
    // item name contains "Fixtures"/"Flooring" as a substring, so both
    // should resolve to no match. This just proves the mock round-trips
    // through the exact same core validation path as production, not any
    // particular matching outcome.
    for (const s of suggestions) {
        assert.ok(["high", "medium", "low"].includes(s.confidence));
    }

    const nameMatchDecisions: AiSortDecisionInput[] = [{ id: "d-1", name: "Flooring", area: null }];
    const nameMatchItems: AiSortItemInput[] = [
        { id: "i-1", name: "Oak Flooring Plank", description: null, clientNote: null, vendorUrl: null },
    ];
    const { suggestions: matched } = await suggestDecisionsForItems(
        { decisions: nameMatchDecisions, items: nameMatchItems },
        { complete: mockSelectionAiSortComplete },
    );
    assert.equal(matched[0].decisionId, "d-1", "mock must keyword-match an item name containing the decision name");
    assert.equal(matched[0].confidence, "high");
}

// ── Static assertions ───────────────────────────────────────────────────────

const route = readFileSync(join(process.cwd(), "src/app/api/selections/ai-sort/route.ts"), "utf8");
const actions = readFileSync(join(process.cwd(), "src/lib/actions.ts"), "utf8");
const dependencies = readFileSync(join(process.cwd(), "src/lib/selection-ai-sort-dependencies.ts"), "utf8");
const schema = readFileSync(join(process.cwd(), "prisma/schema.prisma"), "utf8");
const applyScript = readFileSync(join(process.cwd(), "scripts/apply-selection-ai-sort.mjs"), "utf8");

// Staff-auth-before-validation: getCurrentUserWithPermissions() must be
// called, and resolved with an early return, BEFORE the request body is ever
// parsed — an unauthenticated/portal caller must get 403 without any body
// validation detail (the plan's ordering requirement).
const sessionIdx = route.indexOf("const user = await getCurrentUserWithPermissions();");
const bodyParseIdx = route.indexOf("await req.json()");
assert.ok(sessionIdx >= 0 && bodyParseIdx > sessionIdx, "the route must resolve the staff session before parsing the request body");
assert.match(route, /if \(!user\) \{\s*return NextResponse\.json\(\{ error: "Forbidden" \}, \{ status: 403 \}\);/, "a missing staff session must return 403, not 401 — portal clients and anonymous callers both get 403");
assert.match(route, /canAccessProject\(user, projectId\)/, "the route must scope-check the project via canAccessProject");
assert.ok(!route.includes("assertDecisionActorAccess("), "the route is staff-only — it must not call assertDecisionActorAccess (which also admits portal clients)");

// Empty-unsorted short-circuit must exist in the route before any AI call.
assert.match(route, /unsortedItems\.length === 0/, "the route must short-circuit on empty unsorted without calling the AI");

// Conditional persist guard: the suggestion write must be conditioned on
// decisionId: null so a concurrent manual assignment wins.
assert.match(
    route,
    /where:\s*\{\s*id:\s*s\.itemId,\s*decisionId:\s*null,\s*deletedAt:\s*null\s*\}/,
    "the suggestion persist write must be a conditional updateMany guarded on decisionId: null",
);

// Mock guard: must exist in code, exactly as the deviation note describes —
// gated on VERCEL rather than NODE_ENV, since CI's Playwright job serves a
// production build for e2e (see selection-ai-sort-dependencies.ts's comment).
assert.match(
    dependencies,
    /process\.env\.SELECTION_AI_MOCK === "1" && !process\.env\.VERCEL/,
    "the mock gate must check SELECTION_AI_MOCK === \"1\" && !process.env.VERCEL",
);

// applySuggestedDecision: target-decision project validation + status "Idea"
// CAS guard. The CAS logic lives in selection-ai-sort-apply-core.ts, not
// actions.ts (see that file's header comment) — actions.ts just re-exports
// thin "use server" wrappers.
const applyCore = readFileSync(join(process.cwd(), "src/lib/selection-ai-sort-apply-core.ts"), "utf8");
assert.match(
    applyCore,
    /decision\.findFirst\(\{\s*where:\s*\{\s*id:\s*decisionId,\s*projectId:\s*item\.projectId,\s*deletedAt:\s*null\s*\}/,
    "applySuggestedDecision must validate the target decision belongs to the item's project",
);
assert.match(
    applyCore,
    /where:\s*\{\s*id:\s*itemId,\s*decisionId:\s*null,\s*deletedAt:\s*null,\s*status:\s*"Idea"\s*\},\s*data:\s*\{\s*decisionId,\s*suggestedDecisionId:\s*null,\s*suggestedAt:\s*null\s*\}/,
    "applySuggestedDecision's CAS write must guard on decisionId: null AND status: \"Idea\", and clear the suggestion fields",
);
assert.match(
    applyCore,
    /if \(claim\.count === 0\) \{\s*return \{ applied: false \};/,
    "applySuggestedDecision must report a zero-count CAS as { applied: false }, never throw",
);
assert.match(
    applyCore,
    /export async function dismissSelectionSuggestion\(/,
    "dismissSelectionSuggestion must be exported from selection-ai-sort-apply-core.ts",
);
assert.match(
    actions,
    /export async function applySuggestedDecision\(itemId: string, decisionId: string\): Promise<\{ applied: boolean \}> \{\s*return aiSortApplySuggestedDecision\(itemId, decisionId\);/,
    "actions.ts's applySuggestedDecision must delegate to the testable core",
);
assert.match(
    actions,
    /export async function dismissSelectionSuggestion\(itemId: string\): Promise<\{ success: true \}> \{\s*return aiSortDismissSelectionSuggestion\(itemId\);/,
    "actions.ts's dismissSelectionSuggestion must delegate to the testable core",
);

// assignItemToDecision must clear the suggestion fields in the same write —
// an assigned or manually-filed item carries no stale chip.
const assignIdx = actions.indexOf("export async function assignItemToDecision(");
const assignSlice = actions.slice(assignIdx, assignIdx + 3000);
assert.match(
    assignSlice,
    /data:\s*\{\s*decisionId,\s*suggestedDecisionId:\s*null,\s*suggestedAt:\s*null\s*\}/,
    "assignItemToDecision must clear suggestedDecisionId/suggestedAt in the same conditional write",
);

// Portal field stripping: every portal-facing SelectionProposal read must
// strip suggestedDecisionId/suggestedAt via stripSuggestionFields.
assert.match(actions, /function stripSuggestionFields</, "actions.ts must define stripSuggestionFields");
const portalDecisionsIdx = actions.indexOf("export async function getProjectDecisionsForPortal(");
const portalDecisionsSlice = actions.slice(portalDecisionsIdx, portalDecisionsIdx + 1200);
assert.match(portalDecisionsSlice, /stripSuggestionFields\(/, "getProjectDecisionsForPortal must strip suggestion fields");
const portalProposalsIdx = actions.indexOf("export async function getSelectionProposalsForPortal(");
const portalProposalsSlice = actions.slice(portalProposalsIdx, portalProposalsIdx + 800);
assert.match(portalProposalsSlice, /stripSuggestionFields\(/, "getSelectionProposalsForPortal must strip suggestion fields");
const submitIdx = actions.indexOf("export async function submitSelectionProposal(");
const submitSlice = actions.slice(submitIdx, submitIdx + 6000);
assert.match(submitSlice, /stripSuggestionFields\(/, "submitSelectionProposal's return must strip suggestion fields");

// Schema + migration script: additive columns, no FK (advisory-only).
assert.match(schema, /suggestedDecisionId\s+String\?/, "schema must declare suggestedDecisionId as an optional, non-FK column");
assert.match(schema, /suggestedAt\s+DateTime\?/, "schema must declare suggestedAt");
assert.match(applyScript, /ADD COLUMN IF NOT EXISTS "suggestedDecisionId"/, "apply script must be idempotent (IF NOT EXISTS)");
assert.match(applyScript, /ADD COLUMN IF NOT EXISTS "suggestedAt"/, "apply script must be idempotent (IF NOT EXISTS)");

Promise.all([
    verifyInvalidIdsDroppedAndConfidenceClamped(),
    verifyEmptyUnsortedShortCircuits(),
    verifyMissingItemInBatchIsInvalidRetriesOnceThenFails(),
    verifyTruncatedResponseRetriesThenFails(),
    verifyRetrySucceedsOnSecondAttempt(),
    verifyMockDeterministicKeywordMatch(),
])
    .then(() => console.log("selection ai-sort contract verified"))
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
