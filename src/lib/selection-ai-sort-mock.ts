// Deterministic mock `complete` dependency for selection-ai-sort-core.ts,
// used ONLY in tests (SELECTION_AI_MOCK=1) — see the production guard in
// selection-ai-sort-dependencies.ts. Never calls a real AI. Parses the exact
// <decisions>/<items> JSON blocks the core's buildPrompt() emits and matches
// an item to a decision by case-insensitive substring on name; otherwise
// null. Returns the same JSON-in-text shape a real completion would, so it
// exercises the identical extractJsonObject/validation path the production
// dependency does — only the suggestion CONTENT differs, never the
// auth/validation path.
// Greedy (not non-greedy) — matches from the first opening tag to the LAST
// occurrence of the closing tag, so the mock parses the full block even if
// an embedded closer-like sequence slipped through somehow. Defense in
// depth: the core's buildPrompt() already neutralizes any literal "</" in
// client-controlled fields before this ever runs (see escapeFenceClosers in
// selection-ai-sort-core.ts), so in practice only the real closing tag can
// appear — but the mock stays robust independent of that guarantee.
const DECISIONS_BLOCK = /<decisions>\s*([\s\S]*)\s*<\/decisions>/;
const ITEMS_BLOCK = /<items>\s*([\s\S]*)\s*<\/items>/;

type MockDecision = { id: string; name: string };
type MockItem = { id: string; name: string };

// Test-only hook: an item whose name contains this marker forces the mock
// to return a deliberately invalid response (a duplicate itemId) for the
// WHOLE batch that item lands in — lets e2e/selections-ai-sort.spec.ts
// exercise the real strict-cardinality retry-then-fail path, and batch
// isolation across multiple batches, end to end without a real AI. Inert
// prose to a real model; only meaningful here, and this mock never runs in
// production (see the VERCEL guard in selection-ai-sort-dependencies.ts).
export const FORCE_INVALID_BATCH_MARKER = "__AI_SORT_TEST_FORCE_INVALID_BATCH__";

export async function mockSelectionAiSortComplete(prompt: string): Promise<string> {
    const decisionsMatch = prompt.match(DECISIONS_BLOCK);
    const itemsMatch = prompt.match(ITEMS_BLOCK);
    const decisions: MockDecision[] = decisionsMatch ? JSON.parse(decisionsMatch[1]) : [];
    const items: MockItem[] = itemsMatch ? JSON.parse(itemsMatch[1]) : [];

    if (items.some((it) => it.name.includes(FORCE_INVALID_BATCH_MARKER))) {
        const first = items[0];
        return JSON.stringify({
            suggestions: [
                { itemId: first.id, decisionId: null, confidence: "low", reason: "forced invalid for test" },
                { itemId: first.id, decisionId: null, confidence: "low", reason: "duplicate — forced invalid for test" },
            ],
        });
    }

    const suggestions = items.map(({ id, name }) => {
        const lowerName = name.toLowerCase();
        const match = decisions.find(
            (d) => lowerName.includes(d.name.toLowerCase()) || d.name.toLowerCase().includes(lowerName),
        );
        return {
            itemId: id,
            decisionId: match?.id ?? null,
            confidence: match ? "high" : "low",
            reason: match ? `Name keyword matches "${match.name}"` : "No clear keyword match",
        };
    });

    return JSON.stringify({ suggestions });
}
