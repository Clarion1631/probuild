/**
 * Bank image matching (docs/BANK-REGISTER-PLAN.md Phase 3).
 *
 * A check image or deposit slip is EVIDENCE about a ledger line that the CSV
 * cannot explain on its own. Two live examples from prod (2026-08-19):
 *
 *   $6,037.15  "CHECK PAID CHECK"        chk#1027 — no payee, no memo
 *   $15,723.38 "OTHER DEPOSITS DEPOSIT - DDA/MMKT" — matches no milestone
 *
 * The image names them. This module decides which ledger line an image is
 * ABOUT, and — critically — never records that decision itself.
 *
 * PROPOSE, NEVER LINK. Same house rule as reconcileObservations and
 * vendor-alias: a confirmed match is a row a HUMAN writes (BankImageMatch,
 * a deliberately separate table). Everything here is a candidate with the
 * evidence attached, so nobody has to re-derive why it was suggested.
 *
 * Matching rules, strongest first:
 *   1. CHECK NUMBER + AMOUNT   — a check number is a near-unique identity
 *      and the amount corroborates it. Highest confidence.
 *   2. CHECK NUMBER alone      — the number agrees but the amount does not.
 *      NOT auto-confirmable: a bank restatement or a misread digit looks
 *      exactly like this, and the whole point is to catch those.
 *   3. AMOUNT + DATE WINDOW    — for deposits, which carry no number. Only
 *      proposed when EXACTLY ONE line in the window fits; anything else is
 *      ambiguous and reported, never guessed.
 *
 * PURE: no Prisma, no I/O.
 */

export type BankImageKind = "CHECK_FRONT" | "CHECK_BACK" | "DEPOSIT_SLIP" | "DEPOSIT_PHOTO";

export interface BankImageCandidate {
    id: string;
    kind: BankImageKind;
    /** YYYY-MM-DD as printed on the document, when known. */
    documentDate: string | null;
    /** Positive cents (an image is evidence of a document, not a signed movement). */
    amountCents: number | null;
    /** Digits only, leading zeros stripped — same identity the parsers produce. */
    normalizedCheckNumber: string | null;
}

export interface BankImageLine {
    id: string;
    /** YYYY-MM-DD */
    postedDate: string;
    /** Signed cents: negative = money out. */
    amountCents: number;
    rawDescriptor: string;
    /** Digits only, leading zeros stripped; null on non-check lines. */
    checkNumber: string | null;
}

export type ImageMatchConfidence =
    /** Check number AND amount agree. */
    | "check_number_and_amount"
    /** Check number agrees, amount does NOT — a human must look. */
    | "check_number_amount_mismatch"
    /** No number (deposit): exactly one line matches amount within the window. */
    | "amount_and_date_unique";

export interface BankImageProposal {
    bankImageId: string;
    bankLineId: string;
    confidence: ImageMatchConfidence;
    /** Days between the document date and the posted date, when both known. */
    dayDelta: number | null;
    /** Carried so the UI never has to re-query to explain itself. */
    imageAmountCents: number | null;
    lineAmountCents: number;
    checkNumber: string | null;
    lineDescriptor: string;
    /** Plain-language reason shown to the human confirming it. */
    reason: string;
}

export type UnmatchedImageReason =
    | "no_candidate"
    | "ambiguous"
    | "insufficient_data";

export interface UnmatchedImage {
    bankImageId: string;
    reason: UnmatchedImageReason;
    /** Line ids that tied, when ambiguous. */
    candidateLineIds: string[];
    detail: string;
}

export interface BankImageMatchResult {
    proposals: BankImageProposal[];
    unmatched: UnmatchedImage[];
}

/** Default window for amount+date deposit matching. */
export const DEPOSIT_DAY_WINDOW = 3;

function daysBetween(a: string, b: string): number {
    const t1 = Date.parse(`${a}T00:00:00Z`);
    const t2 = Date.parse(`${b}T00:00:00Z`);
    if (!Number.isFinite(t1) || !Number.isFinite(t2)) return Number.NaN;
    return Math.round((t2 - t1) / 86_400_000);
}

const isCheckKind = (k: BankImageKind) => k === "CHECK_FRONT" || k === "CHECK_BACK";

/**
 * Proposes an image → ledger-line pairing for each image.
 *
 * `alreadyMatchedImageIds` are images a human has already confirmed; they are
 * skipped entirely so a confirmed decision is never re-litigated.
 */
