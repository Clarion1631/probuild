import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getEndpointStatus } from "./contact-endpoint";
import {
    MIN_DESCRIPTION_LETTERS,
    MIN_RENDER_TO_SUBMIT_SECONDS,
    serviceAreaCities,
    serviceAreaZipPrefixes,
} from "./constants";
import type { WebIntakePayload } from "./payload";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Every REAL check, and why it failed when it did (webhook leads only —
 * fallback and Voice intake are always REVIEW by construction and never
 * call triageWebLead).
 */
export type TriageReason =
    | "honeypot-filled"
    | "submitted-too-fast"
    | "contains-link"
    | "contains-pitch-word"
    | "description-too-short"
    | "outside-service-area"
    | "phone-reused-different-name"
    | "message-reused-different-name"
    | "endpoint-junk"
    | "email-phone-different-clients"
    | "existing-customer"
    | "email-fallback"
    | "voice"
    | "fallback-unparsed";

export interface TriageResult {
    verdict: "REAL" | "REVIEW" | "JUNK";
    reasons: TriageReason[];
}

const URL_PATTERN = /https?:\/\/|www\.[a-z0-9-]+\.[a-z]{2,}|\b[a-z0-9-]+\.(?:com|net|org|io|co|biz|info|xyz)\b/i;
const PITCH_WORDS = [
    "seo", "backlink", "guaranteed roi", "crypto", "bitcoin", "forex",
    "casino", "loan approved", "investment opportunity", "work from home",
    "click here", "act now", "limited time offer", "make money",
];

function hasLinkOrPitchWords(text: string): { link: boolean; pitch: boolean } {
    const lower = text.toLowerCase();
    return {
        link: URL_PATTERN.test(text),
        pitch: PITCH_WORDS.some(w => lower.includes(w)),
    };
}

function letterCount(text: string): number {
    return (text.match(/[a-z]/gi) ?? []).length;
}

/** True when `location` names a service-area city or zip, or nothing at all. */
export function isServiceAreaOrUnset(location: string | null | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
    const trimmed = (location ?? "").trim();
    if (!trimmed) return true;
    const lower = trimmed.toLowerCase();
    if (serviceAreaCities(env).some(city => lower.includes(city))) return true;
    const zipMatch = /\b(\d{5})\b/.exec(trimmed);
    if (zipMatch && serviceAreaZipPrefixes(env).some(prefix => zipMatch[1].startsWith(prefix))) return true;
    return false;
}

/** True when `submittedAtMs - renderedAtMs` clears the minimum, honoring both directions of clock skew as a failure (never negative). */
export function clearsMinRenderDelay(renderedAtMs: number, submittedAtMs: number): boolean {
    const deltaSeconds = (submittedAtMs - renderedAtMs) / 1000;
    return deltaSeconds >= MIN_RENDER_TO_SUBMIT_SECONDS;
}

/** The checks that need no database — pure and unit-testable on their own. */
export function pureTriageChecks(payload: WebIntakePayload, env: NodeJS.ProcessEnv = process.env): TriageReason[] {
    const reasons: TriageReason[] = [];
    if (payload.honeypot && payload.honeypot.trim().length > 0) reasons.push("honeypot-filled");
    if (!clearsMinRenderDelay(payload.renderedAtMs, payload.submittedAtMs)) reasons.push("submitted-too-fast");

    const { link: msgLink, pitch: msgPitch } = hasLinkOrPitchWords(payload.message);
    if (msgLink) reasons.push("contains-link");
    if (msgPitch) reasons.push("contains-pitch-word");

    if (letterCount(payload.message) < MIN_DESCRIPTION_LETTERS) reasons.push("description-too-short");
    if (!isServiceAreaOrUnset(payload.location, env)) reasons.push("outside-service-area");
    return reasons;
}

/** Reuse checks: same phone or exact message text seen before under a materially different name. */
export async function reuseChecks(payload: WebIntakePayload, db: Db = prisma): Promise<TriageReason[]> {
    const reasons: TriageReason[] = [];

    if (payload.phone && payload.phone.trim()) {
        const priorPhone = await db.leadIntakeEvent.findFirst({
            where: {
                payload: { path: ["phone"], equals: payload.phone.trim() },
                NOT: { payload: { path: ["name"], equals: payload.name } },
            },
            select: { id: true },
        });
        if (priorPhone) reasons.push("phone-reused-different-name");
    }

    const priorMessage = await db.leadIntakeEvent.findFirst({
        where: {
            payload: { path: ["message"], equals: payload.message },
            NOT: { payload: { path: ["name"], equals: payload.name } },
        },
        select: { id: true },
    });
    if (priorMessage) reasons.push("message-reused-different-name");

    return reasons;
}

