import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { canonicalJson } from "@/lib/mcp-schedule-tools";
import { FIRST_NAME_MAX_LEN, TEMPLATE_A_DEADLINE_MS, templateAEnabled, DISPATCH_FROM_ADDRESS, SITE_FIXED_PHONE, RICHARD_CALENDLY_PREFIX } from "./constants";
import { assertCompliantFooter } from "./contact-endpoint";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Template A (spec "Template A (standing approval)"). Exactly two tokens:
 * {firstName} and {bookingLink}. `contentHash` covers every approved field so
 * Justin's approval is of one exact, reproducible render.
 */
export interface TemplateAFields {
    subject: string;
    body: string;
    footer: string;
    fixedPhone: string;
    bookingBaseUrl: string;
    fromAddress: string;
}

export function templateAContentHash(fields: TemplateAFields): string {
    return createHash("sha256").update(canonicalJson(fields)).digest("hex");
}

/**
 * {firstName}: "the cleaned first word of the name; letters, apostrophe or
 * hyphen, up to 30 characters; otherwise 'there'."
 */
export function renderFirstName(rawName: string): string {
    const firstWord = rawName.trim().split(/\s+/)[0] ?? "";
    const cleaned = firstWord.replace(/[^A-Za-z'-]/g, "");
    if (!cleaned || cleaned.length > FIRST_NAME_MAX_LEN) return "there";
    return cleaned;
}

/** {bookingLink}: bookingBaseUrl plus URL-encoded name and email prefill only. */
export function renderBookingLink(bookingBaseUrl: string, name: string, email: string): string {
    const url = new URL(bookingBaseUrl);
    url.searchParams.set("name", name);
    url.searchParams.set("email", email);
    return url.toString();
}

export interface RenderInputs {
    name: string;
    email: string;
}

/** Substitutes {firstName} and {bookingLink} in `text` — the only two tokens Template A supports. */
export function substituteTokens(text: string, fields: TemplateAFields, inputs: RenderInputs): string {
    const firstName = renderFirstName(inputs.name);
    const bookingLink = renderBookingLink(fields.bookingBaseUrl, inputs.name, inputs.email);
    return text.replaceAll("{firstName}", firstName).replaceAll("{bookingLink}", bookingLink);
}

export interface RenderedTemplateA {
    subject: string;
    body: string;
    footer: string;
}

export function renderTemplateA(fields: TemplateAFields, inputs: RenderInputs): RenderedTemplateA {
    return {
        subject: substituteTokens(fields.subject, fields, inputs),
        body: substituteTokens(fields.body, fields, inputs),
        footer: fields.footer,
    };
}

/** The exact copy from the spec ("Text:") — used to seed the real (non-test) template for Justin's R4 approval, never auto-approved. */
export const TEMPLATE_A_DEFAULT_SUBJECT = "Got your request, {firstName}";
export const TEMPLATE_A_DEFAULT_BODY =
    "Hi {firstName}, thanks for reaching out to Golden Touch Remodeling. Richard got your request, " +
    "and I'll send you a personal reply shortly. If you'd like to talk sooner, pick a time here: " +
    "{bookingLink} or call +1 (360) 200-1521. Justin";

/**
 * The currently-approved, unrevoked template of the given kind (spec Template
 * A: "an approved, unrevoked template exists"; Release: `testOnly` fixture is
 * separate from the real one). Most-recently-approved wins if more than one
 * row somehow qualifies.
 */
export async function getApprovedTemplateA(db: Db, opts: { testOnly: boolean }) {
    return db.outreachTemplate.findFirst({
        where: { testOnly: opts.testOnly, approvedAt: { not: null }, revokedAt: null },
        orderBy: { approvedAt: "desc" },
    });
}

export interface TemplateAEligibility {
    eligible: boolean;
    reason?: string;
    template?: Awaited<ReturnType<typeof getApprovedTemplateA>>;
}

/**
 * Eligibility per message (spec Template A: "An A message is created only at
 * webhook intake, and only if the lead is REAL, the flag is on, and an
 * approved, unrevoked template exists"). Called ONLY from the winning webhook
 * intake transaction — never for a promoted fallback or an after-the-fact
 * REAL promotion ("Promotion to REAL is Justin-only and never creates A").
 */
export async function evaluateTemplateAEligibility(
    db: Db,
    params: { verdict: "REAL" | "REVIEW" | "JUNK"; isTest: boolean; env?: NodeJS.ProcessEnv },
): Promise<TemplateAEligibility> {
    if (params.verdict !== "REAL") return { eligible: false, reason: "lead is not REAL" };
    // The isTest path is exempt from the live SPEED_TO_LEAD_TEMPLATE_A flag —
    // the readiness runner must be able to exercise A end to end before R4
    // turns the real flag on (spec Release: "enabled for readiness runs
    // regardless of SPEED_TO_LEAD_TEMPLATE_A").
    if (!params.isTest && !templateAEnabled(params.env)) return { eligible: false, reason: "SPEED_TO_LEAD_TEMPLATE_A is off" };
    const template = await getApprovedTemplateA(db, { testOnly: params.isTest });
    if (!template) return { eligible: false, reason: "no approved template" };
    return { eligible: true, template };
}

export interface TemplateAMessageInputs {
    leadId: string;
    name: string;
    email: string;
    intakeReceivedAt: Date;
    isTest: boolean;
}

/**
 * Builds the DRAFT-equivalent content for a READY TEMPLATE_A message. Callers
 * (intake.ts) still do the actual `OutreachMessage`/`OutreachVersion` inserts
 * — this only computes what goes in them, so the render logic stays testable
 * without a database.
 */
export function buildTemplateAContent(template: { subject: string; body: string; footer: string; bookingBaseUrl: string; fromAddress: string; fixedPhone: string; id: string }, inputs: TemplateAMessageInputs) {
    const fields: TemplateAFields = {
        subject: template.subject, body: template.body, footer: template.footer,
        fixedPhone: template.fixedPhone, bookingBaseUrl: template.bookingBaseUrl, fromAddress: template.fromAddress,
    };
    const rendered = renderTemplateA(fields, { name: inputs.name, email: inputs.email });
    return {
        to: inputs.email,
        subject: rendered.subject,
        body: rendered.body,
        footer: rendered.footer,
        threading: { inReplyTo: null, references: null, threadId: null },
        templateVersionId: template.id,
        renderInputs: { name: inputs.name, email: inputs.email, intakeReceivedAt: inputs.intakeReceivedAt.toISOString(), isTest: inputs.isTest },
    };
}

/** Spec Template A: "commits only within 15 minutes of the intake's server receive time." */
export function templateADeadlinePassed(intakeReceivedAt: Date, now: Date = new Date()): boolean {
    return now.getTime() - intakeReceivedAt.getTime() > TEMPLATE_A_DEADLINE_MS;
}

/**
 * Required content, enforced server-side rather than trusted from whatever
 * called this — a template accepting arbitrary fields let an approved
 * message go out with no opt-out instructions, or with the booking link
 * (which carries the lead's own name/email as query params, spec Template A
 * "{bookingLink}") pointed at an unintended domain that would then receive
 * that PII.
 */
function assertValidTemplateFields(fields: TemplateAFields): void {
    if (fields.fromAddress !== DISPATCH_FROM_ADDRESS) {
        throw new Error(`invalid fromAddress: Speed-to-Lead only ever sends as ${DISPATCH_FROM_ADDRESS}`);
    }
    if (fields.fixedPhone !== SITE_FIXED_PHONE) {
        throw new Error(`invalid fixedPhone: must be the site's own number (${SITE_FIXED_PHONE})`);
    }
    // A bare `startsWith` on the raw string is bypassable: `.../richard.../
    // ../other-owner/consult` literally STARTS WITH the expected prefix text
    // even though a normalizing parser (or `new URL()` itself) resolves the
    // ".." segment to a path OUTSIDE it. Comparing the ORIGIN plus the
    // PARSED (already `..`-resolved) pathname against the expected prefix's
    // own parsed pathname closes that.
    let parsedBookingUrl: URL;
    try {
        parsedBookingUrl = new URL(fields.bookingBaseUrl);
    } catch {
        throw new Error(`invalid bookingBaseUrl: not a valid URL`);
    }
    const expectedPrefix = new URL(RICHARD_CALENDLY_PREFIX);
    if (parsedBookingUrl.origin !== expectedPrefix.origin || !parsedBookingUrl.pathname.startsWith(expectedPrefix.pathname)) {
        throw new Error(`invalid bookingBaseUrl: must be under ${RICHARD_CALENDLY_PREFIX} — the booking link carries the lead's own name/email, so it may never point at an arbitrary domain`);
    }
    assertCompliantFooter(fields.footer, "footer");
}

/** Creates a new (unapproved) template row — Justin approves it separately (spec Template A "durable approval"). */
export async function createOutreachTemplate(fields: TemplateAFields & { testOnly: boolean }, db: Db) {
    assertValidTemplateFields(fields);
    const contentHash = templateAContentHash(fields);
    return db.outreachTemplate.create({ data: { ...fields, contentHash } });
}

/** Durable approval of an exact version — "revoking it takes effect at the next commit" (spec Template A). */
export async function approveTemplate(templateId: string, approvedBy: string, db: Db) {
    return db.outreachTemplate.update({ where: { id: templateId }, data: { approvedAt: new Date(), approvedBy, revokedAt: null } });
}

export async function revokeTemplate(templateId: string, db: Db) {
    return db.outreachTemplate.update({ where: { id: templateId }, data: { revokedAt: new Date() } });
}

export { DISPATCH_FROM_ADDRESS };
