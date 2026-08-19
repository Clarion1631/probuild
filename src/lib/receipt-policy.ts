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
 * NOTE (found while surveying prod 2026-08-19): a THIRD card, C#4297,
 * appears on Plaid, Google Cloud, Anthropic and a Cash App payment — all
 * software/personal-shaped spend, none of it crew purchasing. It is
 * deliberately NOT mapped to CJ or Richard: guessing an owner would send
 * someone else's affidavit to the wrong person, which is exactly the trust
 * failure this module exists to prevent. It reports as "unassigned" until a
 * human says whose it is.
 */
export type ReceiptOwner = "CJ" | "Richard" | "unassigned" | "office";

export interface OwnerVerdict {
    owner: ReceiptOwner;
    /** The card tail that decided it, when a card was involved. */
    cardTail: string | null;
}

const CARD_OWNERS: Record<string, ReceiptOwner> = {
    "8516": "CJ",
    "6098": "Richard",
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
