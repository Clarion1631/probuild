// Pure validation + shared types for Decision Templates (Phase 3 —
// docs/superpowers/plans/2026-07-31-selection-templates-due-dates.md). No
// prisma, no "server-only" — importable directly by tests and the verifier.

export class DecisionTemplateValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "DecisionTemplateValidationError";
    }
}

export class DecisionTemplateAuthError extends Error {
    constructor() {
        super("Forbidden");
        this.name = "DecisionTemplateAuthError";
    }
}

export class DecisionTemplateNotFoundError extends Error {
    constructor() {
        super("Template not found");
        this.name = "DecisionTemplateNotFoundError";
    }
}

export const TEMPLATE_NAME_MAX = 120;
export const MAX_ITEMS = 40;
export const ITEM_NAME_MAX = 120;
export const SCHEDULE_HINT_MAX = 120;
export const LEAD_TIME_MIN = 0;
export const LEAD_TIME_MAX = 365;

export type TemplateItemInput = {
    // Present when this item is an edit of an EXISTING DecisionTemplateItem
    // row (the UI passes ids through for rows it loaded); absent/undefined
    // for a genuinely new row. updateDecisionTemplate uses this to update
    // matched rows in place instead of delete-all-recreate, which would
    // otherwise churn every item's id and break per-item templateKey
    // provenance on projects that already applied the template (Codex
    // review round 1, issue 2).
    id?: string;
    name: string;
    area?: string | null;
    defaultLeadTimeDays?: number | null;
    scheduleHint?: string | null;
};

export type CleanTemplateItem = {
    id?: string;
    name: string;
    area: string | null;
    defaultLeadTimeDays: number | null;
    scheduleHint: string | null;
    order: number;
};

export function validateTemplateName(name: string): string {
    const trimmed = (name ?? "").trim();
    if (!trimmed) throw new DecisionTemplateValidationError("Template name is required");
    if (trimmed.length > TEMPLATE_NAME_MAX) {
        throw new DecisionTemplateValidationError(`Template name must be ${TEMPLATE_NAME_MAX} characters or fewer`);
    }
    return trimmed;
}

export function validateTemplateDescription(description: string | null | undefined): string | null {
    const trimmed = description?.trim();
    return trimmed ? trimmed : null;
}

function validateLeadTimeDays(value: unknown, label: string): number | null {
    if (value === null || value === undefined || value === "") return null;
    const n = Number(value);
    if (!Number.isInteger(n) || n < LEAD_TIME_MIN || n > LEAD_TIME_MAX) {
        throw new DecisionTemplateValidationError(
            `${label}: lead time must be a whole number of days between ${LEAD_TIME_MIN} and ${LEAD_TIME_MAX}`,
        );
    }
    return n;
}

/** Validates and normalizes a template's item list. Throws
 * DecisionTemplateValidationError on the first violation — 1..MAX_ITEMS
 * items, each with a required 1..120 char name, an optional area, an
 * optional 0..365 defaultLeadTimeDays, and an optional ≤120 char
 * scheduleHint. `order` is assigned from array position (server-authoritative
 * ordering — see the "full items replace" note on updateDecisionTemplate). */
export function validateTemplateItems(items: TemplateItemInput[]): CleanTemplateItem[] {
    if (!Array.isArray(items) || items.length === 0) {
        throw new DecisionTemplateValidationError("At least one item is required");
    }
    if (items.length > MAX_ITEMS) {
        throw new DecisionTemplateValidationError(`A template can have at most ${MAX_ITEMS} items`);
    }
    // Duplicate ids in an update payload (Codex review round 2, NEW 3) would
    // make updateDecisionTemplate's "update in place by id" loop write the
    // same row twice with two different item's data (whichever iterates
    // last wins) and silently lose the other — reject up front instead.
    const seenIds = new Set<string>();
    for (const item of items) {
        const id = typeof item?.id === "string" ? item.id : undefined;
        if (!id) continue;
        if (seenIds.has(id)) {
            throw new DecisionTemplateValidationError("Two items reference the same existing row — refresh and try again.");
        }
        seenIds.add(id);
    }
    return items.map((item, index) => {
        const label = `Item ${index + 1}`;
        const name = (item?.name ?? "").trim();
        if (!name) throw new DecisionTemplateValidationError(`${label}: name is required`);
        if (name.length > ITEM_NAME_MAX) {
            throw new DecisionTemplateValidationError(`${label}: name must be ${ITEM_NAME_MAX} characters or fewer`);
        }
        const area = item.area?.trim() || null;
        const scheduleHintRaw = item.scheduleHint?.trim() || null;
        if (scheduleHintRaw && scheduleHintRaw.length > SCHEDULE_HINT_MAX) {
            throw new DecisionTemplateValidationError(`${label}: schedule hint must be ${SCHEDULE_HINT_MAX} characters or fewer`);
        }
        const defaultLeadTimeDays = validateLeadTimeDays(item.defaultLeadTimeDays, label);
        const id = typeof item.id === "string" && item.id ? item.id : undefined;
        return { id, name, area, defaultLeadTimeDays, scheduleHint: scheduleHintRaw, order: index };
    });
}

/** Per-item provenance key — Decision has @@unique([projectId, templateKey]),
 * so a shared per-template key would make every item after the first fail
 * applyDecisionTemplate. */
export function buildTemplateKey(templateId: string, itemId: string): string {
    return `decision-template:${templateId}:${itemId}`;
}

/** Shared dedupe-comparison normalization (Codex review round 2, N1) — used
 * on BOTH sides of every "is this the same category" comparison in this
 * feature (currently applyDecisionTemplate's name-based skip check).
 * NFKD (not NFKC) decomposes precomposed characters into base + combining
 * marks, which are then stripped — this additionally handles cases NFKC
 * alone does not, e.g. the Turkish dotted/dotless İ/ı pair and any
 * accent/diacritic entered with a combining mark instead of a precomposed
 * character, not just differing Unicode compositions of the same visual
 * glyph. */
export function normalizeForDedupe(name: string): string {
    return name.trim().normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}
