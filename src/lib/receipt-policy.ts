/**
 * Receipt policy — does this bank line owe a receipt at all?
 *
 * Phase 1 of docs/plans/PROFIT-LOOP-PLAN.md. Written from a full survey of
 * every spend descriptor in prod (2026-08-19), not from a sample.
 *
 * WHY THIS EXISTS. The first worklist demanded an affidavit for 37 of 46
 * charges — including three automatic loan payments, an insurance ACH, a
 * bookkeeping fee, and a $0.32 Plaid charge. Asking Richard to sign a sworn
 * statement about a loan payment is how you lose a crew's trust in one
 * message. A list that cries wolf is a list nobody opens.
 *
 * THE FLYWHEEL, applied:
 *   STRUCTURE — every line lands in exactly one bucket by rule, not by mood.
 *   AGENCY    — an exemption is a VISIBLE decision with a stated reason, and
 *               a human can override it; nothing is silently hidden.
 *   TRUST     — the list only contains things that genuinely lack a receipt,
 *               so red actually means red.
 *   ADOPTION  — a short, true list gets worked; a long, wrong one gets muted.
 *   → back to STRUCTURE: what people override teaches the next rule.
 *
 * This module NEVER decides whether an expense is legitimate, deductible, or
 * correctly job-coded. It answers exactly one question: is there a merchant
 * receipt somewhere for a human to find? Bookkeeping judgment stays with
 * Marge and Vanessa (money-map: humans keep sign-off).
 *
 * PURE: no Prisma, no I/O.
 */

export type ReceiptRequirement =
    /** A merchant sold goods/services — a receipt exists and should be found. */
    | "receipt_expected"
    /** No merchant receipt exists for this rail (loan, fee, transfer, draw). */
    | "no_receipt_expected"
    /** Money in. Deposits are revenue evidence, not spend receipts. */
    | "not_spend";

export interface ReceiptPolicyVerdict {
    requirement: ReceiptRequirement;
    /** Short, human-readable justification — shown in the UI, never hidden. */
    reason: string;
    /** Stable key so a human override can be recorded against the RULE. */
    ruleKey: string;
}

export interface ReceiptPolicyLine {
    amountCents: number;
    rawDescriptor: string;
    checkNumber?: string | null;
}

/**
 * Rails that never produce a merchant receipt. Each entry is a pattern plus
 * the reason a human sees. Order matters only for readability: the first
 * match wins and patterns are written to be mutually exclusive.
 *
 * Every one of these was observed in prod — nothing here is speculative.
 */
const NO_RECEIPT_RULES: Array<{ key: string; test: RegExp; reason: string }> = [
    {
        key: "loan-payment",
        test: /\bINDIVIDUAL LOAN PAYMENTS\b|\bAUTOMATIC LOAN PAYMENT\b/i,
        reason: "Loan payment — principal/interest, no merchant receipt exists",
    },
    {
        key: "card-payment",
        test: /\bCAPITAL ONE\b|\bONLINE PMT\b.*\bCAPITAL ONE\b/i,
        reason: "Credit-card payment — a transfer; the receipts live on that card's statement",
    },
    {
        key: "merchant-fee",
        test: /\bTRAN FEE\b|\bINT FEE\b|\bSERVICE CHARGE\b|\bOVERDRAFT\b|\bNSF\b|\bWIRE FEE\b/i,
        reason: "Bank/processor fee — appears on the statement itself",
    },
    {
        key: "insurance",
        test: /\bINSURANCE\b/i,
        reason: "Insurance premium — invoiced by policy, not a merchant receipt",
    },
    {
        key: "professional-services",
        test: /\bBOOKKEEPI\w*\b|\bPAYROLL\b|\bGUSTO\b|\bACCOUNTING\b/i,
        reason: "Professional service — invoiced, not a point-of-sale receipt",
    },
    {
        key: "owner-transfer",
        // Named owner transfers only. Person-to-person RAILS (Cash App,
        // Venmo, Zelle) are deliberately NOT exempted here — see
        // classifyPersonToPersonPayment() below. Justin corrected this
        // 2026-08-19: a Cash App payment can be an owner draw, a PAYROLL
        // ADVANCE to an employee, or a payment to a household worker, and
        // those book differently. Guessing "draw" because it left Justin's
        // card would silently misfile payroll — a books and tax error, not
        // a receipt-chasing inconvenience.
        test: /\bVENMO\b.*\bJUSTIN ADKINS\b|\bTRANSFER TO\b|\bOWNER DRAW\b/i,
        reason: "Owner transfer/draw — not a business purchase",
    },
    {
        key: "tax-payment",
        test: /\bDEPT OF REVENUE\b|\bIRS\b|\bEFTPS\b|\bTAX PAYMENT\b|\bDOR\b/i,
        reason: "Tax payment — filing record, not a receipt",
    },
];

/**
 * Software/SaaS subscriptions. Split from the list above because these DO
 * have receipts (emailed invoices) — they are simply never the crew's job to
 * chase, and they are overhead rather than job cost. Marked as expected so
 * the automated email hunt still collects them, but the UI can group them
 * away from the crew's list.
 */
