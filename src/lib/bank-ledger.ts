import { createHash } from "node:crypto";

/**
 * Bank ledger persistence (Phase 1 of docs/RECEIPT-AUTOMATION-PHASES.md,
 * "Persistence decision" + Codex peer-review round-1 amendments): a durable,
 * append-only BankLine identity per statement transaction (the statement is
 * true north), matched by payee TEXT + rails rather than amount+date alone.
 * This module holds the pure building blocks shared by the ingest endpoint
 * (normalization, hashing, validation, reconciliation) and covered directly
 * by unit tests — no I/O, no Prisma.
 */

// ── Payee normalization ──────────────────────────────────────────────────

/**
 * Uppercases a raw bank descriptor and strips the card-network / POS / ACH
 * "rail" noise (auth codes, masked account tails, phone numbers, SEC codes)
 * so near-identical descriptors for the same vendor collapse to the same
 * normalized string. This is deliberately conservative — it does NOT build a
 * vendor alias/DBA map (that is Phase-2+ scope per the phases doc) — so
 * store numbers, cities, and states are usually left in place.
 *
 * Can return "" for a descriptor consisting entirely of stripped rail
 * metadata. Callers must not treat "" as a normal identity — the ingest
 * route flags it EXCEPTION rather than persisting a silently-empty payee.
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

// ── Versioned content hashing ────────────────────────────────────────────

/**
 * sha256(JSON.stringify([1, ...fields])) — a versioned, unambiguous
 * encoding. Replaces the earlier delimiter-joined ("|"-joined) hash, which
 * could produce deterministic serialization collisions for arbitrary
 * account/descriptor strings that themselves contain the delimiter. JSON
 * escapes strings, so no field can bleed into its neighbor, and the leading
 * version tag lets the encoding change later without silently colliding with
 * hashes computed under the old encoding.
 */
export function versionedHash(fields: unknown[]): string {
    return createHash("sha256").update(JSON.stringify([1, ...fields]), "utf8").digest("hex");
}

export interface StatementContentHashInput {
    account: string;
    /** YYYY-MM-DD */
    periodStart: string;
    /** YYYY-MM-DD */
    periodEnd: string;
    openingCents: number;
    closingCents: number;
    lines: Array<{
        postedDate: string;
        amountCents: number;
        rawDescriptor: string;
        checkNumber: string | null;
    }>;
}

/**
 * Content-addresses a full statement import: same account, period, balances,
 * and lines (in the same order) always produce the same hash. This is what
 * lets the ingest route treat a retried POST of the identical statement as a
 * no-op, and a differently-parsed or corrected statement for the same
 * account+period as a conflict (HTTP 409) rather than a silent overwrite.
 */
export function computeStatementContentHash(input: StatementContentHashInput): string {
    return versionedHash([
        input.account,
        input.periodStart,
        input.periodEnd,
        input.openingCents,
        input.closingCents,
        input.lines.map(l => [l.postedDate, l.amountCents, l.rawDescriptor, l.checkNumber]),
    ]);
}

export interface QboLineContentHashInput {
    /** YYYY-MM-DD */
    postedDate: string;
    amountCents: number;
    rawDescriptor: string;
    checkNumber: string | null;
}

/**
 * Content-addresses a single QBO register line (everything about it EXCEPT
 * its durable identity, qbTxnId). Two sightings of the same qbTxnId with the
 * same hash are the same observation retried; a different hash under the
 * same qbTxnId is a conflict — QuickBooks never legitimately reassigns a
 * transaction id to different content, so that can only mean the puller
 * re-sent a corrected/edited row (or two different transactions collided on
 * an id), and either way the ingest route must reject it (409) rather than
 * silently keep the first-seen version or overwrite it.
 */
export function computeQboLineContentHash(input: QboLineContentHashInput): string {
    return versionedHash([input.postedDate, input.amountCents, input.rawDescriptor, input.checkNumber]);
}

// ── Validation helpers ────────────────────────────────────────────────────

/** Postgres INTEGER (int4) bounds — the column type backing every *Cents field. */
export const INT4_MIN = -2147483648;
export const INT4_MAX = 2147483647;

/** Number.isSafeInteger AND within Postgres INTEGER bounds. */
export function isSafeCents(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= INT4_MIN && value <= INT4_MAX;
}

/**
 * True Gregorian-calendar validation for a "YYYY-MM-DD" string — rejects
 * shapes the `^\d{4}-\d{2}-\d{2}$` regex alone would let through, such as
 * "2026-02-31" (JavaScript's Date silently rolls that over to March 3rd,
 * while the string — and therefore the hash/identity — still says the 31st).
 * Also rejects an implausible year so a swapped digit doesn't produce a
 * "valid" date a century away.
 */
