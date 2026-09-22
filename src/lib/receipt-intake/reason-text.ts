/**
 * `stateReason` in plain words, for the Receipts tab.
 *
 * The queue renders the raw column today, so a bookkeeper reads
 * `weak-dup:cmg8x2q…` and has to know the vocabulary to act on it. This turns
 * each known code into one short sentence a person can act on, and says nothing
 * at all about a code it does not know: an unrecognised reason falls through to
 * the raw text rather than being hidden behind a vague summary.
 *
 * The precedent is `decodeReasonCodes` (src/lib/review-alert-reasons), which
 * does this job for `ReviewIssue.reasonCodes`. Nothing equivalent existed for
 * `stateReason`, which is why raw tokens reach the queue.
 *
 * PURE: no I/O, no clock, no Prisma. Reads only fields `IntakeRow` already
 * carries (receipts-data.ts) — `refNumber` is deliberately NOT one of them, so
 * no sentence here names an invoice number.
 *
 * HOUSE STYLE for every sentence: small words, short, no em dash, no en dash,
 * and no " - " used as punctuation. `tests/receipt-intake-reason-text.test.ts`
 * asserts it over every string below rather than trusting review to catch it.
 *
 * AND THE RULE THAT MATTERS MORE: state what is true about the row and what
 * action exists. NEVER predict an outcome. "Upload it again and this one
 * clears", "a clearer photo would fix it" and "it goes as soon as the switch is
 * back on" all read as promises the pipeline is in no position to make, and a
 * promise that does not come true is how a bookkeeper learns to stop reading
 * these.
 */

/** The row facts a sentence may quote. A subset of `IntakeRow`. */
export interface ReasonTextRow {
    vendor: string | null;
    txnDate: string | null;
    totalCents: number | null;
    /** ISO, as the queue carries it. */
    createdAt: string;
}

export interface StateReasonText {
    /** One plain sentence. Falls back to the raw code when there are no words for it. */
    headline: string;
    /** The exact column value, so a developer reading over a shoulder still sees the token. */
    raw: string;
}

const DAY_MS = 86_400_000;

/**
 * A YYYY-MM-DD day as UTC midnight, for DISPLAY arithmetic only.
 *
 * Deliberately separate from route-state.ts's own parser and not exported: that
 * one decides whether money posts and is written to be unimpeachable about it.
 * This one only picks a number to put in a sentence, and a wrong sentence next
 * to the visible raw code is a much smaller thing than a wrong verdict.
 */
function utcDay(day: string | null | undefined): number | null {
    const value = typeof day === "string" ? day.slice(0, 10) : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const at = Date.parse(`${value}T00:00:00.000Z`);
    return Number.isFinite(at) ? at : null;
}

