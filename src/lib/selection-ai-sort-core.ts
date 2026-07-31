// AI Auto-Sort for Unsorted Selection Items — seam pattern, mirroring
// selection-item-thread-core.ts: a pure function with an injected `complete`
// dependency so tests never call a real AI. See
// docs/superpowers/plans/2026-07-30-selection-ai-sort.md.
import { extractJsonObject } from "./ai-json";

export class AiSortValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "AiSortValidationError";
    }
}

export class AiSortNotFoundError extends Error {
    constructor() {
        super("Project not found");
        this.name = "AiSortNotFoundError";
    }
}

// Thrown when a batch's AI response is missing/truncated/malformed after one
// retry — surfaced by the route as 502, never silently converted to "no
// match" (the plan's strict-cardinality rule).
export class AiSortUnavailableError extends Error {
    constructor(message = "Suggestions unavailable right now") {
        super(message);
        this.name = "AiSortUnavailableError";
    }
}

export type AiSortConfidence = "high" | "medium" | "low";
const CONFIDENCE_LEVELS: readonly AiSortConfidence[] = ["high", "medium", "low"];

export type AiSortDecisionInput = { id: string; name: string; area: string | null };
export type AiSortItemInput = {
    id: string;
    name: string;
    description: string | null;
    clientNote: string | null;
    vendorUrl: string | null;
};
export type AiSortSuggestion = {
    itemId: string;
    decisionId: string | null;
    confidence: AiSortConfidence;
    reason: string;
};

export type SuggestDecisionsForItemsDependencies = {
    complete: (prompt: string) => Promise<string>;
};

// Bounded batch size — items are classified in sequential batches, each
// batch is one AI call, so prompts stay small and one bad batch never fails
// every item.
const BATCH_SIZE = 25;
const NAME_MAX = 120;
const NOTE_MAX = 200;
const REASON_MAX = 200;
// One retry per batch before the batch fails (surfaced as 502 for those
// items) — never silently converted to "no match".
const MAX_ATTEMPTS = 2;

function truncate(value: string | null | undefined, max: number): string {
    return (value ?? "").trim().slice(0, max);
}

function vendorHost(url: string | null): string | null {
    if (!url) return null;
    try {
        return new URL(url).hostname.replace(/^www\./, "");
    } catch {
        return null;
    }
}

function buildPrompt(decisions: AiSortDecisionInput[], items: AiSortItemInput[]): string {
    const decisionsList = decisions
        .map((d) => {
            const area = truncate(d.area, NAME_MAX);
            return `- id: "${d.id}" | name: "${truncate(d.name, NAME_MAX)}"${area ? ` | area: "${area}"` : ""}`;
        })
        .join("\n");

    const itemsList = items
        .map((it, i) => {
            const parts = [`${i + 1}. id: "${it.id}" | name: "${truncate(it.name, NAME_MAX)}"`];
            const description = truncate(it.description, NOTE_MAX);
            if (description) parts.push(`description: "${description}"`);
            const note = truncate(it.clientNote, NOTE_MAX);
            if (note) parts.push(`client note: "${note}"`);
            const host = vendorHost(it.vendorUrl);
            if (host) parts.push(`vendor: "${host}"`);
            return parts.join(" | ");
        })
        .join("\n");

    return `You are helping a remodeling contractor sort unsorted selection items into the right decision category for their project.

Decisions (categories) open on this project:
${decisionsList || "(none)"}

Unsorted items to classify:
${itemsList}

For EACH item listed above, choose the single best-matching decision id, or null if nothing fits well. Every item must appear exactly once in your response. Keep each reason under ${REASON_MAX} characters.

Return ONLY valid JSON in this exact shape. Do not include any conversational text or markdown blocks:
{
  "suggestions": [
    { "itemId": "<exact id from input>", "decisionId": "<matching decision id, or null>", "confidence": "high" | "medium" | "low", "reason": "<short reason>" }
  ]
}`;
}

function cleanSuggestions(
    raw: unknown[],
    validItemIds: Set<string>,
    validDecisionIds: Set<string>,
): AiSortSuggestion[] {
    const seen = new Set<string>();
    const cleaned: AiSortSuggestion[] = [];
    for (const entry of raw) {
        if (!entry || typeof entry !== "object") continue;
        const e = entry as Record<string, unknown>;
        const itemId = String(e.itemId ?? "");
        // Only trust ids that were actually submitted in this batch — the
        // model (or injected item text) must not be able to introduce
        // arbitrary ids, and a duplicate for the same item is dropped after
        // the first (the cardinality check below then fails the batch since
        // some other item is left unrepresented).
        if (!itemId || !validItemIds.has(itemId) || seen.has(itemId)) continue;
        seen.add(itemId);
        const decisionIdRaw = e.decisionId;
        const decisionId =
            typeof decisionIdRaw === "string" && validDecisionIds.has(decisionIdRaw) ? decisionIdRaw : null;
        const confidence: AiSortConfidence = CONFIDENCE_LEVELS.includes(e.confidence as AiSortConfidence)
            ? (e.confidence as AiSortConfidence)
            : "low";
        const reason = truncate(typeof e.reason === "string" ? e.reason : "", REASON_MAX);
        cleaned.push({ itemId, decisionId, confidence, reason });
    }
    return cleaned;
}

async function classifyBatchWithRetry(
    batch: AiSortItemInput[],
    decisions: AiSortDecisionInput[],
    validDecisionIds: Set<string>,
    deps: SuggestDecisionsForItemsDependencies,
): Promise<AiSortSuggestion[]> {
    const validItemIds = new Set(batch.map((it) => it.id));
    const prompt = buildPrompt(decisions, batch);

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        try {
            const raw = await deps.complete(prompt);
            const parsed = extractJsonObject<{ suggestions?: unknown[] }>(raw);
            if (!parsed || !Array.isArray(parsed.suggestions)) {
                continue; // invalid/truncated response — retry (or fail below)
            }
            const cleaned = cleanSuggestions(parsed.suggestions, validItemIds, validDecisionIds);
            // Strict cardinality: exactly one suggestion per input item in
            // this batch. An item missing from the response is an invalid AI
            // response for the batch — never converted to a null match.
            if (cleaned.length !== batch.length) {
                continue;
            }
            return cleaned;
        } catch {
            // The complete() call itself failed — treat the same as an
            // invalid batch response and retry once.
            continue;
        }
    }
    throw new AiSortUnavailableError();
}

/**
 * Matches unsorted items to the project's live decisions. Items are
 * classified in sequential batches of BATCH_SIZE; each batch is one AI call,
 * retried once on an invalid/incomplete response before the batch fails
 * (AiSortUnavailableError, mapped to 502 by the route). Post-parse
 * validation (dropping unknown ids, clamping confidence, truncating reason)
 * always runs in this core — model output is never trusted directly.
 */
export async function suggestDecisionsForItems(
    input: { decisions: AiSortDecisionInput[]; items: AiSortItemInput[] },
    deps: SuggestDecisionsForItemsDependencies,
): Promise<{ suggestions: AiSortSuggestion[] }> {
    const { decisions, items } = input;
    if (items.length === 0) return { suggestions: [] };

    const validDecisionIds = new Set(decisions.map((d) => d.id));
    const suggestions: AiSortSuggestion[] = [];

    for (let start = 0; start < items.length; start += BATCH_SIZE) {
        const batch = items.slice(start, start + BATCH_SIZE);
        const batchSuggestions = await classifyBatchWithRetry(batch, decisions, validDecisionIds, deps);
        suggestions.push(...batchSuggestions);
    }

    return { suggestions };
}
