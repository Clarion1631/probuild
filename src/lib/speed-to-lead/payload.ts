import { z } from "zod";

/**
 * The signed web-intake payload (spec Goal 1). Fields beyond name/email/
 * message exist only to feed triage (spec "Triage") and, for
 * smsConsent/attribution, only as stored evidence — "They grant nothing"
 * (spec Non-Goals).
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
    /** Evidence only — see module doc. */
    smsConsent: z.boolean().optional().default(false),
    attribution: z.record(z.string(), z.string().max(500)).optional().default({}),
});

export type WebIntakePayload = z.infer<typeof webIntakePayloadSchema>;
