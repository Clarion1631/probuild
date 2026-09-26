import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { CLOSED_LEAD_STAGES } from "@/lib/gpt-estimate";
import { triageWebLead, type TriageReason } from "./triage";
import { normalizeEndpoint } from "./contact-endpoint";
import type { WebIntakePayload, FallbackPayload } from "./payload";
import { CROSS_CHANNEL_DEDUPE_WINDOW_MS, FALLBACK_DUE_DELAY_MS, VOICE_REPEAT_CALL_WINDOW_MS, INTAKE_TX_TIMEOUT_MS, INTAKE_TX_MAX_WAIT_MS } from "./constants";
import { createLeadAlertsInTx } from "./alerts";
import { logLeadEvent } from "./audit";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * `LeadIntakeEvent.externalId` naming — always set, plus a nullable, also-
 * unique `submissionId`. WEB and WEB_EMAIL_FALLBACK both derive externalId
 * from the SAME submissionId, deterministically and without coordinating —
 * that is what makes `INSERT ... ON CONFLICT ("externalId") DO NOTHING`
 * collapse them into one row no matter which channel gets there first. VOICE
 * has no submissionId, so its externalId is keyed off the Gmail message id.
 */
export function submissionExternalId(submissionId: string): string {
    return `sub:${submissionId}`;
}
export function voiceExternalId(gmailMessageId: string): string {
    return `voice:${gmailMessageId}`;
}

export interface IntakeOutcome {
    /** True when THIS call created (or first linked) the Lead; false when it only discovered one created elsewhere. */
    won: boolean;
    leadId: string | null;
    verdict: "REAL" | "REVIEW" | "JUNK" | null;
}

async function findOrCreateClientForContact(
    tx: Db,
    contact: { name: string; email: string | null; phone: string | null },
): Promise<{ id: string }> {
    const email = contact.email ? contact.email.trim().toLowerCase() : null;
    const phone = contact.phone?.trim() || null;
    if (email || phone) {
        const existing = await tx.client.findFirst({
            where: {
                OR: [
                    ...(email ? [{ email: { equals: email, mode: "insensitive" as const } }] : []),
                    ...(phone ? [{ primaryPhone: phone }, { primaryPhoneE164: phone }] : []),
                ],
            },
        });
        if (existing) return existing;
    }
    const name = contact.name.trim() || "Website inquiry";
    const initials = name.split(/\s+/).map(w => w[0]?.toUpperCase() ?? "").slice(0, 2).join("") || "W";
    return tx.client.create({
        data: { name, initials, email: contact.email?.trim() || null, primaryPhone: contact.phone?.trim() || null },
    });
}

async function createLeadRow(
    tx: Db,
    input: { clientId: string; name: string; message: string; projectType: string | null; location: string | null },
) {
    return tx.lead.create({
        data: {
            clientId: input.clientId,
            name: input.name,
            message: input.message,
            projectType: input.projectType,
            location: input.location,
            source: "Website",
        },
    });
}

/**
 * Cross-channel dedupe by email (V1A "Other defects found writing this"):
 * a fallback with no `submissionId` and a webhook for the same email within
 * 15 minutes must produce ONE Lead, in either order. `pg_advisory_xact_lock`
 * on the normalized email serializes the webhook and the fallback promotion
 * against each other so only one of them ever creates the Lead row; the
 * other links to it. Returns the resolved lead, creating one if nothing
 * recent enough is found.
 */
