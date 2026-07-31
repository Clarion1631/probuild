// Production `complete` dependency for suggestDecisionsForItems
// (src/lib/selection-ai-sort-core.ts). Kept out of
// src/app/api/selections/ai-sort/route.ts so it's importable directly by
// tests/the verifier script — mirrors selection-item-thread-dependencies.ts.
import Anthropic from "@anthropic-ai/sdk";
import { mockSelectionAiSortComplete } from "./selection-ai-sort-mock";

// Mock gate. The plan's literal wording gates on
// `NODE_ENV !== "production"`, but this repo's Playwright CI job builds and
// serves a PRODUCTION build for e2e (`npm run start`, NODE_ENV=production —
// see .github/workflows/ci.yml's playwright job and playwright.config.ts's
// `command: process.env.CI ? "npm run start" : "npm run dev"`). A
// NODE_ENV-based guard would silently disable the mock for every CI e2e run
// of this feature. DEVIATION (logged per the task brief): gate on
// `!process.env.VERCEL` instead — Vercel's runtime always sets VERCEL=1
// (including every real production deploy), so real production ignores this
// flag even inside a NODE_ENV=production build, while a local/CI production
// build (which never sets VERCEL) can still exercise the mock. This keeps
// the plan's actual intent (the flag can never affect a real prod deploy)
// without breaking CI's e2e run of this route.
export function isSelectionAiMockEnabled(): boolean {
    return process.env.SELECTION_AI_MOCK === "1" && !process.env.VERCEL;
}

export async function completeSelectionAiSort(prompt: string): Promise<string> {
    if (isSelectionAiMockEnabled()) {
        return mockSelectionAiSortComplete(prompt);
    }
    if (!process.env.ANTHROPIC_API_KEY) {
        throw new Error("ANTHROPIC_API_KEY not configured");
    }
    // Same call shape as auto-assign-phases.ts / assign-phases route —
    // deliberately matches the codebase's uniform model choice across all AI
    // routes.
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 4000,
        messages: [{ role: "user", content: prompt }],
    });
    const block = response.content[0];
    return ("text" in block ? block.text : "").trim();
}
