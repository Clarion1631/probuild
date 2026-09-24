/**
 * The Drive folder name: cleaning it for storage/display, and a PURE,
 * render-time suggestion rule for which open job it might mean.
 *
 * No job is ever assigned from here. `suggestJobsForFolder` only ever hands
 * back candidates for a person to tap; the tap itself goes through
 * `setReceiptIntakeJob` (src/lib/actions.ts), which re-checks the job exists
 * and CASes on the row's state and version.
 *
 * NO IMPORTS. This module has to stay safe to pull into a client component
 * (receipt-row-actions.tsx) and cheap to unit test without dragging Prisma or
 * `worker.ts` along (Codex round 1, finding 12).
 */

/** Kept whole; a folder is cut here before it is ever stored. */
export const FOLDER_MAX_CHARS = 200;
/** Below this, a folder is too short to trust as a whole-word prefix. */
export const PREFIX_MIN_CHARS = 3;
/** More candidates than this and nothing is different enough to trust a button. */
export const MAX_FOLDER_BUTTONS = 4;
/**
 * The bot's own overhead folder name — mirrors `isOverheadShopFolder_`
 * (qbo-clasp/runReceiptAutomation.js:171-174): trimmed, lower-cased, and
 * EXACTLY this string. No punctuation stripping, unlike `normalizeJobName`
 * below — see `isOverheadName`.
 */
export const OVERHEAD_FOLDER = "shop";

/**
 * Whitespace (Unicode `White_Space`, which already covers space/tab/newline,
 * NBSP, and the line/paragraph separators U+2028/U+2029) and control
 * characters (`\p{Cc}`) become ONE space. Two words are never joined by a
 * character that used to separate them.
 */
const WHITESPACE_OR_CONTROL = /[\p{White_Space}\p{Cc}]+/gu;
/**
 * Invisible FORMAT characters (`\p{Cf}`: zero-width spaces and joiners, bidi
 * overrides, BOM — none of them are `White_Space`, so the run above never
 * touches them) and lone surrogates are REMOVED, not spaced: they draw
 * nothing, so removing them is what keeps "what the crew saw".
 */
const FORMAT_OR_LONE_SURROGATE = /[\p{Cf}]|[\uD800-\uDFFF]/gu;

/**
 * The ONE control/format cleanup, shared by `cleanFolderName` and
 * `normalizeJobName` (Codex round 2, finding 2). Before this fix, a folder's
 * zero-width space was removed at CLEANING time (no space left behind) while
 * the same character inside a job's name — read straight from the database,
 * never cleaned — fell through `normalizeJobName`'s later "every other run of
 * non-alnum becomes a space" step and turned INTO a space, so the two sides
 * of a comparison disagreed about a job's own identity. Running the identical
 * two-step cleanup on both sides first closes that gap.
 */
function stripInvisibleAndControl(s: string): string {
    return s.replace(WHITESPACE_OR_CONTROL, " ").replace(FORMAT_OR_LONE_SURROGATE, "");
}

/**
 * The Drive folder name, cleaned for storage and display.
 *
 * 1. Whitespace/control/line-separator runs become one space.
 * 2. Invisible format characters and lone surrogates are removed.
 * 3. Repeated spaces collapse; the ends trim.
 * 4. Cut to `FOLDER_MAX_CHARS` CODE POINTS (never splitting an emoji), then
 *    trimmed again.
 * 5. Empty gives null.
 *
 * Non-strings give null.
 */
export function cleanFolderName(raw: unknown): string | null {
    if (typeof raw !== "string") return null;
    let s = stripInvisibleAndControl(raw);
    s = s.replace(/ {2,}/g, " ").trim();
    if (Array.from(s).length > FOLDER_MAX_CHARS) {
        s = Array.from(s).slice(0, FOLDER_MAX_CHARS).join("").trim();
    }
    return s === "" ? null : s;
}

/**
 * The folder ProBuild is allowed to KEEP from this request.
 *
 * Only the shared-secret drive forwarder's folder is trusted — stricter than
 * the `archivedByV1` precedent, which checks only the secret (`route.ts`). A
 * signed-in or mobile caller's folder is ignored, and so is one on a `chat`
 * or `email` source.
 */
export function intakeFolderOf(via: string, source: string, raw: unknown): string | null {
    return via === "secret" && source === "drive" ? cleanFolderName(raw) : null;
}

