// Deterministic mock `complete` dependency for selection-ai-sort-core.ts,
// used ONLY in tests (SELECTION_AI_MOCK=1) — see the production guard in
// selection-ai-sort-dependencies.ts. Never calls a real AI. Parses the exact
// structured prompt the core's buildPrompt() emits (id/name pairs for
// decisions and items) and matches an item to a decision by case-insensitive
// substring on name; otherwise null. Returns the same JSON-in-text shape a
// real completion would, so it exercises the identical
// extractJsonObject/validation path the production dependency does — only
// the suggestion CONTENT differs, never the auth/validation path.
const DECISION_LINE = /^- id: "([^"]+)" \| name: "([^"]+)"/gm;
const ITEM_LINE = /^\d+\. id: "([^"]+)" \| name: "([^"]+)"/gm;

export async function mockSelectionAiSortComplete(prompt: string): Promise<string> {
    const decisions = [...prompt.matchAll(DECISION_LINE)].map(([, id, name]) => ({ id, name }));
    const items = [...prompt.matchAll(ITEM_LINE)].map(([, id, name]) => ({ id, name }));

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
