/**
 * Minting canonical BankLines from QBO register observations, and adopting
 * those lines when the statement finally arrives.
 *
 * THE DECISION THIS IMPLEMENTS (Justin, decision 3): the QBO bank feed is bank
 * truth. Before this, a canonical `BankLine` was minted ONLY from a STATEMENT
 * observation, so nothing existed to chase until the monthly statement import
 * ran — a 3-day receipt chase was in practice a 30-day one. QBO register rows
 * now mint their own canonical line.
 *
 * WHAT THAT COSTS, AND HOW IT IS PAID. The old rule bought one thing: exactly
 * one canonical line per real transaction. Mint from two sources and you can
 * get two lines for one transaction — the dual-identity problem the Phase 2
 * spec's risk 1 flagged. So minting is paired with ADOPTION: when the statement
 * observation arrives and matches an existing QBO-minted line exactly, the
 * ingest attaches to that line and flips `sourceOfRecord` to STATEMENT rather
 * than minting a second one. The two orders (QBO first, statement first) must
 * converge on one line, and re-running either must change nothing.
 *
 * Both functions here are PURE. The caller supplies rows and `now`; the caller
 * does the writes.
 *
 * CARDINALITY, NOT PRESENCE. An identity key is not unique: this business
 * genuinely buys the same thing from the same merchant twice on the same day.
 * So "does a line with this key exist?" is the wrong question and produced the
 * wrong answer — two same-key QBO transactions minted ONE line and the second
 * charge silently vanished from the ledger. The question is "are there more
 * UNLINKED canonical lines with this key than observations already claiming
 * them?", and the planners below count rather than test membership.
 *
 * CONCURRENCY. Planning reads the world and then writes to it, so two runs can
 * both plan against the same gap and both mint. Both write paths — the nightly
 * mint and the statement ingest — take
 * `pg_advisory_xact_lock(hashtext('bank-line-identity'))` and PLAN INSIDE that
 * transaction, so identity decisions are serialized against each other. The
 * lock is transaction-scoped (pgbouncer forbids session locks) and is held only
 * across the planning read plus its writes.
 *
 * WHAT IS STILL NOT HANDLED, stated plainly rather than left to be discovered:
 *   - A QuickBooks RESTATEMENT after minting. If QBO edits the amount or date
 *     of a row we already minted a line from, the observation conflicts (409)
 *     but the minted BankLine keeps the old figures, and `amountCents` is
 *     immutable by trigger. A human resolves it; nothing here rewrites a
 *     canonical line.
 *   - A QBO row that is later DELETED in QuickBooks leaves its minted line
 *     behind. It stays visible as sourceOfRecord="QBO" with no statement
 *     backing, which is the honest state, but nothing reaps it.
 *   - SPLIT postings that QBO reports as one row and the bank as two (or the
 *     reverse) will not adopt — the identities differ — so the statement mints
 *     its own line and the QBO one lingers.
 * All three are why BANK_LINE_MINT_FROM_QBO defaults OFF and why the statement
 * remains the source that gets to say how many transactions there were.
 *
 * MATCH IDENTITY is deliberately the SAME key `reconcileObservations` uses —
 * account + postedDate + amountCents + normalizedPayee, plus checkNumber
 * agreement — so a line that adoption considers "the same transaction" is the
 * same one reconcile would link. Two different identity rules over one ledger
 * is how you get a line that adopts here and stays unreconciled there.
 * An empty normalizedPayee is NOT an identity (bank-ledger's rule) and never
 * mints and never adopts.
 */
import { normalizePayee } from "./bank-ledger";

/**
 * How old a QBO row must be before it may mint. QuickBooks shows pending and
 * recently-posted rows that can still be edited or removed; minting one
 * immediately would create a canonical line for a transaction that may never
 * settle. Two days is the same "let it settle" instinct as the matcher's
 * three-day grace, one notch tighter because minting is reversible only by a
 * human.
 */