const COMBINING_MARK = /\p{Mn}/gu;
const APOSTROPHES = /['‘’ʼ`]/g;
const NON_ALNUM_RUN = /[^\p{L}\p{N}]+/gu;

/**
 * Matching-only normalization (never displayed). Anything the bot already
 * calls equal (trim + lower case) is equal here too, plus more:
 *
 * 1. The same control/format cleanup `cleanFolderName` uses (see above).
 * 2. NFKD, then strip combining marks ("José" equals "Jose"; full-width
 *    letters become ASCII, folded in by NFKD itself).
 * 3. Lower case.
 * 4. `&` becomes " and ".
 * 5. Apostrophes are deleted (never spaced — "Birch Lane's" must join into
 *    "Birch Lanes", not split into "Birch Lane s"), BEFORE the next step.
 * 6. Every other run of characters that are not letters or digits becomes
 *    one space, then trim.
 *
 * Non-strings give "".
 */
export function normalizeJobName(raw: unknown): string {
    if (typeof raw !== "string") return "";
    let s = stripInvisibleAndControl(raw);
    s = s.normalize("NFKD").replace(COMBINING_MARK, "");
    s = s.toLowerCase();
    s = s.replace(/&/g, " and ");
    s = s.replace(APOSTROPHES, "");
    s = s.replace(NON_ALNUM_RUN, " ").trim();
    return s;
}

/**
 * Is this name THE overhead folder/job, by the bot's own literal rule — trim
 * and lower case, no punctuation stripped? Deliberately NARROWER than
 * `normalizeJobName`: "Shop." normalizes the same as "Shop" for matching
 * purposes, but it is not, by this rule, the reserved overhead name. That gap
 * is exactly what keeps the two apart (see `suggestJobsForFolder`).
 */
function isOverheadName(raw: unknown): boolean {
    if (typeof raw !== "string") return false;
    return stripInvisibleAndControl(raw).trim().toLowerCase() === OVERHEAD_FOLDER;
}

export type FolderSuggestions =
    | { kind: "none" }
    | { kind: "exact" | "prefix"; jobs: Array<{ id: string; name: string }> }
    | { kind: "same-name" }
    | { kind: "too-many" };

function sortJobs<T extends { id: string; name: string }>(jobs: T[]): T[] {
    return [...jobs].sort((a, b) => a.name.localeCompare(b.name, "en") || a.id.localeCompare(b.id));
}

/**
 * Which open jobs a folder might mean — a snapshot for a person to tap, never
 * a decision made for them.
 *
 * `jobs` is never mutated, and every job in a result is a FRESH `{id, name}`
 * object.
 *
 * Step 0 — an empty folder, or a job list at or over `listCap` (which may be
 * cut short and could fake a single match), gives `none`.
 *
 * THE OVERHEAD GUARD RUNS BEFORE EXACT MATCHING (Codex round 2, finding 1).
 * Matching two NORMALIZED names alone cannot tell "the overhead folder" from
 * "a customer project whose name happens to normalize the same way" —
 * `normalizeJobName("Shop.")` is `"shop"`, same as `normalizeJobName("Shop")`
 * — so the reserved name is decided FIRST, by the bot's own literal rule
 * (`isOverheadName`, no punctuation stripped), and only jobs on the SAME side
 * of that line are ever considered:
 *   - folder IS the overhead folder ("Shop", exactly) -> only a job that IS
 *     the overhead job ("Shop", exactly) is eligible. A customer project
 *     merely named "Shop." is never offered for it.
 *   - folder is NOT the overhead folder (including "Shop." — a project
 *     folder by the bot's own classifier) -> the overhead job is never
 *     eligible for it, even though the two normalize the same way.
 * Only after that split does normalized EXACT matching run, and the overhead
 * folder never reaches the PREFIX step at all (no second name is ever offered
 * for "Shop", matching the bot's own rule).
 *
 * Namesake suppression covers prefix candidates too (Codex round 2, finding
 * 6): two open jobs with the same normalized name draw the same button label,
 * so that is `same-name` (no buttons), not two indistinguishable buttons.
 */
export function suggestJobsForFolder(
    folder: string | null | undefined,
    jobs: ReadonlyArray<{ id: string; name: string }>,
    listCap: number,
): FolderSuggestions {
    if (!folder) return { kind: "none" };
    if (jobs.length >= listCap) return { kind: "none" };
    const f = normalizeJobName(folder);
    if (!f) return { kind: "none" };

    const folderIsOverhead = isOverheadName(folder);
    const eligible = jobs.filter(job => isOverheadName(job.name) === folderIsOverhead);

    const exact = eligible.filter(job => normalizeJobName(job.name) === f);
    if (exact.length === 1) return { kind: "exact", jobs: [{ id: exact[0].id, name: exact[0].name }] };
    if (exact.length >= 2) return { kind: "same-name" };

    // No prefix step for a folder that READS as the overhead folder once
    // normalized — literally "Shop" or a punctuation variant like "Shop.",
    // either way. It only ever offers its own exact name (above), never a
    // second, different one: a real "Shop Shed" project must never be
    // offered just because some spelling of "shop" is on the folder side.
    if (f === OVERHEAD_FOLDER) return { kind: "none" };
    if (f.length < PREFIX_MIN_CHARS) return { kind: "none" };

    const prefixed = eligible.filter(job => normalizeJobName(job.name).startsWith(`${f} `));
    const names = prefixed.map(job => normalizeJobName(job.name));
    if (new Set(names).size !== names.length) return { kind: "same-name" };
    if (prefixed.length === 0) return { kind: "none" };
    if (prefixed.length > MAX_FOLDER_BUTTONS) return { kind: "too-many" };

    return { kind: "prefix", jobs: sortJobs(prefixed).map(job => ({ id: job.id, name: job.name })) };
}

export const FOLDER_COPY = {
    fact: "Folder: {folder}",
    exactLead: "Same name as the folder:",
    prefixLead: "Starts with the folder name:",
    sameName: "More than one open job has this name, so there is no button. Tell Justin.",
    tooMany: "Several open jobs start with this folder name. Pick one from the list.",
} as const;

export function folderFact(folder: string): string {
    return FOLDER_COPY.fact.replace("{folder}", folder);
}
