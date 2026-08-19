/**
 * Who paid us? — matching bank deposits to a named payer.
 *
 * THE PROBLEM, measured against prod 2026-08-19: a WTB deposit row says only
 * `OTHER DEPOSITS DEPOSIT - DDA/MMKT $35,000.00`. Nothing names the customer.
 * Matching on AMOUNT ALONE is actively dangerous — two of five "unrecorded
 * Christensen payments" were really Mesplay money that happened to collide
 * with a Christensen milestone amount. Booking those would have credited
 * $60,000 to the wrong job and corrupted both margins.
 *
 * THREE SOURCES, in descending order of trust:
 *
 *   1. CHECK IMAGE  — the physical instrument. Printed payer name, signature,
 *      memo line. Nobody typed it in; it cannot be a data-entry mistake.
 *      This is Justin's trusted source and it settles every disagreement.
 *   2. QBO PAYMENT  — a human (Marge) recorded "customer X paid $Y".
 *      Available over the API with no bank login. Named 9 of 15 deposits in
 *      the live sample, sometimes with the check number.
 *   3. MILESTONE AMOUNT — what ProBuild expected to be paid. WEAKEST: it is
 *      an expectation, not evidence, and amounts collide across jobs.
 *
 * This module never books anything. It produces an attribution with its
 * evidence and confidence so a human can confirm, and — critically — it
 * flags DISAGREEMENT between sources rather than silently preferring one.
 *
 * PURE: no Prisma, no network.
 */

export interface DepositRow {
    id: string;
    /** YYYY-MM-DD */
    postedDate: string;
    /** Positive cents (money in). */
    amountCents: number;
    rawDescriptor: string;
}

export interface QboPayment {
    /** YYYY-MM-DD */
    date: string;
    amountCents: number;
    /** QBO CustomerRef.name, e.g. "Sandi Christensen" or "Mesplay Kitchen". */
    customerName: string | null;
    /** PaymentRefNum — often the customer's check number. */
    checkNumber: string | null;
}

export interface CheckImageEvidence {
    /** Payer read off the check image (printed name). */
    payerName: string | null;
    /** Memo line — frequently names the job outright. */
    memo: string | null;
    checkNumber: string | null;
    amountCents: number | null;
    /** YYYY-MM-DD */
    documentDate: string | null;
}

export interface MilestoneCandidate {
    id: string;
    projectName: string;
    /** Customer of record on the project, for cross-checking a payer name. */
    customerName: string | null;
    milestoneName: string;
    amountCents: number;
    status: string;
}

export type AttributionSource = "check_image" | "qbo_payment" | "milestone_amount";

export type AttributionConfidence =
    /** Image (or image+QBO) names the payer. Strongest. */
    | "verified"
    /** QBO names a payer and nothing contradicts it. */
    | "recorded"
    /** Only an amount matched, and it matched exactly one milestone. */
    | "amount_only"
    /** Sources NAME DIFFERENT PAYERS. Never auto-book. */
    | "conflict"
    /** Nothing named it. */
    | "unknown";

export interface DepositAttribution {
    depositId: string;
    postedDate: string;
    amountCents: number;
    /** Best available payer name, or null when nothing named it. */
    payerName: string | null;
    /** Where payerName came from. */
    source: AttributionSource | null;
    confidence: AttributionConfidence;
    checkNumber: string | null;
    /** Milestones this amount could settle. */
    candidateMilestones: MilestoneCandidate[];
    /** The single milestone to settle, when it is unambiguous AND agrees. */
    proposedMilestoneId: string | null;
    /** Plain-language reason a human can act on. */
    reason: string;
    /** True when the deposit needs a check image pulled to resolve it. */
    needsImage: boolean;
}

/** Day window for tying a QBO payment to a bank posting. */
export const PAYMENT_DAY_WINDOW = 5;

function daysBetween(a: string, b: string): number {
    const t1 = Date.parse(`${a}T00:00:00Z`);
    const t2 = Date.parse(`${b}T00:00:00Z`);
    if (!Number.isFinite(t1) || !Number.isFinite(t2)) return Number.NaN;
    return Math.round((t2 - t1) / 86_400_000);
}

/**
 * Loose person/company name agreement. "Sandi Christensen" vs
 * "Christensen Remodel" agree; "Mesplay Kitchen" vs "Christensen Remodel"
 * do not. Requires a shared token of 4+ chars so "and"/"the" cannot match.
 */
export function namesAgree(a: string | null, b: string | null): boolean {
    if (!a || !b) return false;
    const norm = (s: string) =>
        s.toUpperCase().replace(/[^A-Z\s]/g, " ").split(/\s+/).filter(t => t.length >= 4);
    const ta = norm(a);
    const tb = norm(b);
    if (!ta.length || !tb.length) return false;
    const stop = new Set(["REMODEL", "KITCHEN", "BATHROOM", "PROJECT", "CONSTRUCTION"]);
    return ta.some(t => tb.includes(t) && !stop.has(t));
}

