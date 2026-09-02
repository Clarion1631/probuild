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
 * MATCH IDENTITY is deliberately the SAME key `reconcileObservations` uses —
 * account + postedDate + amountCents + normalizedPayee, plus checkNumber
 * agreement — so a line that adoption considers "the same transaction" is the
 * same one reconcile would link. Two different identity rules over one ledger
 * is how you get a line that adopts here and stays unreconciled there.
 * An empty normalizedPayee is NOT an identity (bank-ledger's rule) and never
 * mints and never adopts.
 */

/**
 * How old a QBO row must be before it may mint. QuickBooks shows pending and
 * recently-posted rows that can still be edited or removed; minting one
 * immediately would create a canonical line for a transaction that may never
 * settle. Two days is the same "let it settle" instinct as the matcher's
 * three-day grace, one notch tighter because minting is reversible only by a
 * human.
 */
export const QBO_MINT_MIN_AGE_DAYS = 2;

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
    const taken = new Set<string>();
    for (const line of existingLines) {
        if (line.normalizedPayee === "") continue;
        taken.add(bankLineIdentityKey(line));
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
        if (taken.has(key)) {
            // Either a statement already minted it, or an earlier run did, or
            // an earlier observation in THIS batch did. All three mean "a
            // canonical line for this transaction already exists".
            plan.skipped.statementLineExists++;
            continue;
        }
        taken.add(key);
        plan.mint.push(obs);
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
     * Identities where the pairing could not be inferred — more than one
     * statement line and/or more than one adoptable line share a key. Every
     * member mints instead, exactly as it would have before this feature
     * existed. Reported, never silently guessed (the same rule
     * reconcileObservations follows for its ambiguous groups).
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

    const candidatesByKey = new Map<string, string[]>();
    for (const line of adoptableLines) {
        if (line.sourceOfRecord !== "QBO") continue;
        if (line.normalizedPayee === "") continue;
        const key = bankLineIdentityKey(line);
        const ids = candidatesByKey.get(key);
        if (ids) ids.push(line.id);
        else candidatesByKey.set(key, [line.id]);
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
        const candidates = candidatesByKey.get(key);
        if (!candidates || candidates.length === 0) {
            plan.mint.push(...sequences);
            continue;
        }
        if (sequences.length === 1 && candidates.length === 1) {
            plan.adopt.set(sequences[0], candidates[0]);
            continue;
        }
        plan.ambiguous.push(key);
        plan.mint.push(...sequences);
    }

    plan.mint.sort((a, b) => a - b);
    return plan;
}