export function isValidCalendarDate(value: unknown): value is string {
    if (typeof value !== "string") return false;
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return false;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (year < 1900 || year > 2100) return false;
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

// ── Statement semantic validation ────────────────────────────────────────

export interface StatementSemanticsInput {
    /** YYYY-MM-DD */
    periodStart: string;
    /** YYYY-MM-DD */
    periodEnd: string;
    openingCents: number;
    closingCents: number;
    lines: Array<{
        /** YYYY-MM-DD */
        postedDate: string;
        amountCents: number;
    }>;
}

export interface StatementSemanticsFailure {
    reason: "line-date-outside-period" | "balance-mismatch";
    index?: number;
    detail: string;
}

/**
 * Statement-level sanity checks that the per-field validators in the ingest
 * route can't catch on their own: every line's shape can be individually
 * valid (a real calendar date, an int4-safe amount) while the STATEMENT as a
 * whole is still wrong — a line dated outside the statement's own period, or
 * a set of lines whose signed sum doesn't reconcile openingCents to
 * closingCents. Both are checked (not just the first) so the route can
 * report every problem in one pass; the caller decides what to do with a
 * non-empty result (the ingest route rejects with 400 before writing
 * anything).
 */
export function validateStatementSemantics(input: StatementSemanticsInput): StatementSemanticsFailure[] {
    const failures: StatementSemanticsFailure[] = [];

    input.lines.forEach((line, index) => {
        if (line.postedDate < input.periodStart || line.postedDate > input.periodEnd) {
            failures.push({
                reason: "line-date-outside-period",
                index,
                detail: `line ${index} postedDate ${line.postedDate} falls outside statement period ${input.periodStart}..${input.periodEnd}`,
            });
        }
    });

    const sumCents = input.lines.reduce((sum, l) => sum + l.amountCents, 0);
    const expectedClosingCents = input.openingCents + sumCents;
    if (expectedClosingCents !== input.closingCents) {
        failures.push({
            reason: "balance-mismatch",
            detail: `openingCents ${input.openingCents} + sum(lines) ${sumCents} = ${expectedClosingCents}, statement says closingCents ${input.closingCents}`,
        });
    }

    return failures;
}

// ── Cross-source reconciliation ──────────────────────────────────────────

export interface ReconcileObservation {
    id: string;
    account: string;
    /** YYYY-MM-DD */
    postedDate: string;
    amountCents: number;
    /** normalizePayee(rawDescriptor) — computed by the caller, never "" trusted as an identity (see below). */
    normalizedPayee: string;
    checkNumber: string | null;
    bankLineId: string | null;
}

export interface ReconcileBankLine {
    id: string;
    account: string;
    /** YYYY-MM-DD */
    postedDate: string;
    amountCents: number;
    normalizedPayee: string;
    checkNumber: string | null;
}

export interface ReconcileLink {
    observationId: string;
    bankLineId: string;
}

function reconcileKey(row: { account: string; postedDate: string; amountCents: number; normalizedPayee: string; checkNumber: string | null }): string {
    // JSON-encoded (not delimiter-joined) for the same reason versionedHash()
    // is — an account/payee string containing "|" must never collide with a
    // different field split across the delimiter.
    return JSON.stringify([row.account, row.postedDate, row.amountCents, row.normalizedPayee, row.checkNumber]);
}

/**
 * Links not-yet-reconciled observations (bankLineId === null — in practice
 * always QBO_REGISTER, since STATEMENT observations get their canonical
 * BankLine at ingest time) to a canonical BankLine by an EXACT
 * account+postedDate+amountCents+normalizedPayee match, and — when either
 * side carries one — an exact checkNumber match too (a check-numbered
 * observation and a check-numbered candidate with DIFFERENT numbers can
 * never be the same transaction, even if everything else lines up).
 * Amount+date alone is zero confidence (see the Chevron/Cash App
 * wrong-match lesson in docs/RECEIPT-AUTOMATION-PHASES.md) — two
 * transactions for different payees on the same account/day for the same
 * amount now sort into different match keys entirely and are never
 * cross-matched. An empty normalizedPayee ("" — the EXCEPTION case; see
 * normalizePayee()) is never treated as a valid identity on either side, so
 * it can never match anything here either.
 *
 * One canonical line can only absorb one observation and vice versa
 * (first-match-wins in input order within a key). A key with more
 * observations than candidate lines leaves the excess unmatched rather than
 * guessing which one is "really" the match — but note that isn't the same
 * as ambiguity: every remaining pairing under a shared key is still a fully
 * qualified match (same account/date/amount/payee/check#), just with
 * insufficient supply on one side.
 */
export function reconcileObservations(
    observations: ReconcileObservation[],
    bankLines: ReconcileBankLine[],
): ReconcileLink[] {
    const available = new Map<string, string[]>();
    for (const line of bankLines) {
        if (line.normalizedPayee === "") continue;
        const key = reconcileKey(line);
        const ids = available.get(key);
        if (ids) ids.push(line.id);
        else available.set(key, [line.id]);
    }

    const links: ReconcileLink[] = [];
    for (const obs of observations) {
        if (obs.bankLineId !== null) continue;
        if (obs.normalizedPayee === "") continue;
        const key = reconcileKey(obs);
        const ids = available.get(key);
        if (!ids || ids.length === 0) continue;
        const bankLineId = ids.shift()!;
        links.push({ observationId: obs.id, bankLineId });
    }
    return links;
}

// ── Refund sign validation ───────────────────────────────────────────────

export interface RefundSignCheckLine {
    amountCents: number;
}

export type RefundSignCheckResult = { ok: true } | { ok: false; reason: string };

/**
 * Application-layer mirror of the `refund_event_signs_trigger` DB trigger
 * (scripts/apply-bank-ledger.mjs): a RefundEvent pairs a debit (the
 * original charge leaving the account, negative amountCents) with a credit
 * (the refund itself landing back in the account, positive amountCents).
 * Any future code path that creates or updates a RefundEvent must call this
 * BEFORE writing, so a swapped pairing surfaces as a normal validation
 * error rather than a raised Postgres exception from the trigger — the
 * trigger is the backstop of last resort, not the primary UX.
 */
export function validateRefundEventSigns(
    original: RefundSignCheckLine | null,
    refund: RefundSignCheckLine | null,
): RefundSignCheckResult {
    if (original && original.amountCents >= 0) {
        return { ok: false, reason: "originalBankLineId must reference a debit BankLine (amountCents < 0)" };
    }
    if (refund && refund.amountCents <= 0) {
        return { ok: false, reason: "refundBankLineId must reference a credit BankLine (amountCents > 0)" };
    }
    return { ok: true };
}
