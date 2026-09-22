/**
 * Does a twin sharing this row's weak key actually block it?
 *
 * The weak key is a coarse hash of `canonicalVendor|date|amount` (keys.ts:109)
 * and it is a FALLBACK identity check — it exists for documents whose OWN
 * identifiers could not be read. It had been given OVERRIDE authority over the
 * strong net: any live twin parked the row, even when both documents carried a
 * real, different, vendor-issued reference number. Three Tapani dump tickets
 * bought on one day for $40 each are three purchases, and the rail could never
 * book any of them.
 *
 * THE CORRECTED INVARIANT:
 *
 *   A weak twin blocks promotion ONLY when the two rows are not already
 *   distinguished by their own reference numbers.
 *
 * `refNumber` is the source, and deliberately NOT `dedupStrongKey`. A weak park
 * RELEASES the strong key — in worker.ts's weak branch and again in the cron's
 * promoteToBooking — so that a corrected resend does not collide with a row
 * that never booked. Every row already parked `weak-dup:` therefore has no
 * strong key left, and so would the SECOND arrival in any group, which means a
 * rule reading that column would answer "cannot tell" for the entire existing
 * backlog and for every third ticket. `refNumber` is written once at read time
 * (worker.ts's `base`) and no park, transition or book path ever nulls it.
 *
 * PURE: no I/O, no clock, no database. Both decision sites — routing and
 * promoteToBooking — run this same function over the same shape, so they cannot
 * reach different verdicts about one group.
 *
 * ONE BOUNDED RESIDUAL, recorded rather than fixed: `sanitize` in keys.ts
 * DELETES non-ASCII characters rather than folding them, so a fullwidth digit
 * would vanish from `refNumber` before it ever reaches this module. Deletion
 * only ever shortens a ref, and the length rule below parks any pair whose
 * lengths differ, so such a pair fails safe. Normalizing upstream would change
 * strong-key derivation for existing rows, which is not worth it for input no
 * US construction supplier produces.
 */
import { refLooksReal } from "./keys";

/** A live row sharing this row's weak key, as the two decision sites fetch it. */
export interface WeakGroupRow {
    id: string;
    refNumber: string | null;
    /** Reserved for phase 2's human override; always null until then. */
    resolution?: string | null;
    /**
     * The row this one was last compared to — ONLY meaningful on `self`, which
     * is why it is optional: a twin's own pointer is a fact about the twin.
     *
     * A row carries a non-null value here exactly when a HUMAN pressed Set job
     * on a review that named that row: routing's `applyRead` writes
     * `duplicateOfId: null`, `unmarkReceiptIntakeDuplicate` clears it, and
     * `setReceiptIntakeJob` keeps it. See `judgeWeakGroup`.
     */
    duplicateOfId?: string | null;
}

/** Bounded: an 11-way weak collision is pathological and goes to a person. */
export const MAX_WEAK_GROUP = 10;

export type WeakVerdict =
    | { kind: "park"; twinId: string }
    | {
        kind: "distinct";
        twinIds: string[];
        /**
         * The ONE twin this verdict did not judge, because a human already did
         * (`self.duplicateOfId`), or null. Reported so the audit row can say
         * whose decision cleared the row rather than claiming the weak net's.
         */
        humanDistinctFrom: string | null;
    };

/**
 * The OCR confusions that actually occur on printed reference numbers, and
 * only those: a letter misread as the digit it looks like.
 *
 * DIGIT-TO-DIGIT IS DELIBERATELY ABSENT. Sequential ticket numbers differ only
 * in their digits (`...862` vs `...886`), so folding `6↔8` or `3↔8` would
 * re-break the exact case this module exists to fix. The price is stated in the
 * spec's risk ledger: a same-purchase pair whose refs differ by a transposed or
 * dropped digit reads as distinct.
 */
const OCR_LETTER_TO_DIGIT: Record<string, string> = {
    O: "0", Q: "0", I: "1", L: "1", S: "5", B: "8", Z: "2", G: "6",
};

/** Uppercase, alphanumerics only, letter-to-digit OCR confusions folded. */
export function confusionNormalizeRef(ref: string | null | undefined): string {
    return String(ref ?? "")
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "")
        .replace(/[OQILSBZG]/g, letter => OCR_LETTER_TO_DIGIT[letter]);
}

/**
 * The SHAPE of a normalized ref: every digit as D, every letter as L.
 *
 * A vendor issues one format. Two refs of the same length whose shapes differ
 * are two different KINDS of number — an order number read off one copy and an
 * invoice number off the other — not one number read twice.
 *
 * ONE PASS, deliberately. The obvious two-pass spelling —
 * `.replace(/[0-9]/g, "D").replace(/[A-Z]/g, "L")` — is broken: "D" is itself
 * in `[A-Z]`, so the second pass rewrites the markers the first one wrote and
 * every input collapses to a run of "L"s. That makes classOf a function of
 * length alone and silently turns this whole guard off.
 */
function classOf(normalized: string): string {
    return normalized.replace(/[0-9A-Z]/g, ch => (ch >= "0" && ch <= "9" ? "D" : "L"));
}