export function proposeImageMatches(
    images: BankImageCandidate[],
    lines: BankImageLine[],
    options: { dayWindow?: number; alreadyMatchedImageIds?: string[] } = {},
): BankImageMatchResult {
    const dayWindow = options.dayWindow ?? DEPOSIT_DAY_WINDOW;
    const confirmed = new Set(options.alreadyMatchedImageIds ?? []);

    const proposals: BankImageProposal[] = [];
    const unmatched: UnmatchedImage[] = [];

    // Index lines by check number for the strong path.
    const byCheckNumber = new Map<string, BankImageLine[]>();
    for (const line of lines) {
        if (!line.checkNumber) continue;
        const arr = byCheckNumber.get(line.checkNumber);
        if (arr) arr.push(line); else byCheckNumber.set(line.checkNumber, [line]);
    }

    // Sorted for deterministic output regardless of input order.
    for (const image of [...images].sort((a, b) => a.id.localeCompare(b.id))) {
        if (confirmed.has(image.id)) continue;

        if (isCheckKind(image.kind) && image.normalizedCheckNumber) {
            const hits = byCheckNumber.get(image.normalizedCheckNumber) ?? [];
            if (hits.length === 0) {
                unmatched.push({
                    bankImageId: image.id,
                    reason: "no_candidate",
                    candidateLineIds: [],
                    detail: `No ledger line carries check #${image.normalizedCheckNumber}`,
                });
                continue;
            }
            if (hits.length > 1) {
                unmatched.push({
                    bankImageId: image.id,
                    reason: "ambiguous",
                    candidateLineIds: hits.map(h => h.id).sort(),
                    detail: `${hits.length} ledger lines carry check #${image.normalizedCheckNumber} — a human must pick`,
                });
                continue;
            }
            const line = hits[0];
            // Compare magnitudes: the image records a positive document
            // amount, the line a signed movement.
            const amountAgrees =
                image.amountCents !== null && Math.abs(line.amountCents) === image.amountCents;
            proposals.push({
                bankImageId: image.id,
                bankLineId: line.id,
                confidence: amountAgrees ? "check_number_and_amount" : "check_number_amount_mismatch",
                dayDelta: image.documentDate ? daysBetween(image.documentDate, line.postedDate) : null,
                imageAmountCents: image.amountCents,
                lineAmountCents: line.amountCents,
                checkNumber: image.normalizedCheckNumber,
                lineDescriptor: line.rawDescriptor,
                reason: amountAgrees
                    ? `Check #${image.normalizedCheckNumber} for ${(Math.abs(line.amountCents) / 100).toFixed(2)} — number and amount both agree`
                    : `Check #${image.normalizedCheckNumber} matches, but the image says ${image.amountCents === null ? "an unknown amount" : (image.amountCents / 100).toFixed(2)} and the bank says ${(Math.abs(line.amountCents) / 100).toFixed(2)} — CHECK THIS`,
            });
            continue;
        }

        // Deposit path: no number to key on, so amount + a tight date window.
        if (image.amountCents === null || !image.documentDate) {
            unmatched.push({
                bankImageId: image.id,
                reason: "insufficient_data",
                candidateLineIds: [],
                detail: "Deposit image has no readable amount and/or date — cannot be matched safely",
            });
            continue;
        }

        const hits = lines.filter(line => {
            if (Math.abs(line.amountCents) !== image.amountCents) return false;
            const delta = Math.abs(daysBetween(image.documentDate!, line.postedDate));
            return Number.isFinite(delta) && delta <= dayWindow;
        });

        if (hits.length === 0) {
            unmatched.push({
                bankImageId: image.id,
                reason: "no_candidate",
                candidateLineIds: [],
                detail: `No ledger line for ${(image.amountCents / 100).toFixed(2)} within ${dayWindow} days of ${image.documentDate}`,
            });
            continue;
        }
        if (hits.length > 1) {
            unmatched.push({
                bankImageId: image.id,
                reason: "ambiguous",
                candidateLineIds: hits.map(h => h.id).sort(),
                detail: `${hits.length} ledger lines for ${(image.amountCents / 100).toFixed(2)} within ${dayWindow} days — a human must pick`,
            });
            continue;
        }

        const line = hits[0];
        proposals.push({
            bankImageId: image.id,
            bankLineId: line.id,
            confidence: "amount_and_date_unique",
            dayDelta: daysBetween(image.documentDate, line.postedDate),
            imageAmountCents: image.amountCents,
            lineAmountCents: line.amountCents,
            checkNumber: null,
            lineDescriptor: line.rawDescriptor,
            reason: `Only deposit of ${(image.amountCents / 100).toFixed(2)} within ${dayWindow} days of ${image.documentDate}`,
        });
    }

    return { proposals, unmatched };
}

/**
 * Ledger lines that NEED an image to be explainable: a check with no payee
 * text, or a generic bank-speak deposit. These are what the puller should go
 * fetch, and what the worklist should show as "unexplained".
 */
export function linesNeedingImages(lines: BankImageLine[]): BankImageLine[] {
    return lines.filter(line => {
        if (line.checkNumber) return true;
        // "OTHER DEPOSITS DEPOSIT - DDA/MMKT" and friends name nobody.
        return /\bDEPOSIT\s*-\s*DDA\/MMKT\b|\bOTHER DEPOSITS\b/i.test(line.rawDescriptor);
    });
}