const SUBSCRIPTION_RULE = {
    key: "software-subscription",
    test: /\bANTHROPIC\b|\bGOOGLE\s*\*?\s*CLOUD\b|\bPLAID\b|\bOPENAI\b|\bMICROSOFT\b|\bADOBE\b|\bINTUIT\b(?!.*\bTRAN FEE\b)|\bGITHUB\b|\bVERCEL\b/i,
    reason: "Software subscription — emailed invoice, overhead not job cost",
};

/**
 * Decides whether a line owes a receipt.
 *
 * Money IN is never a spend receipt. A check is always receipt_expected: the
 * check image plus whatever it paid for is exactly the evidence we want, and
 * a bare "CHECK PAID" descriptor tells a human nothing on its own.
 */
export function classifyReceiptRequirement(line: ReceiptPolicyLine): ReceiptPolicyVerdict {
    if (line.amountCents >= 0) {
        return { requirement: "not_spend", reason: "Money in — revenue, not a purchase", ruleKey: "money-in" };
    }

    const descriptor = line.rawDescriptor ?? "";

    for (const rule of NO_RECEIPT_RULES) {
        if (rule.test.test(descriptor)) {
            return { requirement: "no_receipt_expected", reason: rule.reason, ruleKey: rule.key };
        }
    }

    if (SUBSCRIPTION_RULE.test.test(descriptor)) {
        return {
            requirement: "receipt_expected",
            reason: SUBSCRIPTION_RULE.reason,
            ruleKey: SUBSCRIPTION_RULE.key,
        };
    }

    if (line.checkNumber && line.checkNumber.trim() !== "") {
        return {
            requirement: "receipt_expected",
            reason: "Check — needs the check image and what it paid for",
            ruleKey: "check",
        };
    }

    return {
        requirement: "receipt_expected",
        reason: "Merchant purchase",
        ruleKey: "merchant",
    };
}

// ── Card rails ───────────────────────────────────────────────────────────

/**
 * Who is responsible for a charge's receipt.
 *
 * Card map confirmed by Justin 2026-08-19:
 *   …8516 = CJ (field purchases)
 *   …6098 = Richard (ops manager)
 *   …4297 = Justin (owner) — software, subscriptions, owner draws
 *
 * Justin's own card is deliberately its own owner rather than folded into
 * "office": he is not someone to send an affidavit request to, and his
 * spend is overwhelmingly overhead/subscription rather than job cost.
 */
export type ReceiptOwner = "CJ" | "Richard" | "Justin" | "unassigned" | "office";

export interface OwnerVerdict {
    owner: ReceiptOwner;
    /** The card tail that decided it, when a card was involved. */
    cardTail: string | null;
}

const CARD_OWNERS: Record<string, ReceiptOwner> = {
    "8516": "CJ",
    "6098": "Richard",
    "4297": "Justin",
};

export function resolveReceiptOwner(rawDescriptor: string): OwnerVerdict {
    const match = /\bC#\s*(\d{4})\b/i.exec(rawDescriptor ?? "");
    if (match) {
        const tail = match[1];
        return { owner: CARD_OWNERS[tail] ?? "unassigned", cardTail: tail };
    }
    // No card = an office-initiated rail (ACH, check, transfer). The office
    // owns chasing those; the crew never sees them.
    return { owner: "office", cardTail: null };
}

// ── Person-to-person payments ────────────────────────────────────────────

/**
 * Cash App / Venmo / Zelle payments are the one place where the SAME rail
 * means three different bookkeeping outcomes, and getting it wrong is a
 * payroll/tax error rather than a missing receipt:
 *
 *   paid an EMPLOYEE          → payroll advance; must be set up in Gusto so
 *                               it withholds and reconciles against payroll
 *   paid the OWNER            → owner draw; equity, not an expense
 *   paid someone else         → could be a household worker (Richard's
 *                               housekeeper), a family member, or a genuine
 *                               job-cost helper — a HUMAN decides
 *
 * Justin's guidance verbatim (2026-08-19): "if it's Richard's housekeeper,
 * then it would be a payroll advance… if it's me, it's just an owner's draw,
 * if it's an employee then payroll advance set up properly in Gusto."
 *
 * So this NEVER decides on its own when the payee is unknown. It matches the
 * payee name against ProBuild's real roster (the caller supplies it — Gusto
 * is the payroll system of record but every worker should exist in ProBuild)
 * and returns a decided verdict only for a confident name match.
 */
export type P2PDisposition =
    /** Paid a known employee → payroll advance, belongs in Gusto. */
    | "payroll_advance"
    /** Paid the owner → equity draw. */
    | "owner_draw"
    /** Rail is person-to-person but the payee isn't a known worker. */
    | "needs_human"
    /** Not a person-to-person payment at all. */
    | "not_p2p";

export interface P2PVerdict {
    disposition: P2PDisposition;
    /** The payee name lifted from the descriptor, when one was found. */
    payeeName: string | null;
    /** The roster person matched, when matched. */
    matchedPerson: string | null;
    reason: string;
}

