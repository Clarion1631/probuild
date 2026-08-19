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
 * Given names that collide constantly across unrelated customers. A shared
 * FIRST name is not identity — "Sandi Christensen" and "Sandi Mueller" are
 * two different families, and treating them as one credits the wrong job.
 * (Codex review B3, 2026-08-19: this exact pair was reproduced booking
 * Christensen's money onto a Mueller milestone.)
 */
const COMMON_GIVEN_NAMES = new Set([
    "SANDI", "SANDY", "JANET", "THOMAS", "CALEB", "ROBYNE", "DIXIE", "SALLY",
    "TIMOTHY", "ANNIE", "APRIL", "ALLISON", "JUSTIN", "RICHARD", "MICHAEL",
    "DAVID", "JOHN", "JAMES", "ROBERT", "MARY", "PATRICIA", "JENNIFER",
    "LINDA", "ELIZABETH", "BARBARA", "SUSAN", "JESSICA", "SARAH", "KAREN",
    "WILLIAM", "JOSEPH", "CHARLES", "CHRIS", "MARK", "PAUL", "STEVEN",
    "ANDREW", "KEVIN", "BRIAN", "GEORGE", "EDWARD", "RONALD", "ANTHONY",
]);

/**
 * Words that describe a JOB or a company, not a party. Consulted AFTER
 * plural folding, so list the singular form only ("REMODELS" arrives as
 * "REMODEL"). Same discipline as vendor-alias.ts:92.
 */
const NAME_STOP_TOKENS = new Set([
    // project/scope nouns
    "REMODEL", "REMODELING", "KITCHEN", "BATHROOM", "BATH", "ADDITION",
    "PROJECT", "CONSTRUCTION", "BUILD", "BUILDING", "HOME", "HOUSE",
    "PROPERTY", "RESIDENCE", "GARAGE", "SHOP", "SHED", "SIDING", "ROOF",
    "ELECTRICAL", "PLUMBING", "DECK", "PATIO", "BASEMENT", "UNIT", "SUITE",
    // family / entity boilerplate
    "FAMILY", "TRUST", "ESTATE", "ENTERPRISE", "HOLDING", "PARTNER",
    "LLC", "INC", "CORP", "CORPORATION", "COMPANY", "LTD", "GROUP",
    // connectives
    "AND", "THE", "OF", "FOR",
]);

/** Fold a trailing plural/possessive S, mirroring vendorTokens(). */
function foldToken(raw: string): string {
    let t = raw.replace(/'/g, "");
    if (t === "S") return "";
    if (t.length >= 4 && t.endsWith("S")) t = t.slice(0, -1);
    return t;
}

/**
 * Identity tokens from a party name: diacritics normalized, 3+ chars, no
 * digits, no scope/entity boilerplate.
 *
 * S-FOLDING TRAP (Kimi review, 2026-08-19): folding a trailing S turns
 * JAMES into JAME, CHARLES into CHARLE and CHRIS into CHRI — none of which
 * are in COMMON_GIVEN_NAMES, so every given name ending in S escaped the
 * guard and was treated as a surname. "James Christensen" then agreed with
 * "James Mueller", reopening exactly the B3 wrong-job hole. So the raw
 * token is tested against the given-name set BEFORE folding, and a token
 * recognised as a given name is never folded.
 */
export function nameTokens(value: string | null): string[] {
    if (!value) return [];
    const ascii = value.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const out: string[] = [];
    for (const raw of ascii.toUpperCase().split(/[^A-Z0-9']+/)) {
        const bare = raw.replace(/'/g, "");
        // Recognise the given name on the UNFOLDED token, then keep it
        // unfolded so isGivenName() still sees it downstream.
        const t = COMMON_GIVEN_NAMES.has(bare) ? bare : foldToken(raw);
        if (t.length < 3) continue;
        if (/\d/.test(t)) continue;
        if (NAME_STOP_TOKENS.has(t)) continue;
        out.push(t);
    }
    return out;
}

/**
 * Is this token a personal given name rather than an identifying surname?
 * Checks the folded form too, so a list entry can never be missed by the
 * S-folding above.
 */
function isGivenName(token: string): boolean {
    return COMMON_GIVEN_NAMES.has(token) || COMMON_GIVEN_NAMES.has(foldToken(token));
}

/** True when a name looks like a person (or people), not a business. */
function looksLikePerson(tokens: string[]): boolean {
    return tokens.some(isGivenName);
}

/**
 * Do two party names refer to the same customer?
 *
 * "Sandi Christensen" vs "Christensen Remodel" → true (shared surname).
 * "Sandi Christensen" vs "Sandi Mueller"       → FALSE (different families).
 * "Emily Smith"       vs "Emily Jones"         → FALSE (see below).
 *
 * Rules, tightened after two peer reviews:
 *  - scope words (REMODEL, KITCHEN, HOME…) never count, folded for plurals
 *    so "Remodeling" cannot sneak past "REMODEL";
 *  - a shared token from COMMON_GIVEN_NAMES never counts on its own;
 *  - STRUCTURAL GUARD (Kimi review, 2026-08-19): the given-name list can
 *    never be complete — "Emily" was missing, so "Emily Smith" agreed with
 *    "Emily Jones". So when both sides look like two-part person names and
 *    they share exactly ONE token, that token must be in the same POSITION
 *    in both. A shared FIRST token across two full names is two people with
 *    the same first name; a shared LAST token is a family. This holds for
 *    names nobody thought to list.
 */
export function namesAgree(a: string | null, b: string | null): boolean {
    const ta = nameTokens(a);
    const tb = nameTokens(b);
    if (!ta.length || !tb.length) return false;

    const shared = ta.filter(t => tb.includes(t));
    if (!shared.length) return false;

    // A shared given name alone is not identity.
    const identifying = shared.filter(t => !isGivenName(t));
    if (!identifying.length) return false;

    if (looksLikePerson(ta) && looksLikePerson(tb) && shared.length < 2) {
        return false;
    }

    // Structural guard: two full person-style names (2+ tokens each) that
    // share exactly one token only agree when it sits in the same position.
    if (ta.length >= 2 && tb.length >= 2 && shared.length === 1) {
        const token = shared[0];
        const firstInA = ta[0] === token;
        const firstInB = tb[0] === token;
        if (firstInA && firstInB) return false; // same first name, different people
    }
    return true;
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
    // S7: a NaN or negative window silently disables every QBO match, which
    // would quietly downgrade every deposit to amount_only.
    const rawWindow = options.dayWindow;
    const window =
        typeof rawWindow === "number" && Number.isFinite(rawWindow) && rawWindow >= 0
            ? rawWindow
            : PAYMENT_DAY_WINDOW;
    const payments = options.qboPayments ?? [];
    const image = options.checkImage ?? null;
    const milestones = options.milestones ?? [];

    const base = {
        depositId: deposit.id,
        postedDate: deposit.postedDate,
        amountCents: deposit.amountCents,
    };

    // Milestones this amount could settle. S2: an already-settled milestone
    // must never be proposed again — that is a double credit.
    const isOpen = (status: string) => !/^(paid|void|cancel)/i.test(status.trim());
    const candidates = milestones
        .filter(m => m.amountCents === deposit.amountCents && isOpen(m.status))
        .sort((a, b) => a.id.localeCompare(b.id));

    // ── Source 2: QBO payment (exact amount, tight date window) ──────────
    // S1: sort the hits so nothing downstream depends on argument order.
    const qboHits = payments
        .filter(p =>
            p.amountCents === deposit.amountCents &&
            Number.isFinite(daysBetween(p.date, deposit.postedDate)) &&
            Math.abs(daysBetween(p.date, deposit.postedDate)) <= window)
        .sort((a, b) =>
            a.date.localeCompare(b.date) ||
            (a.customerName ?? "").localeCompare(b.customerName ?? "") ||
            (a.checkNumber ?? "").localeCompare(b.checkNumber ?? ""));

    // S5: a blank or placeholder customer name is not a payer.
    const cleanName = (n: string | null | undefined) => {
        const t = (n ?? "").trim();
        return t && t !== "-" ? t : null;
    };
    const qboNames = [...new Set(qboHits.map(h => cleanName(h.customerName)).filter(Boolean) as string[])].sort();
    const qboName = qboNames.length === 1 ? qboNames[0] : null;
    const qboCheck = qboHits.map(h => cleanName(h.checkNumber)).find(Boolean) ?? null;

    // ── Source 1: the check image, strongest ─────────────────────────────
    const rawImageName = cleanName(image?.payerName);

    // B4/Kimi: an image is only evidence for THIS deposit if its amount and
    // date agree. Computed ONCE here so every downstream branch honours it —
    // the S3 branch previously skipped this check and could return
    // "verified" off a stale image.
    const imageAmountDisagrees =
        rawImageName !== null && image?.amountCents != null && image.amountCents !== deposit.amountCents;
    const imageDateDelta =
        rawImageName !== null && image?.documentDate
            ? Math.abs(daysBetween(image.documentDate, deposit.postedDate))
            : null;
    const imageDateDisagrees =
        imageDateDelta !== null && (!Number.isFinite(imageDateDelta) || imageDateDelta > window);
    const imageIsForThisDeposit = rawImageName !== null && !imageAmountDisagrees && !imageDateDisagrees;

    // A mismatched image must never act as evidence anywhere.
    const imageName = imageIsForThisDeposit ? rawImageName : null;

    if (rawImageName && !imageIsForThisDeposit) {
        return {
            ...base,
            payerName: rawImageName,
            source: "check_image",
            confidence: "conflict",
            checkNumber: image?.checkNumber ?? qboCheck,
            candidateMilestones: candidates,
            proposedMilestoneId: null,
            reason:
                `The check image does not match this deposit — ` +
                (imageAmountDisagrees
                    ? `image says ${((image!.amountCents ?? 0) / 100).toFixed(2)}, bank says ${(deposit.amountCents / 100).toFixed(2)}. `
                    : `image is dated ${image!.documentDate}, ${imageDateDelta} days from the deposit. `) +
                `It may be filed against the wrong transaction.`,
            needsImage: true,
        };
    }

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
        // S3: consult the IMAGE before giving up. If the strongest evidence
        // names exactly one of the competing customers, it settles the case
        // rather than being thrown away.
        const agreeingQbo = imageName ? qboNames.filter(n => namesAgree(imageName, n)) : [];
        if (imageName && agreeingQbo.length === 1) {
            const m = candidates.filter(c => namesAgree(imageName, c.customerName) || namesAgree(imageName, c.projectName));
            return {
                ...base,
                payerName: imageName,
                source: "check_image",
                confidence: m.length === 1 ? "verified" : "conflict",
                checkNumber: image?.checkNumber ?? qboCheck,
                candidateMilestones: candidates,
                proposedMilestoneId: m.length === 1 ? m[0].id : null,
                reason:
                    `QuickBooks had ${qboNames.length} customers at this amount, but the check ` +
                    `image says ${imageName}` +
                    (m.length === 1 ? ` — settles "${m[0].milestoneName}" on ${m[0].projectName}.` : `. Which milestone it settles is still unclear.`),
                needsImage: false,
            };
        }
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

    // B1 (Codex review): the payer is known and agrees with SEVERAL
    // milestones — the real Hoppe case, three pending milestones at exactly
    // $13,447.68. Previously this fell through to the "no milestone matches"
    // branch, which reported a FALSE reason and set needsImage:false,
    // removing the deposit from the only human worklist. That is the
    // "misattributed forever" hole this module exists to close.
    if (payerName && agreeing.length > 1) {
        const names = agreeing.map(m => `"${m.milestoneName}" (${m.projectName})`).join(", ");
        return {
            ...base,
            payerName,
            source,
            confidence: "conflict",
            checkNumber: image?.checkNumber ?? qboCheck,
            candidateMilestones: candidates,
            proposedMilestoneId: null,
            reason:
                `${payerName} paid ${(deposit.amountCents / 100).toFixed(2)}, but ${agreeing.length} of ` +
                `their milestones are for exactly this amount: ${names}. ` +
                `A human must say which one this settles.`,
            needsImage: !imageName,
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

/**
 * Everything a HUMAN must look at (S4, Codex review). Strictly wider than
 * depositsNeedingImages(): an image-vs-QuickBooks conflict needs no new
 * image — the image is already in hand — but it absolutely needs a person,
 * and without this queue it had nowhere to appear.
 *
 * INVARIANT this enforces: if a deposit proposes no milestone, it is on a
 * queue. Nothing may be silently dropped.
 */
export function depositsNeedingHuman(attributions: DepositAttribution[]): DepositAttribution[] {
    return attributions.filter(a => a.needsImage || a.confidence === "conflict" || a.proposedMilestoneId === null);
}