export const QBO_MINT_MIN_AGE_DAYS = 2;

/**
 * The advisory-lock key both write paths take. ONE string, exported, because
 * two paths locking on two spellings of the same intent is the same as not
 * locking at all.
 */
export const BANK_LINE_IDENTITY_LOCK = "bank-line-identity";

/**
 * QuickBooks transaction-type words the register pull APPENDS to the payee.
 *
 * `registerRowToIngestLine` builds "LOWES #02516 Expense" so two otherwise
 * identical GL rows stay distinguishable. The bank statement for the same
 * charge normalizes to "LOWES #02516". Exact-identity matching then missed
 * every time — reconcile found nothing, adoption found nothing, and minting
 * produced a twin for a transaction the statement had already recorded. The
 * convergence tests passed only because their fixtures used matching payees.
 *
 * Longest-first, so "SALES TAX PAYMENT" is not eaten as "PAYMENT".
 */
const QBO_TYPE_SUFFIX =
    /\s+(?:SALES TAX PAYMENT|CREDIT CARD (?:CREDIT|EXPENSE|PURCHASE|REFUND)|BILL PAYMENT|JOURNAL ENTRY|REFUND RECEIPT|VENDOR CREDIT|CASH PURCHASE|EXPENDITURE|DEPOSIT|TRANSFER|PURCHASE|PAYMENT|EXPENSE|REFUND|CREDIT|CHECK|BILL)$/;

/**
 * THE identity payee. Both sides of every comparison run this, and that
 * symmetry is the point — not the specific words stripped.
 *
 * It is `normalizePayee` (rail markers, card refs, phones, dates, long refs)
 * plus the appended QBO type. A statement descriptor ending in one of those
 * words loses it too, which is harmless precisely BECAUSE both sides are
 * treated identically: they still land on the same key. Identity also carries
 * account, date, amount and check number, so a slightly shorter payee cannot
 * collapse two genuinely different transactions on its own.
 */
export function identityPayee(rawDescriptor: string): string {
    return normalizePayee(rawDescriptor ?? "").replace(QBO_TYPE_SUFFIX, "").trim();
}

export interface MintCandidateObservation {
    id: string;
    account: string;
    /** YYYY-MM-DD. */
    postedDate: string;
    amountCents: number;
    rawDescriptor: string;
    normalizedPayee: string;
    checkNumber: string | null;
    /** Non-null means it is already linked to a canonical line. */
    bankLineId: string | null;
}

export interface ExistingBankLine {
    id: string;
    /** Used ONLY to order same-identity candidates deterministically. */
    qbTxnId?: string | null;
    account: string;
    postedDate: string;
    amountCents: number;
    normalizedPayee: string;
    checkNumber: string | null;
    sourceOfRecord: string;
}

