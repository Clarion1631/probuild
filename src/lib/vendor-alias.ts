/**
 * Vendor alias matching (Phase 1 of docs/plans/PROFIT-LOOP-PLAN.md).
 *
 * THE PROBLEM, measured against prod 2026-08-19: the bank and QuickBooks
 * describe the same purchase in two different vocabularies.
 *
 *   bank: "MISCELLANEOUS DEBIT LOWE S #1632 LOWE S 1632"
 *   qbo:  "LOWE'S HOME CENTERS, LLC Expense"
 *   → same day, same cent, zero reconcile matches
 *
 * reconcileObservations() requires an EXACT normalizedPayee match and is
 * right to: amount+date alone is zero confidence (the Chevron/Cash App
 * wrong-match lesson). So the fix is not to loosen reconcile — it is to
 * teach the system that these two strings name the same vendor.
 *
 * HOW THIS IS SAFE. This module PROPOSES; it never links. Every proposal
 * carries the evidence that produced it and a confidence tier, and a human
 * (Marge, in her worklist) confirms it once. A confirmed alias is then a
 * durable fact — the next 200 Lowe's charges reconcile automatically without
 * asking again. Nothing here writes to the ledger, and an alias can never
 * cause a match on its own: date and cent-exact amount must ALSO agree,
 * exactly as reconcile already demands.
 *
 * House rules inherited from reconcileObservations:
 *   - ambiguity is never resolved by guessing or by input order — a bank
 *     line whose date+amount fits more than one QBO row (or vice versa) is
 *     reported as ambiguous and proposes nothing;
 *   - an empty normalized payee never matches anything;
 *   - amounts are compared, never modified.
 *
 * PURE: no Prisma, no I/O. The caller queries and persists.
 */

/** A confirmed vendor alias: two payee spellings that name one vendor. */
export interface VendorAlias {
    /** normalizePayee() output as it appears on BANK descriptors. */
    bankPayee: string;
    /** normalizePayee() output as it appears on QBO descriptors. */
    qboPayee: string;
}

export interface AliasCandidateLine {
    id: string;
    /** YYYY-MM-DD */
    postedDate: string;
    /** Signed integer cents. */
    amountCents: number;
    /** normalizePayee() output — "" is the EXCEPTION case and never matches. */
    normalizedPayee: string;
    /** Original text, carried for human review only. */
    rawDescriptor: string;
}

export type AliasConfidence =
    /** An operator already confirmed this pairing; reconcile can use it. */
    | "confirmed"
    /** One bank row and one QBO row share date+amount and neither is spoken for. */
    | "unique_date_amount"
    /** Same as above, and the payee strings visibly share a vendor token. */
    | "unique_date_amount_token";

export interface AliasProposal {
    bankLineId: string;
    qboLineId: string;
    bankPayee: string;
    qboPayee: string;
    /** Evidence, carried so a human never has to re-derive why we asked. */
    postedDate: string;
    amountCents: number;
    bankRawDescriptor: string;
    qboRawDescriptor: string;
    confidence: AliasConfidence;
    /** The shared token that suggested the pairing, when there is one. */
    sharedToken: string | null;
}

export interface AliasAmbiguity {
    postedDate: string;
    amountCents: number;
    bankLineIds: string[];
    qboLineIds: string[];
}

export interface AliasMatchResult {
    /** Pairings a human should confirm (or that are already confirmed). */
    proposals: AliasProposal[];
    /** date+amount groups with more than one candidate on either side. */
    ambiguous: AliasAmbiguity[];
}