async function resolveOrCreateLead(
    tx: Db,
    params: {
        email: string | null;
        phone: string | null;
        name: string;
        message: string;
        projectType: string | null;
        location: string | null;
        excludeExternalId: string;
    },
): Promise<{ leadId: string; isNewLead: boolean }> {
    if (params.email) {
        const normalized = params.email.trim().toLowerCase();
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${normalized}))`;
        const since = new Date(Date.now() - CROSS_CHANNEL_DEDUPE_WINDOW_MS);
        const existing = await tx.$queryRaw<{ leadId: string }[]>`
            SELECT "leadId" FROM "LeadIntakeEvent"
            WHERE source IN ('WEB', 'WEB_EMAIL_FALLBACK')
              AND "externalId" != ${params.excludeExternalId}
              AND "leadId" IS NOT NULL
              AND "receivedAt" >= ${since}
              AND LOWER(payload->>'email') = ${normalized}
            ORDER BY "receivedAt" DESC
            LIMIT 1`;
        if (existing[0]?.leadId) return { leadId: existing[0].leadId, isNewLead: false };
    }
    const client = await findOrCreateClientForContact(tx, { name: params.name, email: params.email, phone: params.phone });
    const lead = await createLeadRow(tx, {
        clientId: client.id,
        name: params.name,
        message: params.message,
        projectType: params.projectType,
        location: params.location,
    });
    return { leadId: lead.id, isNewLead: true };
}

/**
 * WEB webhook intake. `isTest` is a caller-verified claim — the route is
 * what actually checks the HMAC signature against LEAD_INGEST_TEST_SECRET
 * (or refuses with 401 and zero rows on any failure); this function never
 * re-derives or downgrades it. Runs the 3-step dance so that (a) two
 * concurrent webhook retries for the same submissionId collapse to one
 * lead, and (b) a webhook that finds an existing PENDING_FALLBACK row (the
 * fallback poller got there first) "takes it over" — using its OWN (real,
 * webhook-authenticated) triage rather than the forced-REVIEW verdict a
 * fallback promotion would have used.
 *
 * Never throws on a race — every branch either wins cleanly or discovers it
 * lost and links to the winner's leadId.
 */
export async function intakeWebhookLead(
    payload: WebIntakePayload,
    opts: { receivedAt: Date; isTest: boolean },
    db: PrismaClient = prisma,
): Promise<IntakeOutcome> {
    const externalId = submissionExternalId(payload.submissionId);
    const isTest = opts.isTest;

    return db.$transaction(async tx => {
        // Step 1: try the direct, fully-processed insert.
        const directInsert = await tx.$executeRaw`
            INSERT INTO "LeadIntakeEvent" (id, "externalId", "submissionId", source, state, "receivedAt", payload, "isTest", "createdAt", "updatedAt")
            VALUES (${randomUUID()}, ${externalId}, ${payload.submissionId}, 'WEB'::"LeadIntakeSource", 'PROCESSED'::"LeadIntakeState", ${opts.receivedAt}, ${JSON.stringify(payload)}::jsonb, ${isTest}, now(), now())
            ON CONFLICT ("externalId") DO NOTHING`;

        if (directInsert > 0) {
            return runWinningWebTriageAndCreateLead(tx, externalId, payload, isTest);
        }

        // Step 2: maybe there's a PENDING_FALLBACK row for this submission — take it over.
        const takenOver = await tx.$executeRaw`
            UPDATE "LeadIntakeEvent" SET state = 'PROCESSED', payload = ${JSON.stringify(payload)}::jsonb, source = 'WEB', "isTest" = ${isTest}, "updatedAt" = now()
            WHERE "externalId" = ${externalId} AND state = 'PENDING_FALLBACK'`;

        if (takenOver > 0) {
            return runWinningWebTriageAndCreateLead(tx, externalId, payload, isTest);
        }

        // Step 3: lost the race entirely — link to whatever already exists.
        const existing = await tx.leadIntakeEvent.findUnique({ where: { externalId } });
        return { won: false, leadId: existing?.leadId ?? null, verdict: existing?.verdict ?? null };
    }, { timeout: INTAKE_TX_TIMEOUT_MS, maxWait: INTAKE_TX_MAX_WAIT_MS });
}

async function runWinningWebTriageAndCreateLead(
    tx: Db,
    externalId: string,
    payload: WebIntakePayload,
    isTest: boolean,
): Promise<IntakeOutcome> {
    const triage = await triageWebLead(payload, tx);
    const { leadId } = await resolveOrCreateLead(tx, {
        email: payload.email,
        phone: payload.phone ?? null,
        name: payload.projectType?.trim() ? `${payload.name.trim() || "Website inquiry"} — ${payload.projectType.trim()}` : payload.name.trim() || "Website inquiry",
        message: payload.message,
        projectType: payload.projectType ?? null,
        location: payload.location ?? null,
        excludeExternalId: externalId,
    });
    await tx.leadIntakeEvent.update({
        where: { externalId },
        data: { leadId, verdict: triage.verdict, reasons: triage.reasons as unknown as Prisma.InputJsonValue },
    });
    await createLeadAlertsInTx(tx, { leadId, verdict: triage.verdict, reasons: triage.reasons, isTest });
    return { won: true, leadId, verdict: triage.verdict };
}

/**
 * Fallback poller (Gmail poll, "Modify" per V1A: the poller parses ONCE, at
 * write, into `fallbackPayloadSchema` — never a raw `{fromRaw,bodyText,
 * headers}` blob re-parsed at promotion time). `tx` MUST be the caller's own
 * transaction — this does not open one, by design, so the caller can couple
 * it with the cursor write.
 *
 * A fallback carrying `submissionId` waits `FALLBACK_DUE_DELAY_MS` (its
 * webhook twin, if any, gets first refusal); one without is due immediately
 * — there is no webhook to wait for.
 */
export async function recordPendingFallback(tx: Db, params: { gmailMessageId: string; receivedAt: Date; payload: FallbackPayload; isTest?: boolean }): Promise<void> {
    const externalId = params.payload.submissionId ? submissionExternalId(params.payload.submissionId) : voiceExternalId(params.gmailMessageId);
    const dueAt = params.payload.submissionId
        ? new Date(params.receivedAt.getTime() + FALLBACK_DUE_DELAY_MS)
        : params.receivedAt;
    await tx.$executeRaw`
        INSERT INTO "LeadIntakeEvent" (id, "externalId", "submissionId", source, state, "dueAt", "receivedAt", payload, "isTest", "createdAt", "updatedAt")
        VALUES (${randomUUID()}, ${externalId}, ${params.payload.submissionId}, 'WEB_EMAIL_FALLBACK'::"LeadIntakeSource", 'PENDING_FALLBACK'::"LeadIntakeState", ${dueAt}, ${params.receivedAt}, ${JSON.stringify(params.payload)}::jsonb, ${params.isTest ?? false}, now(), now())
        ON CONFLICT ("externalId") DO NOTHING`;
}

/**
 * Cron-invoked: promotes due rows with a conditional update, but only if
 * they are still PENDING_FALLBACK. Fallback leads are ALWAYS REVIEW, never
 * REAL — no triage is run. A payload that failed to parse at write time
 * (`parsed: false`) still promotes, as a "Website inquiry" lead carrying
 * reason `fallback-unparsed` — never dropped, still alerted.
 */
export async function promoteDueFallbacks(now: Date, db: PrismaClient = prisma): Promise<IntakeOutcome[]> {
    const due = await db.leadIntakeEvent.findMany({
        where: { state: "PENDING_FALLBACK", dueAt: { lte: now } },
        select: { id: true, externalId: true },
    });
    const outcomes: IntakeOutcome[] = [];
    for (const row of due) {
        const outcome = await db.$transaction(async tx => {
            const { count } = await tx.leadIntakeEvent.updateMany({
                where: { id: row.id, state: "PENDING_FALLBACK" },
                data: { state: "PROCESSED" },
            });
            if (count === 0) return null; // a webhook took it over between the read above and here
            const event = await tx.leadIntakeEvent.findUniqueOrThrow({ where: { id: row.id } });
            const payload = event.payload as unknown as FallbackPayload;
            const reasons: TriageReason[] = payload.parsed ? ["email-fallback"] : ["fallback-unparsed"];
            const { leadId } = await resolveOrCreateLead(tx, {
                email: payload.email,
                phone: payload.phone,
                name: payload.name?.trim() || "Website inquiry",
                message: payload.message,
                projectType: null,
                location: payload.city,
                excludeExternalId: event.externalId,
            });
            await tx.leadIntakeEvent.update({
                where: { id: row.id },
                data: { leadId, verdict: "REVIEW", reasons: reasons as unknown as Prisma.InputJsonValue },
            });
            await createLeadAlertsInTx(tx, { leadId, verdict: "REVIEW", reasons, isTest: event.isTest });
            return { won: true, leadId, verdict: "REVIEW" } as IntakeOutcome;
        });
        if (outcome) outcomes.push(outcome);
    }
    return outcomes;
}

/** From `(NNN) NNN-NNNN` — R0 found the naive digit-scan regex drops the opening "(", which the E.164 normalizer below does not need but is worth keeping intact for display/logging. */
const PHONE_PATTERN = /\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/;

/** US-only E.164 normalization for a Voice caller ID shaped like `(360) 555-0100` or `+13605550100`. Returns null rather than guessing at a non-US shape. */
export function normalizeCallerPhoneE164(raw: string): string | null {
    const digits = raw.replace(/\D/g, "");
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits[0] === "1") return `+${digits}`;
    return null;
}

async function findExistingCustomerClientId(tx: Db, phoneE164: string): Promise<string | null> {
    const client = await tx.client.findFirst({
        where: {
            OR: [{ primaryPhoneE164: phoneE164 }, { additionalPhoneE164: phoneE164 }],
            AND: { OR: [{ projects: { some: {} } }, { invoices: { some: {} } }] },
        },
        select: { id: true },
    });
    return client?.id ?? null;
}

/** The most recent open (not booked, not called, not closed, not archived) lead from a VOICE intake with this exact caller phone within the repeat-call window. */
async function findOpenLeadByPhone(tx: Db, phoneE164: string, now: Date): Promise<string | null> {
    const since = new Date(now.getTime() - VOICE_REPEAT_CALL_WINDOW_MS);
    const rows = await tx.$queryRaw<{ leadId: string }[]>`
        SELECT le."leadId" AS "leadId"
        FROM "LeadIntakeEvent" le
        JOIN "Lead" l ON l.id = le."leadId"
        WHERE le.source = 'VOICE'
          AND le."leadId" IS NOT NULL
          AND le."receivedAt" >= ${since}
          AND payload ->> 'callerPhone' = ${phoneE164}
          AND l."bookedAt" IS NULL
          AND l."calledAt" IS NULL
          AND l."isArchived" = false
          AND l.stage NOT IN (${Prisma.join(CLOSED_LEAD_STAGES)})
        ORDER BY le."receivedAt" DESC
        LIMIT 1`;
    return rows[0]?.leadId ?? null;
}

/**
 * VOICE intake: a voicemail/missed-call notification from
 * voice-noreply@google.com, already subject- and authentication-filtered by
 * `authenticateMessage`. Always REVIEW when it creates a lead at all.
 *
 *  - An existing customer's number (a Client with a Project or Invoice)
 *    creates no Lead and no alert; the row is still recorded (so a
 *    re-processed Gmail message stays idempotent) and a SpeedToLeadEvent
 *    notes why.
 *  - A repeat call within 7 days of an open lead links to it — the
 *    idempotent `ON CONFLICT DO NOTHING` alert insert then naturally
 *    produces no NEW alert, since that lead's channel rows already exist.
 */
export async function intakeVoiceEvent(
    params: { gmailMessageId: string; receivedAt: Date; callerPhoneRaw: string | null; summary: string; isTest?: boolean },
    db: PrismaClient = prisma,
): Promise<IntakeOutcome> {
    const externalId = voiceExternalId(params.gmailMessageId);
    const phoneMatch = params.callerPhoneRaw ? PHONE_PATTERN.exec(params.callerPhoneRaw)?.[0] ?? null : null;
    const phoneE164 = phoneMatch ? normalizeCallerPhoneE164(phoneMatch) : null;

    return db.$transaction(async tx => {
        const inserted = await tx.$executeRaw`
            INSERT INTO "LeadIntakeEvent" (id, "externalId", source, state, "receivedAt", payload, "isTest", "createdAt", "updatedAt")
            VALUES (${randomUUID()}, ${externalId}, 'VOICE'::"LeadIntakeSource", 'PROCESSED'::"LeadIntakeState", ${params.receivedAt}, ${JSON.stringify({ callerPhone: phoneE164, summary: params.summary })}::jsonb, ${params.isTest ?? false}, now(), now())
            ON CONFLICT ("externalId") DO NOTHING`;
        if (inserted === 0) {
            const existing = await tx.leadIntakeEvent.findUnique({ where: { externalId } });
            return { won: false, leadId: existing?.leadId ?? null, verdict: existing?.verdict ?? null };
        }

        if (phoneE164) {
            const existingCustomer = await findExistingCustomerClientId(tx, phoneE164);
            if (existingCustomer) {
                await tx.leadIntakeEvent.update({ where: { externalId }, data: { verdict: null, reasons: ["existing-customer"] as unknown as Prisma.InputJsonValue } });
                await logLeadEvent(tx, { kind: "voice-existing-customer-ignored", detail: { clientId: existingCustomer } });
                return { won: false, leadId: null, verdict: null };
            }

            const openLeadId = await findOpenLeadByPhone(tx, phoneE164, params.receivedAt);
            if (openLeadId) {
                await tx.leadIntakeEvent.update({ where: { externalId }, data: { leadId: openLeadId, verdict: "REVIEW", reasons: ["voice"] as unknown as Prisma.InputJsonValue } });
                await createLeadAlertsInTx(tx, { leadId: openLeadId, verdict: "REVIEW", reasons: ["voice"], isTest: params.isTest ?? false });
                return { won: true, leadId: openLeadId, verdict: "REVIEW" };
            }
        }

        const client = await findOrCreateClientForContact(tx, { name: phoneE164 ?? "Voicemail", email: null, phone: phoneE164 });
        const lead = await createLeadRow(tx, {
            clientId: client.id,
            name: phoneE164 ? `Voicemail — ${phoneE164}` : "Voicemail",
            message: params.summary,
            projectType: null,
            location: null,
        });
        await tx.leadIntakeEvent.update({ where: { externalId }, data: { leadId: lead.id, verdict: "REVIEW", reasons: ["voice"] as unknown as Prisma.InputJsonValue } });
        await createLeadAlertsInTx(tx, { leadId: lead.id, verdict: "REVIEW", reasons: ["voice"], isTest: params.isTest ?? false });
        return { won: true, leadId: lead.id, verdict: "REVIEW" };
    }, { timeout: INTAKE_TX_TIMEOUT_MS, maxWait: INTAKE_TX_MAX_WAIT_MS });
}

/** Justin-only promotion to REAL. Deliberately creates no alert — a REAL verdict determined at intake time already alerted; a later manual promotion is not a new arrival. */
export async function promoteLeadToReal(leadId: string, db: Db = prisma): Promise<void> {
    await db.leadIntakeEvent.updateMany({ where: { leadId }, data: { verdict: "REAL" } });
}

/** Widened to `Db` (not just `PrismaClient`) so a caller can run this inside its own transaction. */
export async function markLeadIntakeJunk(leadId: string, db: Db = prisma): Promise<void> {
    await db.leadIntakeEvent.updateMany({ where: { leadId }, data: { verdict: "JUNK" } });
}

export { normalizeEndpoint };
