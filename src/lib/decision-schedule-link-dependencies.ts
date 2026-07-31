// Production `complete` dependency for suggestScheduleLinksForDecisions
// (src/lib/decision-schedule-link-core.ts). Kept out of
// src/app/api/selections/link-schedule/route.ts so it's importable directly
// by tests/the verifier script — mirrors selection-ai-sort-dependencies.ts.
import Anthropic from "@anthropic-ai/sdk";
import { mockDecisionScheduleLinkComplete } from "./decision-schedule-link-mock";
// Same mock gate as AI Auto-Sort — reused, not duplicated. Both features
// gate on the identical SELECTION_AI_MOCK/VERCEL expression (see
// isSelectionAiMockEnabled's own comment for why it's !process.env.VERCEL
// rather than a NODE_ENV check).
import { isSelectionAiMockEnabled } from "./selection-ai-sort-dependencies";

export async function completeDecisionScheduleLink(prompt: string): Promise<string> {
    if (isSelectionAiMockEnabled()) {
        return mockDecisionScheduleLinkComplete(prompt);
    }
    if (!process.env.ANTHROPIC_API_KEY) {
        throw new Error("ANTHROPIC_API_KEY not configured");
    }
    // Same call shape as selection-ai-sort-dependencies.ts — deliberately
    // matches the codebase's uniform model choice across all AI routes.
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 4000,
        messages: [{ role: "user", content: prompt }],
    });
    const block = response.content[0];
    return ("text" in block ? block.text : "").trim();
}