/** Tokens that carry no vendor identity and must never drive a pairing. */
const STOP_TOKENS = new Set([
    // bank rail nouns
    "MISCELLANEOUS", "DEBIT", "CREDIT", "PREAUTHORIZED", "ACH", "POS", "PURCHASE",
    "PAYMENT", "PAYMENTS", "DEPOSIT", "WITHDRAWAL", "TRANSFER", "CHECK", "PAID",
    "INDIVIDUAL", "AUTOMATIC", "RECURRING", "ELECTRONIC", "ONLINE", "MOBILE",
    // QBO row nouns (registerRowToLine appends the GL type)
    "EXPENSE", "JOURNAL", "ENTRY", "BILL", "REFUND", "CHARGE", "SALE",
    // NOTE: this set is consulted AFTER trailing-S folding, so list the
    // SINGULAR form only ("CENTERS" arrives here as "CENTER").
    // corporate suffixes — present on one side, absent on the other
    "LLC", "INC", "CO", "CORP", "LTD", "COMPANY", "THE", "AND", "OF",
    "HOME", "CENTER", "STORE", "RETAIL", "SUPPLY", "SERVICE", "PAYMENT",
]);

/**
 * Vendor-ish tokens from a normalized payee: alphabetic, 3+ chars, not a
 * stop word. "LOWE'S HOME CENTERS, LLC EXPENSE" → ["LOWE"].
 *
 * POSSESSIVE / PLURAL FOLDING (found 2026-08-19 against real prod rows): the
 * bank prints "LOWE S #1632" (the apostrophe becomes a space on the card
 * rail) while QuickBooks prints "LOWE'S HOME CENTERS, LLC". Tokenizing
 * naively gives "LOWE" vs "LOWES" — two spellings of one vendor that would
 * never share a token. So a trailing S is folded off every token, and a bare
 * "S" left stranded by the rail's spacing is dropped. "LOWE'S", "LOWES" and
 * "LOWE S" all reduce to LOWE.
 *
 * Digits are dropped entirely so a store number can never masquerade as
 * vendor identity.
 */