/** "$42.19". Local to this module so a pure leaf pulls in no formatting helper. */
function money(cents: number | null): string {
    if (cents === null || !Number.isFinite(cents)) return "nothing";
    return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function dateSentence(row: ReasonTextRow): string {
    const read = utcDay(row.txnDate);
    const arrived = utcDay(row.createdAt);
    if (read === null || arrived === null) {
        return "The date on this one does not fit when it arrived. That is almost certainly a misread.";
    }
    const days = Math.round((arrived - read) / DAY_MS);
    const when = row.txnDate as string;
    // STRICTLY NEGATIVE, not `<= 0`. A read date on the row's own arrival day
    // is zero days apart and is never what this reason is about, so calling it
    // "after it arrived" would be false. Only a genuinely future date lands
    // here.
    if (days < 0) {
        return `The date on this one reads as ${when}, which is after it arrived.`;
    }
    return `The date on this one reads as ${when}, which is ${days} day${days === 1 ? "" : "s"} before it arrived.`;
}

/**
 * First match wins, so the longer `multi-doc:one-page` has to sit above plain
 * `multi-doc`. Prefix patterns are used only where the code carries a row id,
 * which no sentence quotes: an id is not something a person can look up here.
 */
const REASON_TEXTS: Array<{ test: RegExp; text: (row: ReasonTextRow) => string }> = [
    {
        // NOT "I could not find a ticket number on both". That is only one of
        // the three ways this parks: the refs can also be readable but too
        // alike to separate, or the group can be too big to decide at all.
        test: /^weak-dup:/,
        text: () => "Might be the same purchase as another receipt. Same vendor, same day, same amount, and their ticket numbers do not settle it.",
    },
    {
        test: /^strong-dup-amount-mismatch:/,
        text: () => "Same invoice number as another receipt but a different total. The two do not agree.",
    },
    {
        // The colon is what keeps this apart from `strong-dup-amount-mismatch:`,
        // so the two do not depend on their order here. The heal in worker.ts
        // writes it: the row reached booking without the key it should own, and
        // a live row holds it.
        test: /^strong-dup:/,
        text: () => "Another receipt already holds this one's date and reference number. Set a job to book it anyway, or mark it a duplicate.",
    },
    {
        test: /^vendor-mismatch:/,
        text: () => "Same invoice number and total as another receipt, but a different vendor name.",
    },
    {
        // Written only by the worker's duplicate transition: routing said
        // DUPLICATE, but rows are already filed behind this one, so it cannot
        // become a copy itself (duplicate-guard.ts). The action is on the rows
        // behind it. Said out loud because this row still carries
        // `duplicateOfId`, and Set job on it would book it past the twin it
        // matches, exactly as it does for `strong-dup:`. That is a decision a
        // person may make, but not one they should make by accident.
        test: /^duplicate-chain:/,
        text: () => "Other receipts are filed as duplicates of this one, and it matches another receipt itself. Unmark the ones filed behind it first, or leave it and tell Justin.",
    },
    { test: /^date-implausible$/, text: dateSentence },
    { test: /^invalid-date$/, text: () => "I could not read a date on this one." },
    {
        test: /^multi-doc:one-page$/,
        text: () => "Several receipts are on one page, so I cannot split them. A separate photo of each would let me read them.",
    },
    { test: /^multi-doc$/, text: () => "This file has more than one receipt in it." },
    {
        test: /^refund-or-zero$/,
        text: row => `The total reads as ${money(row.totalCents)}. A refund or a zero needs a person to place it.`,
    },
    { test: /^no-estimate$/, text: () => "No job on this one yet." },
    { test: /^unreadable$/, text: () => "I could not read this file. It is usually a blurry photo or a bad scan. A clearer photo of the same receipt can be sent in." },
    { test: /^ai-unavailable$/, text: () => "The reader was down when this one came through. Retry gives it another go." },
    // NOT "upload it again and this one clears": a re-upload is a NEW row, and
    // what Retry does to THIS one is look for the object again.
    { test: /^file-missing$/, text: () => "The file never landed in storage, so there is nothing here to read. Retry looks again." },
    { test: /^max-retries$/, text: () => "This one tried to book too many times and gave up. Retry sends it back." },
    { test: /^push-paused$/, text: () => "Booking is paused right now, with the switch on this page. Nothing is wrong with this receipt." },
    { test: /^push-disabled$/, text: () => "Booking is switched off in the settings, not with the switch on this page. Nothing is wrong with this receipt." },
    // book.ts's NATIVE_QBO_RECONCILE_REASON and QBO_PURCHASE_MISMATCH_PREFIX.
    // Matched as literals rather than imported: this module is a pure leaf and
    // book.ts carries Prisma and QuickBooks with it.
    {
        // "MAY have started", not "already started": the flag is written just
        // before the network call, so a process that died in between set it
        // with nothing ever sent. See the long note at book.ts's gate.
        test: /^native-qbo-reconciliation-required$/,
        text: () => "A send to QuickBooks may have started for this one, so a purchase may be sitting there. Somebody has to look in QuickBooks first.",
    },
    {
        test: /^qbo-purchase-mismatch:/,
        text: () => "QuickBooks already has this purchase and it does not say what this receipt says. Only a person can pick between the two.",
    },
];

/**
 * The plain-words version of one `stateReason`, or null when there is none.
 *
 * `note()` (worker.ts) appends `;tax-implausible` to whatever routing decided,
 * and `preservedTaxWarning` splits the column on the same `;`, so the code
 * being described is the FIRST segment. Nothing is lost by that: the caller
 * renders `raw` beside the sentence, in full.
 */
export function describeStateReason(
    stateReason: string | null,
    row: ReasonTextRow,
): StateReasonText | null {
    const raw = (stateReason ?? "").trim();
    if (!raw) return null;
    const code = raw.split(";")[0].trim();
    const match = REASON_TEXTS.find(entry => entry.test.test(code));
    // No words for it: show the code itself. Never hide a reason.
    return { headline: match ? match.text(row) : raw, raw };
}
