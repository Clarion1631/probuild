/**
 * Check-payer fuzzy matching — payerName → Client, memoText → Project.
 *
 * TS port of the suggestion logic in scripts/extract-check-payers.mjs
 * (nameTokens / nameSimilarity / suggestMatches). The script stays the CLI
 * entry point; this module is what the Automation "Check images" panel uses
 * server-side. tests/check-payer-match.test.ts asserts the two stay in
 * agreement, so neither can drift silently.
 *
 * SUGGESTION ONLY — same house rule as bank-image.ts and vendor-alias:
 * nothing here may ever write BankImageMatch. That table means a HUMAN said
 * yes; the confirm server action is the only writer.
 *
 * PURE: no Prisma, no I/O.
 */

const NAME_NOISE = new Set([
    "llc", "inc", "co", "corp", "ltd", "the", "and", "&", "of",
    "mr", "mrs", "ms", "dr", "or",
]);

export interface NamedRow {
    id: string;
    name: string;
}

export interface MatchSuggestion {
    id: string;
    name: string;
    /** 0..1 — token-set Jaccard with a containment bonus. */
    score: number;
}

export interface CheckMatchSuggestions {
    payerMatches: MatchSuggestion[];
    memoMatches: MatchSuggestion[];
}

/** Minimum similarity for a suggestion to surface at all. */
export const SUGGESTION_THRESHOLD = 0.4;
/** Suggestions shown per field. */
export const SUGGESTION_LIMIT = 3;

export function nameTokens(s: string | null | undefined): string[] {
    return String(s ?? "")
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter(t => t && !NAME_NOISE.has(t));
}

/** Pure. 0..1 similarity: token-set Jaccard plus a containment bonus. */
export function nameSimilarity(a: string | null | undefined, b: string | null | undefined): number {
    const ta = nameTokens(a), tb = nameTokens(b);
    if (!ta.length || !tb.length) return 0;
    const sa = new Set(ta), sb = new Set(tb);
    const inter = [...sa].filter(t => sb.has(t)).length;
    const union = new Set([...sa, ...sb]).size;
    const jaccard = inter / union;
    const containment = inter / Math.min(sa.size, sb.size);
    return Math.max(jaccard, containment * 0.85);
}

/**
 * Pure. Suggest candidate matches for one extraction. Returns
 * { payerMatches, memoMatches } sorted by score, top 3 each, threshold 0.4.
 * A null/blank payer or memo yields an empty list — never a guess.
 */
export function suggestMatches(
    extraction: { payerName: string | null; memoText: string | null },
    clients: NamedRow[],
    projects: NamedRow[],
): CheckMatchSuggestions {
    const rank = (text: string, rows: NamedRow[]): MatchSuggestion[] => rows
        .map(r => ({ id: r.id, name: r.name, score: nameSimilarity(text, r.name) }))
        .filter(m => m.score >= SUGGESTION_THRESHOLD)
        .sort((x, y) => y.score - x.score || x.id.localeCompare(y.id))
        .slice(0, SUGGESTION_LIMIT);
    return {
        payerMatches: extraction.payerName ? rank(extraction.payerName, clients) : [],
        memoMatches: extraction.memoText ? rank(extraction.memoText, projects) : [],
    };
}

/**
 * Normalize a check-number-ish reference to the identity every parser in
 * this repo produces: digits only, leading zeros stripped. Returns null for
 * anything that leaves no digits — "" must never match "" on a join.
 */
export function normalizeCheckRef(value: string | null | undefined): string | null {
    const digits = String(value ?? "").replace(/\D/g, "").replace(/^0+/, "");
    return digits.length ? digits : null;
}