export function vendorTokens(normalizedPayee: string): Set<string> {
    const out = new Set<string>();
    if (!normalizedPayee) return out;
    for (const rawToken of normalizedPayee.toUpperCase().split(/[^A-Z0-9']+/)) {
        let token = rawToken.replace(/'/g, "");
        // A stranded possessive "S" (from "LOWE S") carries no identity.
        if (token === "S") continue;
        // Fold a trailing possessive/plural S so LOWES === LOWE. Guarded at
        // 4+ chars so short real words ("GAS", "BUS") are not truncated into
        // collidable stubs.
        if (token.length >= 4 && token.endsWith("S")) token = token.slice(0, -1);
        if (token.length < 3) continue;
        if (/\d/.test(token)) continue;
        if (STOP_TOKENS.has(token)) continue;
        out.add(token);
    }
    return out;
}

/**
 * The strongest vendor token shared by two payees, or null. "Strongest" =
 * longest, since a longer token is far less likely to collide by accident
 * ("LOWES" is meaningful, "GAS" is not).
 */
export function sharedVendorToken(bankPayee: string, qboPayee: string): string | null {
    const bankTokens = vendorTokens(bankPayee);
    const qboTokens = vendorTokens(qboPayee);
    let best: string | null = null;
    for (const token of bankTokens) {
        if (!qboTokens.has(token)) continue;
        if (best === null || token.length > best.length) best = token;
    }
    return best;
}

function aliasKey(bankPayee: string, qboPayee: string): string {
    return `${bankPayee}\u0000${qboPayee}`;
}

/**
 * Proposes bank↔QBO pairings for rows that reconcile could not match.
 *
 * Only rows that agree on BOTH posted date and exact signed cents are ever
 * considered — the alias explains the payee difference, it does not replace
 * the other evidence. Within a date+amount group:
 *
 *   - exactly one bank row and one QBO row → a proposal. Confidence is
 *     "confirmed" if that payee pair is already in `confirmedAliases`,
 *     "unique_date_amount_token" if the two payees share a vendor token,
 *     otherwise "unique_date_amount" (weakest — a human should look hard);
 *   - more than one row on either side → AMBIGUOUS. No proposal, reported
 *     for a human, never guessed by input order.
 *
 * Rows with an empty normalizedPayee are dropped up front: that is the
 * EXCEPTION case and it must never match anything.
 */
export function proposeAliasMatches(
    bankLines: AliasCandidateLine[],
    qboLines: AliasCandidateLine[],
    confirmedAliases: VendorAlias[] = [],
): AliasMatchResult {
    const confirmed = new Set<string>();
    for (const alias of confirmedAliases) {
        if (!alias.bankPayee || !alias.qboPayee) continue;
        confirmed.add(aliasKey(alias.bankPayee, alias.qboPayee));
    }

    const groupKey = (line: AliasCandidateLine) => `${line.postedDate}\u0000${line.amountCents}`;

    const bankByKey = new Map<string, AliasCandidateLine[]>();
    for (const line of bankLines) {
        if (line.normalizedPayee === "") continue;
        const key = groupKey(line);
        const arr = bankByKey.get(key);
        if (arr) arr.push(line); else bankByKey.set(key, [line]);
    }

    const qboByKey = new Map<string, AliasCandidateLine[]>();
    for (const line of qboLines) {
        if (line.normalizedPayee === "") continue;
        const key = groupKey(line);
        const arr = qboByKey.get(key);
        if (arr) arr.push(line); else qboByKey.set(key, [line]);
    }

    const proposals: AliasProposal[] = [];
    const ambiguous: AliasAmbiguity[] = [];

    // Sorted so output is deterministic regardless of input order.
    for (const key of [...bankByKey.keys()].sort()) {
        const bankGroup = bankByKey.get(key)!;
        const qboGroup = qboByKey.get(key);
        if (!qboGroup || qboGroup.length === 0) continue;

        const [postedDate, amountRaw] = key.split("\u0000");
        const amountCents = Number(amountRaw);

        if (bankGroup.length > 1 || qboGroup.length > 1) {
            ambiguous.push({
                postedDate,
                amountCents,
                bankLineIds: bankGroup.map(l => l.id).sort(),
                qboLineIds: qboGroup.map(l => l.id).sort(),
            });
            continue;
        }

        const bank = bankGroup[0];
        const qbo = qboGroup[0];

        // Identical payees would have matched in reconcile already; proposing
        // them here would be noise.
        if (bank.normalizedPayee === qbo.normalizedPayee) continue;

        const sharedToken = sharedVendorToken(bank.normalizedPayee, qbo.normalizedPayee);
        const isConfirmed = confirmed.has(aliasKey(bank.normalizedPayee, qbo.normalizedPayee));
        const confidence: AliasConfidence = isConfirmed
            ? "confirmed"
            : sharedToken !== null
                ? "unique_date_amount_token"
                : "unique_date_amount";

        proposals.push({
            bankLineId: bank.id,
            qboLineId: qbo.id,
            bankPayee: bank.normalizedPayee,
            qboPayee: qbo.normalizedPayee,
            postedDate,
            amountCents,
            bankRawDescriptor: bank.rawDescriptor,
            qboRawDescriptor: qbo.rawDescriptor,
            confidence,
            sharedToken,
        });
    }

    return { proposals, ambiguous };
}

/**
 * Rolls confirmed one-off pairings up into distinct vendor aliases, so
 * confirming "LOWE S #1632 ↔ LOWE'S HOME CENTERS, LLC" once covers every
 * future charge with that pair of spellings. Deduped and sorted for a stable
 * write.
 */
export function aliasesFromProposals(proposals: AliasProposal[]): VendorAlias[] {
    const seen = new Map<string, VendorAlias>();
    for (const p of proposals) {
        const key = aliasKey(p.bankPayee, p.qboPayee);
        if (!seen.has(key)) seen.set(key, { bankPayee: p.bankPayee, qboPayee: p.qboPayee });
    }
    return [...seen.values()].sort((a, b) =>
        a.bankPayee.localeCompare(b.bankPayee) || a.qboPayee.localeCompare(b.qboPayee));
}
