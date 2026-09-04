// Rule-based cost-code (phase) suggestion for an expense that has none.
//
// Extracted verbatim from scripts/suggest-expense-cost-codes.mjs (2026-08-18)
// so there is ONE copy of the rules. The script now imports this module, the
// QBO sync runs it on import, and scripts/backfill-expense-attribution.mjs
// runs it over the historical backlog — three callers, one rule set.
//
// THIS IS NOT AI. It is regex over the vendor name and the itemised receipt
// text, and it is called "ai" in `Expense.costCodeSource` only because that is
// the value the spec fixed for "a machine chose this, not a human". Treat a hit
// as a suggestion a bookkeeper can overturn, never as a measurement.
//
// PHILOSOPHY — why rules, and why they refuse so often
//   A wrong cost code is worse than an absent one: it silently corrupts job
//   costing, and TRUST is one of the four product rules. So this only answers
//   when the evidence is unambiguous (a specialty vendor, or explicit material
//   keywords in the itemised lines). Everything else returns null on purpose,
//   and null is reported to a human rather than guessed at. Vendor alone is
//   never enough for a general retailer: 134 rows are Lowe's, which sells
//   framing lumber, drywall, paint and toilets alike.

/** The expense facts the rules read. Deliberately tiny — no database types. */
export interface SuggestibleExpense {
    vendor?: string | null;
    description?: string | null;
}

export type CostCodeSuggestionTier = "vendor" | "line";

export interface CostCodeSuggestion {
    /** A CostCode.code, e.g. "03-PLUMB" — the caller resolves it to an id. */
    code: string;
    /** Human-readable provenance, for the dry-run CSV. */
    why: string;
    tier: CostCodeSuggestionTier;
    /** Fixed per tier — see below. */
    confidence: number;
}

/**
 * The rules are BINARY: a regex either matched or it did not, and there is no
 * score to report. Fixed tiers exist so `costCodeConfidence` carries the ONE
 * thing that actually varies — which kind of evidence fired — and so the
 * backfill's >= 0.7 threshold is a real gate the day a weaker tier is added
 * rather than a decoration. Do not invent per-rule numbers: a made-up 0.83
 * would be a guess presented as a measurement.
 */
export const VENDOR_RULE_CONFIDENCE = 0.9;
export const LINE_RULE_CONFIDENCE = 0.75;

/**
 * Specialty vendors that do exactly one trade. A match here is strong evidence
 * on its own — unlike a general retailer, these firms don't sell anything else.
 * Kept narrow on purpose: a bare /cabinet/ or /plumbing/ would also match a
 * general retailer that merely has the word in a line item.
 */
export const VENDOR_RULES: { re: RegExp; code: string }[] = [
    { re: /summit plumbing|\bplumbing\b(?!.*supply)/i, code: "03-PLUMB" },
    { re: /redpoint electric|red ?point electric|newman electric/i, code: "04-ELEC" },
    { re: /k ?& ?s countertops/i, code: "12-COUNTER" },
    { re: /rta.?store/i, code: "11-CABINET" },
    { re: /builders ?first ?source|shur-?way|parr lumber/i, code: "02-FRAME" },
    { re: /columbia resource|\bcrc\b/i, code: "20-CLEAN" },
    { re: /ferguson/i, code: "03-PLUMB" },
];

/**
 * Material keywords read out of the itemised receipt text the pipeline's Gemini
 * step extracts into `description` ("... | Lines: ..."). Ordered: the first hit
 * wins, so the least ambiguous come first.
 */
export const LINE_RULES: { re: RegExp; code: string }[] = [
    { re: /circuit brea|breaker|romex|wire nut|receptacle|gfci|electrical panel/i, code: "04-ELEC" },
    { re: /douglas fir|hem ?fir|treated #2|stud\b|joist|lvl\b|osb|sheathing|framing/i, code: "02-FRAME" },
    { re: /drywall|sheetrock|joint compound|mud\b|drywall screw/i, code: "07-DRYWALL" },
    { re: /\bpaint\b|primer|caulk|sherwin|behr/i, code: "08-PAINT" },
    { re: /\btile\b|thinset|grout|backer ?board/i, code: "10-TILE" },
    { re: /toilet|vanity|faucet|shower valve|p-?trap|pex|abs pipe/i, code: "03-PLUMB" },
    { re: /cabinet|catalina toffee/i, code: "11-CABINET" },
    { re: /countertop|quartz|granite slab/i, code: "12-COUNTER" },
    { re: /siding|hardie|hz10|trim board/i, code: "16-SIDING" },
    { re: /window|patio door/i, code: "14-DOOR" },
    { re: /insulation|batt\b|r-?13|r-?21/i, code: "06-INSUL" },
    // Cleanup/disposal is about HAULING WASTE AWAY — dump fees, debris runs.
    // Deliberately NOT "excavator": a mini-excavator rental is sitework/
    // excavation, not cleanup. Matching it to 20-CLEAN mis-booked a $3,317.78
    // Mesplay equipment rental in the first dry run — the reason the whole
    // "dry run first, human reviews the CSV" loop exists.
    { re: /dump fee|debris|disposal|haul away|junk removal|msw\b/i, code: "20-CLEAN" },
    { re: /excavator|skid ?steer|trencher|bobcat|equipment rental/i, code: "23-SITEWORK" },
    { re: /concrete|rebar|quikrete/i, code: "17-CONCRETE" },
    { re: /roof|shingle|underlayment/i, code: "15-ROOF" },
    { re: /flooring|lvp|laminate|carpet/i, code: "09-FLOOR" },
];

/**
 * Decide a phase for one expense. Returns a suggestion or null when the
 * evidence is not strong enough — null is a legitimate, deliberate answer.
 *
 * Pure: no I/O, no clock, no database. The caller maps `code` to a CostCode id
 * and decides whether to write it (see the capture/manual guard in
 * qbo-expense-sync.ts and the backfill).
 */
export function suggestCode(expense: SuggestibleExpense): CostCodeSuggestion | null {
    const vendor = expense.vendor || "";
    const desc = expense.description || "";

    for (const rule of VENDOR_RULES) {
        if (rule.re.test(vendor)) {
            return {
                code: rule.code,
                why: `vendor ~ ${rule.re.source.slice(0, 28)}`,
                tier: "vendor",
                confidence: VENDOR_RULE_CONFIDENCE,
            };
        }
    }
    // Only read the itemised portion; the prefix is boilerplate.
    const lines = desc.includes("Lines:") ? desc.slice(desc.indexOf("Lines:")) : desc;
    for (const rule of LINE_RULES) {
        if (rule.re.test(lines)) {
            return {
                code: rule.code,
                why: `lines ~ ${rule.re.source.slice(0, 28)}`,
                tier: "line",
                confidence: LINE_RULE_CONFIDENCE,
            };
        }
    }
    return null;
}
