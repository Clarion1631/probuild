/**
 * READING THE SIGNED MEMO FILENAME.
 *
 * Its own module (Codex PR #443 gate round 39, finding 3) because it is pure,
 * it is the part with the sharpest failure mode, and a test that imports it
 * should not have to stand up a route — the answers route pulls in auth, Drive
 * and Prisma at import time.
 */
/**
 * The affidavit generator's own naming contract
 * (PHASE-2-QUEUE-AND-MEMOS-SPEC.md §"Sign flow", verified against
 * `chatAffidavitApp.js:524-573` — a SEPARATE Apps Script repo this route
 * cannot change): `MissingReceiptAffidavit_<date>_<vendor>_<amount>_<name>.pdf`.
 * It carries no fingerprint or bank-line id — Beverly's app never sees either
 * — so the strongest binding available without touching that external script
 * is the DOLLAR AMOUNT field, parsed out at its own fixed position (the third
 * underscore-delimited segment after the prefix) rather than searched for as
 * a substring: `name.includes("12.34")` let a memo named "...112.34..." or
 * "...12.345..." satisfy a $12.34 charge, because the target digits are a
 * substring of a DIFFERENT amount too — prefix or suffix, either way a wrong
 * charge (Codex PR #443 gate round 2 — round 1's fix reintroduced the exact
 * bug it closed, in string form).
 */
const AFFIDAVIT_NAME_PREFIX = "MissingReceiptAffidavit_";

/** The amount field's own shape: digits, a point, exactly two decimal digits. */
const AFFIDAVIT_AMOUNT_FIELD_RE = /^(\d+)\.(\d{2})$/;

/**
 * What counts as the generator having written an amount AT ALL (round-39 gate,
 * finding 3) — any digits-dot-digits field. Deliberately looser than the shape
 * above, because the two questions are different: this one decides whether a
 * cross-check is possible at all, and the strict one decides whether it passes.
 * A name with no money-shaped field anywhere has drifted escaping (a vendor
 * carrying an underscore is the known case); a name whose money field is
 * 12.345 has an amount, and it is the wrong one.
 */
const AFFIDAVIT_MONEYISH_FIELD_RE = /^\d+\.\d+$/;

/**
 * EVERY money-shaped FIELD in the name, as cents (Codex PR #443 gate round 39,
 * finding 3).
 *
 * This used to read `fields[2]` — the amount's position given
 * `<date>_<vendor>_<amount>_<name>.pdf`, on the assumption that date and vendor
 * are exactly one field each. The companion contract guarantees the ORDER and
 * says nothing about the escaping: the affidavit app sanitizes whatever vendor
 * it was handed, and a vendor carrying an underscore ("LOWES_02516", any A_B
 * trade name) shifts every field right — the amount lands at `fields[3]` and
 * this returned the vendor tail instead. Not a near miss: it made
 * `artifact-mismatch` PERMANENT for those charges, so the memo could be
 * re-signed for ever and the answer never changed.
 *
 * So position is not assumed at all. Every field is tested against the strict
 * money shape and the matches returned; the ordinary name carries exactly one,
 * and a vendor that happens to contain one costs a wider net, never a wrong
 * charge — the caller compares for EQUALITY against this charge own amount.
 * Two decimal digits exactly: a truncated or padded amount is the shape a
 * wrong-charge memo takes.
 */
function affidavitAmountFields(name: string): { moneyish: number; cents: number[] } {
    const stem = name.slice(AFFIDAVIT_NAME_PREFIX.length).replace(/\.pdf$/i, "");
    const cents: number[] = [];
    let moneyish = 0;
    for (const field of stem.split("_")) {
        if (!AFFIDAVIT_MONEYISH_FIELD_RE.test(field)) continue;
        moneyish++;
        const match = AFFIDAVIT_AMOUNT_FIELD_RE.exec(field);
        if (match) cents.push(Number(match[1]) * 100 + Number(match[2]));
    }
    return { moneyish, cents };
}

/**
 * True when a probed Drive filename could plausibly BE the signed memo for
 * THIS charge, rather than some other PDF the bridge secret happens to be
 * able to read.
 *
 * `signed:true` plus a Drive id that merely EXISTS used to be enough to close
 * a chase — nothing tied the artifact to the charge it claims to answer
 * (Codex PR #443 gate, finding 3). The PREFIX is still verification: a file
 * without it was never produced by the sign flow at all.
 *
 * THE AMOUNT IS A SECONDARY CHECK NOW (round-39 gate, finding 3). Since round
 * 38 an answer must carry `{thread, n, request_id}` and match a card record on
 * THIS issue, and that is what binds a memo to the ask; the filename is a
 * format this route does not own and cannot pin down. So the rule is
 * asymmetric, deliberately:
 *
 *   * a name carrying money fields, none of which is this charge amount, is
 *     REFUSED — positive evidence of a memo minted for another charge;
 *   * a name carrying NO money field at all is ACCEPTED on the association,
 *     because "the vendor had an underscore" and "this is the wrong memo" are
 *     not the same fact, and refusing the first made the chase unanswerable.
 *
 * The caller records the second case where an operator can see it.
 */
export type AffidavitNameVerdict = "match" | "mismatch" | "unparseable";

export function affidavitNameVerdict(name: string | null, amountCents: number): AffidavitNameVerdict {
    if (!name) return "mismatch";
    if (!name.toLowerCase().endsWith(".pdf")) return "mismatch";
    if (!name.startsWith(AFFIDAVIT_NAME_PREFIX)) return "mismatch";
    const fields = affidavitAmountFields(name);
    // Nothing money-shaped anywhere: there is no amount to compare, so the
    // card association is the whole binding. Accepted, and reported.
    if (fields.moneyish === 0) return "unparseable";
    // Something IS an amount. It has to be THIS charge's, spelled exactly.
    return fields.cents.includes(Math.abs(amountCents)) ? "match" : "mismatch";
}
