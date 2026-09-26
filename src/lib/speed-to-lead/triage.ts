import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { normalizeEndpoint, getEndpointStatus } from "./contact-endpoint";
import {
    MIN_DESCRIPTION_LETTERS,
    MIN_RENDER_TO_SUBMIT_SECONDS,
    serviceAreaCities,
    serviceAreaZipPrefixes,
} from "./constants";
import type { WebIntakePayload } from "./payload";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Every REAL check, and why it failed when it did (spec "Triage (webhook
 * leads)"): "REAL needs every one of these ... If any check fails, the lead
 * is REVIEW with reasons stored."
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
    | "endpoint-suppressed-or-junk"
    | "email-phone-different-clients"
    | "existing-customer";

export interface TriageResult {
    verdict: "REAL" | "REVIEW";
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

/**
 * Existing-customer / cross-client checks (spec: "the email and phone don't
 * match different clients"; "not an existing customer (a client with a
 * Project or Invoice)").
 */
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
 * Full REAL/REVIEW triage for a webhook-authenticated web lead (spec
 * "Triage (webhook leads)"). Only ever called for the WEB source — fallback
 * and VOICE intake are always REVIEW by construction and never call this.
 */
export async function triageWebLead(payload: WebIntakePayload, db: Db = prisma): Promise<TriageResult> {
    const reasons: TriageReason[] = [...pureTriageChecks(payload)];

    const endpoint = await getEndpointStatus(payload.email, db);
    if (endpoint.suppressed || endpoint.junk) reasons.push("endpoint-suppressed-or-junk");

    reasons.push(...(await reuseChecks(payload, db)));
    reasons.push(...(await customerChecks(payload, db)));

    return reasons.length === 0
        ? { verdict: "REAL", reasons: [] }
        : { verdict: "REVIEW", reasons };
}

export { normalizeEndpoint };