/**
 * True when one ref is plausibly a misread of the other, so they must not be
 * split.
 *
 * FAILS TOWARDS PARK at every step: an empty normalization, an equality, a
 * length difference and a shape difference all answer true. The counter-case
 * this guards is one big-box purchase arriving twice, as an email receipt and a
 * paper photo, with the number read slightly differently on each.
 *
 * Only two refs of the SAME LENGTH and the SAME SHAPE are ever called distinct.
 * That is safe because vendors issue fixed-width refs per format, so two
 * genuine same-day tickets from one vendor match on both. It costs exactly one
 * case: a digit rollover ("999" to "1000") parks. That is the right direction,
 * and it buys the order-number-versus-invoice-number class, which is a real way
 * to read one document twice and conclude it is two.
 */
export function refsAreConfusable(a: string | null | undefined, b: string | null | undefined): boolean {
    const na = confusionNormalizeRef(a);
    const nb = confusionNormalizeRef(b);
    // Nothing left to compare — cannot tell, so park.
    if (!na || !nb) return true;
    // "INV-95870" vs "INV-95B70" collapse to the same string.
    if (na === nb) return true;
    // A truncated read: "95870" vs "9587". Equal lengths also make strict
    // containment impossible, so this subsumes the prefix/suffix rules it
    // replaced rather than sitting beside them.
    if (na.length !== nb.length) return true;
    // Same length, different kind of number.
    if (classOf(na) !== classOf(nb)) return true;
    return false;
}

/**
 * True when this row carries a reference number real enough to identify a
 * document. The SAME predicate that decides whether a strong key may be minted
 * (keys.ts), re-derived from the column rather than from the key itself.
 */
export function hasRealRef(row: WeakGroupRow): boolean {
    return refLooksReal(row.refNumber);
}

/** The pairwise predicate. Symmetric. */
export function twinIsDistinct(self: WeakGroupRow, twin: WeakGroupRow): boolean {
    return hasRealRef(self)
        && hasRealRef(twin)
        && !refsAreConfusable(self.refNumber, twin.refNumber);
}

/**
 * Park unless EVERY twin is distinct. `twins` must exclude `self`.
 *
 * A UNIVERSAL quantifier, not an existential one, and that is the whole point:
 * the old code took the FIRST live twin and parked on it, so a group of three
 * where two are provably different and one is not would have been judged on
 * whichever row the query happened to return first. One twin we cannot separate
 * from this row is enough to need a person.
 *
 * The park verdict names a twin that is NOT distinct, so the `weak-dup:<id>`
 * reason points a reviewer at the row that actually caused the stop.
 *
 * A HUMAN'S STRONG-NET DECISION OUTRANKS THE WEAK NET FOR THE ONE TWIN THEY
 * WERE SHOWN. `self.duplicateOfId` is non-null only when somebody pressed Set
 * job on a review naming that row, so that twin is a collision a person has
 * already ruled on and it is dropped BEFORE anything is judged. Without this the
 * exit the strong net advertises is a lie: the heal (worker.ts `healStrongKey`)
 * honours the override and lets the row through keyless, and then this function
 * parks it `weak-dup:` on the very row the review named — same vendor, same day,
 * same amount, same ref — so every button the human presses loops.
 *
 * EVERY OTHER TWIN IS STILL JUDGED, and the cap is applied to the group AS
 * FETCHED, ahead of the exemption: the exemption is one named row, never a
 * licence to book past a group nobody has fully seen.
 */
export function judgeWeakGroup(self: WeakGroupRow, twins: readonly WeakGroupRow[]): WeakVerdict {
    // More twins than a real weak collision can have. Whatever is going on —
    // a vendor token that over-collapses, a run of identical small purchases —
    // it is not something to decide automatically, so it parks whatever the
    // refs say. The oldest twin is named because that is the order both call
    // sites fetch in, so the reason is stable across passes.
    //
    // COUNTED ON THE GROUP AS FETCHED, BEFORE THE EXEMPTION, because the cap is
    // an OVERFLOW SENTINEL tied to the caller's `take` — promoteToBooking reads
    // `MAX_WEAK_GROUP + 2` rows, self plus up to eleven twins — so a full result
    // means "there may be MORE rows than we fetched" and this view of the group
    // is truncated. Counting what remained after the exemption let one
    // human-ruled twin drop eleven to ten, pass the cap, and decide a group
    // whose twelfth and thirteenth rows — one of them possibly a booked legacy
    // duplicate with an unreadable ref — this function never saw. A human
    // exempting ONE twin is never a reason to decide an over-large, possibly
    // truncated group automatically.
    if (twins.length > MAX_WEAK_GROUP) {
        return { kind: "park", twinId: twins[0].id };
    }
    // Only a twin ACTUALLY IN THIS GROUP is exempt. A `duplicateOfId` pointing
    // at a row that shares no weak key (or has since been voided) names nobody
    // here and changes nothing.
    const exempt = self.duplicateOfId
        ? twins.find(twin => twin.id === self.duplicateOfId) ?? null
        : null;
    const judged = exempt ? twins.filter(twin => twin.id !== exempt.id) : twins;

    for (const twin of judged) {
        if (!twinIsDistinct(self, twin)) return { kind: "park", twinId: twin.id };
    }
    // Includes the no-twins case, which is the ordinary "nothing shares this
    // key" path and reports an empty list rather than a verdict about nobody.
    return {
        kind: "distinct",
        twinIds: judged.map(twin => twin.id),
        humanDistinctFrom: exempt?.id ?? null,
    };
}
