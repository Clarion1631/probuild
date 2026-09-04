/**
 * Dedup keys — a VERBATIM port of the v3.6 Apps Script logic in
 * qbo-clasp/runReceiptAutomation.js. Line references below point at that file.
 *
 * These functions decide whether two documents are the same purchase. During
 * the shadow week v1 (Apps Script) and v2 (this) must agree on every archived
 * file, so the rules are ported as-is rather than "improved" — a cleaner rule
 * that disagrees is a regression, not a fix.
 *
 * Pure: no I/O, no clock, no database. Everything here is unit-tested against
 * real August archive filenames (tests/receipt-intake-keys.test.ts).
 */

/** :1478 — strip punctuation, collapse whitespace to underscores. */
export function sanitize(str: unknown): string {
    if (!str) return "";
    return String(str).replace(/[^\w\s\-.]/gi, "").replace(/\s+/g, "_").trim();
}

/** :1494 — pull a clean YYYY-MM-DD out of the AI's date string (accepts an ISO timestamp). */
export function normalizeDateStr(s: unknown): string {
    const m = String(s ?? "").trim().match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : "";
}

/** :1500 — real calendar-date check (rejects 2026-13-05, 2026-02-30). */
export function isValidDate(s: unknown): boolean {
    const value = String(s ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const p = value.split("-");
    const y = parseInt(p[0], 10), m = parseInt(p[1], 10), d = parseInt(p[2], 10);
    const dt = new Date(y, m - 1, d);
    return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

/** :1519 — handles "$1,234.56", "-12.50" and accounting negatives "(123.45)". */
export function cleanMoney(v: unknown): string {
    let s = String(v === undefined || v === null ? "" : v).trim();
    const paren = /^\(.*\)$/.test(s);
    s = s.replace(/[^0-9.\-]/g, "");
    let n = parseFloat(s);
    if (isNaN(n) || !isFinite(n)) return "0.00";
    if (paren && n > 0) n = -n;
    return n.toFixed(2);
}

/**
 * :1578 — values that are the AI's way of saying "I couldn't find a number".
 * "INV"/"ORDER"/"REF" are deliberately NOT here: they legitimately prefix real
 * numbers ("INV-95870" must stay authoritative).
 */
export const REF_PLACEHOLDERS = [
    "na", "none", "null", "nil", "no", "noinv", "noinvoice", "nonum",
    "unknown", "unk", "blank", "notavailable", "nodata", "notfound",
    "tbd", "missing", "pending", "illegible", "unreadable",
];

/**
 * :1581 — does this look like a real invoice/check number? Load-bearing since
 * v3.6: the vendor no longer separates the namespaces, so a placeholder would
 * make "2026-07-21|na" the SHARED key of every unrelated receipt that day and
 * silently quarantine real expenses against each other. Rejecting here is only
 * a DOWNGRADE, never a loss — the document still goes through the weak net,
 * which asks a human instead of deciding on its own.
 */
export function refLooksReal(ref: unknown): boolean {
    const r = String(ref ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
    if (r.length < 3) return false;                        // too short to identify anything
    const digits = r.replace(/[^0-9]/g, "");
    if (!digits) return false;                             // every real invoice/check # has digits
    const letters = r.replace(/[^a-z]/g, "");
    if (letters && REF_PLACEHOLDERS.indexOf(letters) > -1) return false;
    return !/^(.)\1*$/.test(digits);                       // "0000" identifies nothing
}

/**
 * :1609 — one vendor -> one token. A substring hit wins, so an unlucky entry
 * can over-collapse two real vendors ("Palace Hardware" would match
 * "acehardware"). Deliberately tolerable: this token feeds ONLY the weak key,
 * whose worst outcome is asking a human — never a silent quarantine.
 */
export const VENDOR_ALIASES = [
    "lowes", "homedepot", "amazon", "costco", "walmart", "safeway", "fredmeyer",
    "officedepot", "acehardware", "harborfreight", "sherwinwilliams", "dutch",
    "usmarket", "spaceage", "irongate", "sunbelt", "valvoline", "rtastore",
    "unitedbuilding", "parrlumber", "lesschwab", "jiffylube",
];

/** :1615 */
export function canonicalVendor(vendor: unknown): string {
    const v = String(vendor ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
    for (let i = 0; i < VENDOR_ALIASES.length; i++) {
        if (v.indexOf(VENDOR_ALIASES[i]) > -1) return VENDOR_ALIASES[i];
    }
    return v;
}

/**
 * :1558 — date|invoice(or check#). The VENDOR and the AMOUNT stay OUT of this
 * key on purpose (rationale at :1545–1557): the AI reads a chain's name
 * differently across that chain's own formats, and a misread total must still
 * let both copies collapse onto one key.
 */
export function makeStrongDedupKey(date: string, ref: string): string {
    return [String(date ?? ""), String(ref ?? "").toLowerCase()].join("|");
}

/** :1598 — second net: canonical vendor|date|amount. Built for EVERY document. */
export function makeWeakDedupKey(vendor: unknown, date: string, amount: string): string {
    return [canonicalVendor(vendor), String(date ?? ""), String(amount ?? ""), "amt"].join("|");
}

/** What dedupKeys() needs off a read document. Mirrors the Apps Script's cleaned locals. */
export interface DedupKeyInput {
    /** "check" routes the ref through checkNumber; anything else uses `invoice`. */
    docType?: string | null;
    vendor?: string | null;
    /** The date AS READ off the document — NOT the fallback. */
    date?: string | null;
    invoice?: string | null;
    checkNumber?: string | null;
    /** Raw total from the reader; cleaned here with cleanMoney. */
    totalAmount?: string | number | null;
    /**
     * Date to use when the document's own date is unreadable — the intake
     * row's createdAt date. v1 used the Drive UPLOAD date (:1509); same
     * semantic, since the intake row is created when the file arrives.
     */
    fallbackDateStr: string;
}

export interface DedupKeys {
    /** Non-null ONLY when the date came off the document AND the ref passes refLooksReal. */
    strong: string | null;
    /** Always built. */
    weak: string;
    /** The date actually used (document date, else fallback) — what the row stores. */
    dateStr: string;
    /** The cleaned ref: "Check<num>" for checks, the cleaned invoice otherwise. */
    ref: string;
    /** cleanMoney output, 2dp. */
    amount: string;
}

/**
 * Port of processSingleFile steps 2 and 4 (:512–:530, :559+): clean the read,
 * then build both keys.
 *
 * The strong key is withheld (null) unless BOTH halves were read off the
 * document. That is the v3.6 rule and it is the reason a placeholder ref can
 * never quarantine unrelated receipts against each other.
 */
export function dedupKeys(input: DedupKeyInput): DedupKeys {
    const isCheck = String(input.docType ?? "receipt").toLowerCase() === "check";

    const aiDate = normalizeDateStr(input.date);
    const dateReadOffDocument = isValidDate(aiDate);
    const dateStr = dateReadOffDocument ? aiDate : input.fallbackDateStr;

    const checkNum = sanitize(input.checkNumber) || "NoNum";
    const ref = isCheck ? `Check${checkNum}` : (sanitize(input.invoice) || "NoInv");
    const amount = cleanMoney(input.totalAmount);

    const strong = dateReadOffDocument && refLooksReal(ref)
        ? makeStrongDedupKey(dateStr, ref)
        : null;

    return {
        strong,
        weak: makeWeakDedupKey(input.vendor, dateStr, amount),
        dateStr,
        ref,
        amount,
    };
}