export function attributeDeposit(
    deposit: DepositRow,
    options: {
        qboPayments?: QboPayment[];
        checkImage?: CheckImageEvidence | null;
        milestones?: MilestoneCandidate[];
        dayWindow?: number;
    } = {},
): DepositAttribution {
    const window = options.dayWindow ?? PAYMENT_DAY_WINDOW;
    const payments = options.qboPayments ?? [];
    const image = options.checkImage ?? null;
    const milestones = options.milestones ?? [];

    const base = {
        depositId: deposit.id,
        postedDate: deposit.postedDate,
        amountCents: deposit.amountCents,
    };

    // Milestones this amount could settle, cheapest signal, computed once.
    const candidates = milestones
        .filter(m => m.amountCents === deposit.amountCents)
        .sort((a, b) => a.id.localeCompare(b.id));

    // ── Source 2: QBO payment (exact amount, tight date window) ──────────
    const qboHits = payments.filter(p =>
        p.amountCents === deposit.amountCents &&
        Number.isFinite(daysBetween(p.date, deposit.postedDate)) &&
        Math.abs(daysBetween(p.date, deposit.postedDate)) <= window);

    const qboNames = [...new Set(qboHits.map(h => h.customerName).filter(Boolean))] as string[];
    const qboName = qboNames.length === 1 ? qboNames[0] : null;
    const qboCheck = qboHits.map(h => h.checkNumber).find(c => c && c !== "-") ?? null;

    // ── Source 1: the check image, strongest ─────────────────────────────
    const imageName = image?.payerName ?? null;

    // ── Conflict beats everything: two sources naming DIFFERENT people ───
    if (imageName && qboName && !namesAgree(imageName, qboName)) {
        return {
            ...base,
            payerName: imageName,
            source: "check_image",
            confidence: "conflict",
            checkNumber: image?.checkNumber ?? qboCheck,
            candidateMilestones: candidates,
            proposedMilestoneId: null,
            reason:
                `The check says "${imageName}" but QuickBooks says "${qboName}". ` +
                `Someone recorded this against the wrong customer — a human must decide.`,
            needsImage: false,
        };
    }

    if (qboNames.length > 1) {
        return {
            ...base,
            payerName: null,
            source: null,
            confidence: "conflict",
            checkNumber: qboCheck,
            candidateMilestones: candidates,
            proposedMilestoneId: null,
            reason:
                `QuickBooks has ${qboNames.length} different customers paying this exact ` +
                `amount near this date (${qboNames.join(", ")}). Pull the check image.`,
            needsImage: true,
        };
    }

    const payerName = imageName ?? qboName;
    const source: AttributionSource | null =
        imageName ? "check_image" : qboName ? "qbo_payment" : null;

    // A milestone is only proposed when the payer AGREES with the project.
    const agreeing = payerName
        ? candidates.filter(m => namesAgree(payerName, m.customerName) || namesAgree(payerName, m.projectName))
        : [];

    if (payerName && agreeing.length === 1) {
        const m = agreeing[0];
        return {
            ...base,
            payerName,
            source,
            confidence: imageName ? "verified" : "recorded",
            checkNumber: image?.checkNumber ?? qboCheck,
            candidateMilestones: candidates,
            proposedMilestoneId: m.id,
            reason:
                `${payerName} paid ${(deposit.amountCents / 100).toFixed(2)} — matches ` +
                `"${m.milestoneName}" on ${m.projectName}` +
                (imageName ? " (confirmed by the check image)" : " (per QuickBooks)"),
            needsImage: false,
        };
    }

    // Payer known but the amount does NOT line up with their milestone.
    if (payerName && candidates.length > 0 && agreeing.length === 0) {
        const others = [...new Set(candidates.map(c => c.projectName))].join(", ");
        return {
            ...base,
            payerName,
            source,
            confidence: "conflict",
            checkNumber: image?.checkNumber ?? qboCheck,
            candidateMilestones: candidates,
            proposedMilestoneId: null,
            reason:
                `${payerName} paid this, but the only milestone(s) at this amount belong to ` +
                `${others}. Booking it on amount alone would credit the wrong job.`,
            needsImage: !imageName,
        };
    }

    if (payerName) {
        return {
            ...base,
            payerName,
            source,
            confidence: imageName ? "verified" : "recorded",
            checkNumber: image?.checkNumber ?? qboCheck,
            candidateMilestones: candidates,
            proposedMilestoneId: null,
            reason: `${payerName} paid ${(deposit.amountCents / 100).toFixed(2)}, but no milestone matches that amount.`,
            needsImage: false,
        };
    }

    // ── Source 3: amount only. Weakest, and never enough on its own. ─────
    if (candidates.length === 1) {
        const m = candidates[0];
        return {
            ...base,
            payerName: null,
            source: "milestone_amount",
            confidence: "amount_only",
            checkNumber: null,
            candidateMilestones: candidates,
            proposedMilestoneId: null, // deliberately NOT proposed
            reason:
                `Only "${m.milestoneName}" on ${m.projectName} matches this amount, but ` +
                `nothing names the payer. Pull the check image before booking it.`,
            needsImage: true,
        };
    }

    return {
        ...base,
        payerName: null,
        source: candidates.length ? "milestone_amount" : null,
        confidence: "unknown",
        checkNumber: null,
        candidateMilestones: candidates,
        proposedMilestoneId: null,
        reason: candidates.length
            ? `${candidates.length} different milestones match this amount and nothing names the payer. Pull the check image.`
            : `Nothing in QuickBooks or ProBuild explains this deposit. Pull the check image.`,
        needsImage: true,
    };
}

export function attributeDeposits(
    deposits: DepositRow[],
    options: {
        qboPayments?: QboPayment[];
        checkImages?: Record<string, CheckImageEvidence>;
        milestones?: MilestoneCandidate[];
        dayWindow?: number;
    } = {},
): DepositAttribution[] {
    const images = options.checkImages ?? {};
    return [...deposits]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map(d => attributeDeposit(d, {
            qboPayments: options.qboPayments,
            checkImage: images[d.id] ?? null,
            milestones: options.milestones,
            dayWindow: options.dayWindow,
        }));
}

/** The short list for the weekly bank-login batch. */
export function depositsNeedingImages(attributions: DepositAttribution[]): DepositAttribution[] {
    return attributions.filter(a => a.needsImage);
}