export interface RosterPerson {
    name: string;
    /** "owner" books as a draw; anyone else books as a payroll advance. */
    kind: "owner" | "employee";
}

const P2P_RAIL = /\b(CASH APP|CASHAPP|VENMO|ZELLE)\b/i;

/**
 * Lifts the counterparty name out of a person-to-person descriptor.
 * "CASH APP*MADISON WILKE Oakland CA" → "MADISON WILKE"
 * "PAYMENT    VENMO JUSTIN ADKINS 1052320032752 WEB" → "JUSTIN ADKINS"
 */
export function extractP2PPayee(rawDescriptor: string): string | null {
    const d = (rawDescriptor ?? "").toUpperCase();
    const rail = P2P_RAIL.exec(d);
    if (!rail) return null;
    let rest = d.slice(rail.index + rail[0].length);
    rest = rest.replace(/^[\s*:-]+/, "");
    // Stop at trailing rail metadata: city/state, card ref, long numbers.
    rest = rest.split(/\s+C#\s*\d+/)[0];
    rest = rest.replace(/\b\d{6,}\b.*$/, "");
    rest = rest.replace(/\b(WEB|CCD|PPD|TEL|DBT CRD|POS DEB)\b.*$/, "");
    // Keep the first two name-ish words; city names follow the payee.
    const words = rest.split(/\s+/).filter(w => /^[A-Z][A-Z'.-]*$/.test(w) && w.length > 1);
    if (words.length === 0) return null;
    return words.slice(0, 2).join(" ").trim() || null;
}

/** Loose name equality: case/punctuation-insensitive, first+last order-free. */
function nameMatches(payee: string, person: string): boolean {
    const norm = (s: string) => s.toUpperCase().replace(/[^A-Z\s]/g, "").split(/\s+/).filter(Boolean);
    const a = norm(payee);
    const b = norm(person);
    if (a.length === 0 || b.length === 0) return false;
    const shared = a.filter(t => b.includes(t));
    // Require BOTH a first and last name to agree — a single shared token
    // ("JUSTIN") would match two different people on this roster.
    return shared.length >= 2;
}

export function classifyPersonToPersonPayment(
    rawDescriptor: string,
    roster: RosterPerson[],
): P2PVerdict {
    if (!P2P_RAIL.test(rawDescriptor ?? "")) {
        return { disposition: "not_p2p", payeeName: null, matchedPerson: null, reason: "" };
    }
    const payeeName = extractP2PPayee(rawDescriptor);
    if (!payeeName) {
        return {
            disposition: "needs_human",
            payeeName: null,
            matchedPerson: null,
            reason: "Person-to-person payment with no readable payee — a human must say who this was",
        };
    }
    for (const person of roster) {
        if (!nameMatches(payeeName, person.name)) continue;
        if (person.kind === "owner") {
            return {
                disposition: "owner_draw",
                payeeName,
                matchedPerson: person.name,
                reason: `Paid ${person.name} (owner) — owner draw, equity not expense`,
            };
        }
        return {
            disposition: "payroll_advance",
            payeeName,
            matchedPerson: person.name,
            reason: `Paid ${person.name} (employee) — payroll advance, must be set up in Gusto`,
        };
    }
    return {
        disposition: "needs_human",
        payeeName,
        matchedPerson: null,
        reason: `Paid "${payeeName}", who is not in ProBuild — owner draw, payroll advance, or job cost? A human decides`,
    };
}

// ── Roll-up ──────────────────────────────────────────────────────────────

export interface ReceiptWorkItem<T> {
    line: T;
    verdict: ReceiptPolicyVerdict;
    ownerVerdict: OwnerVerdict;
}

export interface ReceiptWorkSummary<T> {
    /** Needs a receipt and doesn't have one — the real worklist. */
    needsReceipt: ReceiptWorkItem<T>[];
    /** Exempt by rule — shown, collapsed, with the reason. Never hidden. */
    exempt: ReceiptWorkItem<T>[];
    /** Money in. */
    notSpend: ReceiptWorkItem<T>[];
    /** Already has receipt evidence. */
    satisfied: ReceiptWorkItem<T>[];
}

/**
 * Buckets lines for the worklist. `hasReceipt` is supplied by the caller so
 * this stays pure and testable — the caller knows where receipt evidence
 * lives (BankLine.receiptUrl today, plus affidavits later).
 */
export function summarizeReceiptWork<T extends ReceiptPolicyLine>(
    lines: T[],
    hasReceipt: (line: T) => boolean,
): ReceiptWorkSummary<T> {
    const out: ReceiptWorkSummary<T> = { needsReceipt: [], exempt: [], notSpend: [], satisfied: [] };
    for (const line of lines) {
        const verdict = classifyReceiptRequirement(line);
        const ownerVerdict = resolveReceiptOwner(line.rawDescriptor);
        const item = { line, verdict, ownerVerdict };
        if (verdict.requirement === "not_spend") out.notSpend.push(item);
        else if (verdict.requirement === "no_receipt_expected") out.exempt.push(item);
        else if (hasReceipt(line)) out.satisfied.push(item);
        else out.needsReceipt.push(item);
    }
    return out;
}