export interface MintPlan {
    /** Observations that should mint a new canonical line, and link to it. */
    mint: MintCandidateObservation[];
    /** Why the rest were left alone — counts only, for the cron's summary. */
    skipped: {
        alreadyLinked: number;
        tooRecent: number;
        emptyPayee: number;
        statementLineExists: number;
        duplicateWithinBatch: number;
    };
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;

function dayNumber(ymd: string): number | null {
    if (!YMD.test(ymd)) return null;
    const t = Date.parse(`${ymd}T00:00:00Z`);
    if (!Number.isFinite(t)) return null;
    if (new Date(t).toISOString().slice(0, 10) !== ymd) return null; // "2026-02-30"
    return Math.round(t / 86_400_000);
}

/**
 * The identity key, JSON-encoded rather than delimiter-joined for the same
 * reason `reconcileKey` is: a payee containing the delimiter must never
 * collide with a different field split across it.
 */
export function bankLineIdentityKey(row: {
    account: string;
    postedDate: string;
    amountCents: number;
    normalizedPayee: string;
    checkNumber: string | null;
}): string {
    return JSON.stringify([row.account, row.postedDate, row.amountCents, row.normalizedPayee, row.checkNumber]);
}

/**
 * Which unlinked QBO observations should mint a canonical line.
 *
 * A candidate must be unlinked, at least `QBO_MINT_MIN_AGE_DAYS` calendar days
 * old, carry a real payee identity, and have NO existing line on the same
 * identity — of either source. "Of either source" is load-bearing: an existing
 * QBO-minted line means a previous run already did this (so a re-run mints
 * nothing, which is the idempotency promise), and an existing STATEMENT line
 * means the statement beat us to it and reconcile will link the observation to
 * it instead.
 *
 * Two observations sharing one identity inside a single batch mint ONCE. The
 * second is reported as a duplicate rather than minting a twin, because the
 * whole point of this module is that one transaction has one canonical line.
 */
export function planQboMint(
    observations: readonly MintCandidateObservation[],
    existingLines: readonly ExistingBankLine[],
    now: Date,
): MintPlan {
    const plan: MintPlan = {
        mint: [],
        skipped: { alreadyLinked: 0, tooRecent: 0, emptyPayee: 0, statementLineExists: 0, duplicateWithinBatch: 0 },
    };
    const todayDay = dayNumber(now.toISOString().slice(0, 10));

    // COUNTS, not membership. Two identical charges on one day are two real
    // transactions; testing "does a line with this key exist" made the second
    // one disappear. `available` is how many canonical lines with this identity
    // are still unclaimed by an observation.
    const available = new Map<string, number>();
    for (const line of existingLines) {
        if (line.normalizedPayee === "") continue;
        const key = bankLineIdentityKey(line);
        available.set(key, (available.get(key) ?? 0) + 1);
    }
    // An observation that is ALREADY linked has consumed one of those lines.
    for (const obs of observations) {
        if (obs.bankLineId === null) continue;
        if (obs.normalizedPayee === "") continue;
        const key = bankLineIdentityKey(obs);
        const left = available.get(key);
        if (left !== undefined && left > 0) available.set(key, left - 1);
    }

    for (const obs of observations) {
        if (obs.bankLineId !== null) { plan.skipped.alreadyLinked++; continue; }
        if (obs.normalizedPayee === "") { plan.skipped.emptyPayee++; continue; }

        const day = dayNumber(obs.postedDate);
        if (day === null || todayDay === null || todayDay - day < QBO_MINT_MIN_AGE_DAYS) {
            plan.skipped.tooRecent++;
            continue;
        }

        const key = bankLineIdentityKey(obs);
        const left = available.get(key) ?? 0;
        if (left > 0) {
            // A canonical line for this transaction already exists and is free.
            // Reconcile links it; minting here would be the twin.
            available.set(key, left - 1);
            plan.skipped.statementLineExists++;
            continue;
        }
        // No unclaimed line left for this identity — this observation is a
        // transaction nothing in the ledger accounts for yet. Two same-key QBO
        // observations therefore mint TWO lines, which is the point.
        plan.mint.push(obs);
    }

    // Telemetry only, and it must be TRUE: how many of the minted rows share an
    // identity with another minted row in the same batch. Previously this
    // counter existed and never incremented, which is worse than not having it.
    const mintedByKey = new Map<string, number>();
    for (const obs of plan.mint) {
        const key = bankLineIdentityKey(obs);
        const seen = mintedByKey.get(key) ?? 0;
        if (seen > 0) plan.skipped.duplicateWithinBatch++;
        mintedByKey.set(key, seen + 1);
    }

    return plan;
}

// ── Statement adoption ───────────────────────────────────────────────────────

export interface StatementLineForAdoption {
    /** The line's durable in-statement position. */
    sequence: number;
    postedDate: string;
    amountCents: number;
    normalizedPayee: string;
    checkNumber: string | null;
}

export interface AdoptionPlan {
    /** sequence -> the QBO-minted BankLine id this statement line adopts. */
    adopt: Map<number, string>;
    /** Sequences that mint a fresh canonical line, as they always did. */
    mint: number[];
    /**
     * Identities where the statement reported MORE lines than QBO did, so some
     * of them had no line to adopt and minted. Reported for visibility, not as
     * a failure — see the pairing rule in planStatementAdoption.
     */
    ambiguous: string[];
}

/**
 * Decide, for one incoming statement, which lines adopt an existing QBO-minted
 * canonical line and which mint a fresh one.
 *
 * Only `sourceOfRecord === "QBO"` lines are adoptable. A STATEMENT line is
 * already the real thing; adopting one would silently merge two genuinely
 * distinct transactions that happen to share an identity (the same-amount,
 * same-day, same-payee case a statement legitimately can contain twice), and
 * the statement is the source that gets to say how many there were.
 *
 * That is also why ambiguity mints: two identical statement lines against one
 * adoptable QBO line means QBO under-reported, so exactly one of them should
 * adopt and there is no basis to say which. Minting both is wrong in a
 * recoverable way (a stale QBO line remains, visible); adopting arbitrarily is
 * wrong in a way nobody can see.
 */
export function planStatementAdoption(
    statementLines: readonly StatementLineForAdoption[],
    adoptableLines: readonly ExistingBankLine[],
    account: string,
): AdoptionPlan {
    const plan: AdoptionPlan = { adopt: new Map(), mint: [], ambiguous: [] };

    // Candidates per identity, in a DETERMINISTIC order. Previously an N:N
    // group refused to pair at all and minted a third line — which left the
    // QBO line orphaned AND created the duplicate the whole feature exists to
    // prevent. Two same-key statement lines against two same-key QBO lines are
    // two transactions matched by two records; the only real question is which
    // pairs with which, and for identical rows that question has no observable
    // answer. So pair by sorted qbTxnId (falling back to the line id, which is
    // equally stable) — the SAME pairing every time, on every replay.
    const candidatesByKey = new Map<string, string[]>();
    for (const line of adoptableLines) {
        if (line.sourceOfRecord !== "QBO") continue;
        if (line.normalizedPayee === "") continue;
        const key = bankLineIdentityKey(line);
        const ids = candidatesByKey.get(key);
        if (ids) ids.push(line.id);
        else candidatesByKey.set(key, [line.id]);
    }
    for (const [key, ids] of candidatesByKey) {
        const order = new Map(adoptableLines.map(line => [line.id, line.qbTxnId ?? line.id]));
        candidatesByKey.set(key, [...ids].sort((a, b) => {
            const oa = order.get(a) ?? a;
            const ob = order.get(b) ?? b;
            return oa < ob ? -1 : oa > ob ? 1 : a < b ? -1 : a > b ? 1 : 0;
        }));
    }

    const linesByKey = new Map<string, number[]>();
    for (const line of statementLines) {
        if (line.normalizedPayee === "") { plan.mint.push(line.sequence); continue; }
        const key = bankLineIdentityKey({ ...line, account });
        const seqs = linesByKey.get(key);
        if (seqs) seqs.push(line.sequence);
        else linesByKey.set(key, [line.sequence]);
    }

    for (const [key, sequences] of linesByKey) {
        const candidates = candidatesByKey.get(key) ?? [];
        // Statement order is the statement's own sequence — already stable.
        const ordered = [...sequences].sort((a, b) => a - b);
        for (let i = 0; i < ordered.length; i++) {
            if (i < candidates.length) plan.adopt.set(ordered[i], candidates[i]);
            else plan.mint.push(ordered[i]);
        }
        // The statement saw more of this transaction than QBO did. The extras
        // mint (the statement is the source that says how many there were);
        // surfaced so a human can see QBO under-reported.
        if (ordered.length > candidates.length && candidates.length > 0) plan.ambiguous.push(key);
    }

    plan.mint.sort((a, b) => a - b);
    return plan;
}
