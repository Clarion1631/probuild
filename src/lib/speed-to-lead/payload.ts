import { z } from "zod";

/**
 * The signed web-intake payload (webhook path). Fields beyond name/email/
 * message exist only to feed triage — v1a sends nothing, so nothing here
 * "grants" any customer contact.
 */
export const webIntakePayloadSchema = z.object({
    submissionId: z.string().trim().min(1).max(200),
    name: z.string().trim().min(1).max(200),
    email: z.string().trim().email().max(300),
    phone: z.string().trim().max(50).optional().nullable(),
    message: z.string().trim().max(10_000),
    projectType: z.string().trim().max(200).optional().nullable(),
    location: z.string().trim().max(300).optional().nullable(),
    /** Honeypot field the site renders hidden; a bot that fills it fails triage instantly. */
    honeypot: z.string().max(1000).optional().default(""),
    /** Server time (ms since epoch) the site rendered the form. */
    renderedAtMs: z.number().finite(),
    /** Server time (ms since epoch) the site received the submit. */
    submittedAtMs: z.number().finite(),
    /** Evidence only — v1a has no consent-gated send to grant. */
    smsConsent: z.boolean().optional().default(false),
    attribution: z.record(z.string(), z.string().max(500)).optional().default({}),
});

export type WebIntakePayload = z.infer<typeof webIntakePayloadSchema>;

/**
 * The typed shape the Gmail-fallback poller writes at parse time and
 * `promoteDueFallbacks` reads back (finding 5 — V1A addendum §1, §3#5).
 * `email` is taken from `Reply-To` (a single address); the rest come from
 * the site's own labelled fields (`Name/Email/Phone/Message/Project city/
 * Project scope`) in gtr-sales-draft's `src/app/api/contact/route.ts`,
 * HTML-entity decoded. A parse failure never blocks the lead — it stores
 * whatever fields it found and `fallback-email.ts` reports which ones were
 * missing so intake.ts can fall back to a "Website inquiry" REVIEW lead.
 */
export const fallbackPayloadSchema = z.object({
    name: z.string().trim().min(1).max(200).nullable(),
    email: z.string().trim().email().max(300).nullable(),
    phone: z.string().trim().max(50).nullable(),
    city: z.string().trim().max(300).nullable(),
    scope: z.string().trim().max(300).nullable(),
    message: z.string().trim().max(10_000),
    submissionId: z.string().trim().min(1).max(200).nullable(),
    /** True when every field above except `message` was actually parsed out of the body — never true for a malformed/unrecognized shape. */
    parsed: z.boolean(),
    /** The trust rule that authenticated this message (e.g. "website-group-relay", "voice-direct") — never raw headers (V1A "store the matched trust rule, not raw headers"). */
    matchedRule: z.string(),
});

export type FallbackPayload = z.infer<typeof fallbackPayloadSchema>;
