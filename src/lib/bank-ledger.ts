import { createHash } from "node:crypto";

/**
 * Bank ledger persistence (Phase 1 of docs/RECEIPT-AUTOMATION-PHASES.md,
 * "Persistence decision" + Codex peer-review amendments): a durable,
 * append-only BankLine identity per statement transaction, matched by payee
 * TEXT + rails rather than amount+date alone. This module holds the two pure
 * building blocks shared by the ingest endpoint (server-side normalization +
 * hashing) and covered directly by unit tests — no I/O, no Prisma.
 */

/**
 * Uppercases a raw bank descriptor and strips the card-network / POS / ACH
 * "rail" noise (auth codes, masked account tails, phone numbers, SEC codes)
 * so near-identical descriptors for the same vendor collapse to the same
 * normalized string. This is deliberately conservative — it does NOT build a
 * vendor alias/DBA map (that is Phase-2+ scope per the phases doc) — so
 * store numbers, cities, and states are usually left in place.
 */
export function normalizePayee(raw: string): string {
    if (!raw) return "";

    let s = raw.toUpperCase();

    // Descriptors from the PDF activity table are multi-line cells; collapse
    // to a single line before applying the rest of the rules.
    s = s.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();

    // Cut everything from a recognized rail marker onward — the rail
    // metadata (terminal id, auth date/time, location) is never part of the
    // payee's identity.
    const cutMarkers = [
        / POS DEB\b.*$/,
        / POS CRE\b.*$/,
        / DBT CRD\b.*$/,
        / INT FEE\b.*$/,
    ];
    for (const marker of cutMarkers) {
        s = s.replace(marker, "");
    }

    // Masked account tails, e.g. "*****3255001".
    s = s.replace(/\*{3,}\d+/g, "");
    // Explicit card-reference tokens, e.g. "C#6098", "C# 6098".
    s = s.replace(/\bC#\s*\d+\b/g, "");
    // Phone numbers, e.g. "866-483-7521".
    s = s.replace(/\b\d{3}-\d{3}-\d{4}\b/g, "");
    // Standalone dates, e.g. "07/01/26" or "07/01/2026".
    s = s.replace(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, "");
    // Long reference/auth numbers (6+ consecutive digits).
    s = s.replace(/\b\d{6,}\b/g, "");
    // Trailing ACH SEC codes.
    s = s.replace(/\b(CCD|PPD|WEB|TEL|ARC|BOC)\s*$/, "");

    // Asterisks separate a vendor from a sub-merchant/payee name (e.g.
    // "CASH APP*KANDI SNYDER", "PAYPAL *CONSTRUCTIO") — keep both halves,
    // just drop the separator, since for person-to-person rails (Cash App,
    // PayPal) the name after the asterisk is the actual counterparty and
    // must not be discarded (see the Chevron/Cash App wrong-match lesson in
    // docs/RECEIPT-AUTOMATION-PHASES.md).
    s = s.replace(/\*/g, " ");

    s = s.replace(/\s+/g, " ").trim();
    s = s.replace(/[-,.]+$/, "").trim();

    return s;
}

export interface BankLineHashInput {
    account: string;
    /** YYYY-MM-DD */
    postedDate: string;
    /** Signed cents. */
    amountCents: number;
    rawDescriptor: string;
    /** 0-based index of this line among identical (account, postedDate, amountCents, rawDescriptor) lines. */
    occurrenceIndex: number;
}

/**
 * sha256(account|postedDate|amountCents|rawDescriptor|occurrence-index), per
 * the Phase 1 persistence decision — identical same-day duplicates (two
 * $74.00 US Market charges on the same date, for instance) get distinct
 * hashes instead of colliding.
 */
export function computeLineHash(input: BankLineHashInput): string {
    const key = [
        input.account,
        input.postedDate,
        String(input.amountCents),
        input.rawDescriptor,
        String(input.occurrenceIndex),
    ].join("|");
    return createHash("sha256").update(key, "utf8").digest("hex");
}

export interface BankLineIdentity {
    postedDate: string;
    amountCents: number;
    rawDescriptor: string;
}

/**
 * Assigns a stable, request-local occurrence index to every line sharing the
 * same (postedDate, amountCents, rawDescriptor) key, in array order, and
 * derives each line's lineHash from it. Occurrence index is intentionally
 * scoped to the CURRENT batch (not offset by what's already in the
 * database): re-posting the identical, identically-ordered batch reproduces
 * the identical hashes, which is what makes the ingest endpoint's
 * upsert-by-lineHash idempotent on retry.
 */
export function assignLineHashes<T extends BankLineIdentity>(
    account: string,
    lines: T[],
): Array<T & { occurrenceIndex: number; lineHash: string }> {
    const seen = new Map<string, number>();
    return lines.map(line => {
        const key = `${line.postedDate}|${line.amountCents}|${line.rawDescriptor}`;
        const occurrenceIndex = seen.get(key) ?? 0;
        seen.set(key, occurrenceIndex + 1);
        const lineHash = computeLineHash({
            account,
            postedDate: line.postedDate,
            amountCents: line.amountCents,
            rawDescriptor: line.rawDescriptor,
            occurrenceIndex,
        });
        return { ...line, occurrenceIndex, lineHash };
    });
}
