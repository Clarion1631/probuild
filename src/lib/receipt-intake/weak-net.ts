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
 */
import { refLooksReal } from "./keys";

/** A live row sharing this row's weak key, as the two decision sites fetch it. */
export interface WeakGroupRow {
    id: string;
    refNumber: string | null;
    /** Reserved for phase 2's human override; always null until then. */
    resolution?: string | null;
}

/** Bounded: an 11-way weak collision is pathological and goes to a person. */
export const MAX_WEAK_GROUP = 10;

export type WeakVerdict =
    | { kind: "park"; twinId: string }
    | { kind: "distinct"; twinIds: string[] };

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
 * True when one ref is plausibly a misread of the other, so they must not be
 * split.
 *
 * FAILS TOWARDS PARK at every step: an empty normalization, an equality, or
 * either kind of containment all answer true. The counter-case this guards is
 * one big-box purchase arriving twice, as an email receipt and a paper photo,
 * with the number read slightly differently on each.
 */
export function refsAreConfusable(a: string | null | undefined, b: string | null | undefined): boolean {
    const na = confusionNormalizeRef(a);
    const nb = confusionNormalizeRef(b);
    // Nothing left to compare — cannot tell, so park.
    if (!na || !nb) return true;
    // "INV-95870" vs "INV-95B70" collapse to the same string.
    if (na === nb) return true;
    // A truncated read: "95870" vs "9587", either end.
    if (na.startsWith(nb) || nb.startsWith(na)) return true;
    if (na.endsWith(nb) || nb.endsWith(na)) return true;
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
 */
export function judgeWeakGroup(self: WeakGroupRow, twins: readonly WeakGroupRow[]): WeakVerdict {
    // More twins than a real weak collision can have. Whatever is going on —
    // a vendor token that over-collapses, a run of identical small purchases —
    // it is not something to decide automatically, so it parks whatever the
    // refs say. The oldest twin is named because that is the order both call
    // sites fetch in, so the reason is stable across passes.
    if (twins.length > MAX_WEAK_GROUP) {
        return { kind: "park", twinId: twins[0].id };
    }
    for (const twin of twins) {
        if (!twinIsDistinct(self, twin)) return { kind: "park", twinId: twin.id };
    }
    // Includes the no-twins case, which is the ordinary "nothing shares this
    // key" path and reports an empty list rather than a verdict about nobody.
    return { kind: "distinct", twinIds: twins.map(twin => twin.id) };
}