/** Existing-customer / cross-client checks: the email and phone don't match different clients; not an existing customer (a client with a Project or Invoice). */
export async function customerChecks(payload: WebIntakePayload, db: Db = prisma): Promise<TriageReason[]> {
    const reasons: TriageReason[] = [];
    const email = payload.email.trim().toLowerCase();
    const phone = payload.phone?.trim();

    const [byEmail, byPhone] = await Promise.all([
        db.client.findFirst({ where: { OR: [{ email: { equals: email, mode: "insensitive" } }, { additionalEmail: { equals: email, mode: "insensitive" } }] } }),
        phone
            ? db.client.findFirst({ where: { OR: [{ primaryPhone: phone }, { additionalPhone: phone }, { primaryPhoneE164: phone }, { additionalPhoneE164: phone }] } })
            : Promise.resolve(null),
    ]);

    if (byEmail && byPhone && byEmail.id !== byPhone.id) reasons.push("email-phone-different-clients");

    const matchedClientId = byEmail?.id ?? byPhone?.id;
    if (matchedClientId) {
        const hasHistory = await db.client.findFirst({
            where: { id: matchedClientId, OR: [{ projects: { some: {} } }, { invoices: { some: {} } }] },
            select: { id: true },
        });
        if (hasHistory) reasons.push("existing-customer");
    }

    return reasons;
}

/**
 * Full REAL/REVIEW/JUNK triage for a webhook-authenticated web lead. Only
 * ever called for the WEB source — fallback and VOICE intake are always
 * REVIEW by construction and never call this.
 *
 * A junk-marked endpoint short-circuits to JUNK with zero other reasons —
 * acceptance test 9: "A junk endpoint gives JUNK and zero alert rows."
 */
export async function triageWebLead(payload: WebIntakePayload, db: Db = prisma): Promise<TriageResult> {
    const endpoint = await getEndpointStatus("email", payload.email, db);
    if (endpoint.junk) return { verdict: "JUNK", reasons: ["endpoint-junk"] };

    const reasons: TriageReason[] = [...pureTriageChecks(payload)];
    reasons.push(...(await reuseChecks(payload, db)));
    reasons.push(...(await customerChecks(payload, db)));

    return reasons.length === 0
        ? { verdict: "REAL", reasons: [] }
        : { verdict: "REVIEW", reasons };
}

// ── Alert audience (docs/plans/SPEED-TO-LEAD-V1A.md "(2) Alert design — Who gets what") ─

/** REVIEW reasons that carry a spam signal (get the low-priority ntfy-only treatment); every other REVIEW reason is a plain "needs review" case that still gets a Chat card. */
const SPAM_SIGNAL_REASONS = new Set<TriageReason>([
    "honeypot-filled", "submitted-too-fast", "contains-link", "contains-pitch-word",
    "description-too-short", "phone-reused-different-name", "message-reused-different-name",
]);

export interface AlertAudience {
    ntfy: boolean;
    ntfyPriority: "2" | "4";
    /** Whether this lead is CANDIDATE for a Chat card at all — the caller still gates actual delivery on chatCardsEnabled() (LIVE + production). */
    chat: boolean;
}

/**
 * Pure — no I/O, no mode check. `isTest` overrides the normal REVIEW/spam
 * split (a test lead always reaches both channels, per the alert design
 * table) but a JUNK verdict always wins outright: no channel, ever.
 */
export function alertAudience(verdict: TriageResult["verdict"], reasons: readonly TriageReason[], isTest: boolean): AlertAudience {
    if (verdict === "JUNK") return { ntfy: false, ntfyPriority: "4", chat: false };
    if (isTest) return { ntfy: true, ntfyPriority: "4", chat: true };
    if (verdict === "REAL") return { ntfy: true, ntfyPriority: "4", chat: true };
    const hasSpamSignal = reasons.some(r => SPAM_SIGNAL_REASONS.has(r));
    return hasSpamSignal ? { ntfy: true, ntfyPriority: "2", chat: false } : { ntfy: true, ntfyPriority: "4", chat: true };
}

export { normalizeEndpoint } from "./contact-endpoint";
