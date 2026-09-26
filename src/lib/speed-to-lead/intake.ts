import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { triageWebLead } from "./triage";
import { normalizeEndpoint } from "./contact-endpoint";
import type { WebIntakePayload } from "./payload";
import { FALLBACK_DUE_DELAY_MS } from "./constants";
import { evaluateTemplateAEligibility, buildTemplateAContent } from "./template";
import { createOutreachDraftInTx } from "./approval";
import type { RawHeader } from "./authentication";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * `LeadIntakeEvent.externalId` naming (spec Data Model: "externalId
 * @unique" — always set — plus a nullable, also-unique `submissionId`).
 *
 * WEB and WEB_EMAIL_FALLBACK both derive externalId from the SAME
 * submissionId, deterministically and without coordinating — that is what
 * makes `INSERT ... ON CONFLICT ("externalId") DO NOTHING` collapse them into
 * one row no matter which channel gets there first (spec Intake: "the
 * webhook and the email fallback both upsert that row"). VOICE has no
 * submissionId, so its externalId is keyed off the Gmail message id instead.
 */
export function submissionExternalId(submissionId: string): string {
    return `sub:${submissionId}`;
}
export function voiceExternalId(gmailMessageId: string): string {
    return `voice:${gmailMessageId}`;
}

export interface IntakeOutcome {
    /** True when THIS call created the Lead (won the race); false when it only linked to one created elsewhere. */
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
 * WEB webhook intake (spec Intake, Goal 1/2). Runs the 3-step dance so that
 * (a) two concurrent webhook retries for the same submissionId collapse to
 * one lead, and (b) a webhook that finds an existing PENDING_FALLBACK row
 * (the fallback poller got there first) "takes it over" — using its OWN
 * (real, webhook-authenticated) triage rather than the forced-REVIEW verdict
 * a fallback promotion would have used.
 *
 * Never throws on a race — every branch either wins cleanly or discovers it
 * lost and links to the winner's leadId.
 */
export async function intakeWebhookLead(
    payload: WebIntakePayload,
    opts: { receivedAt: Date; isTest?: boolean },
    db: PrismaClient = prisma,
): Promise<IntakeOutcome> {
    const externalId = submissionExternalId(payload.submissionId);
    const isTest = opts.isTest ?? false;

    return db.$transaction(async tx => {
        // Step 1: try the direct, fully-processed insert.
        const directInsert = await tx.$executeRaw`
            INSERT INTO "LeadIntakeEvent" (id, "externalId", "submissionId", source, state, "receivedAt", payload, "isTest", "createdAt", "updatedAt")
            VALUES (${randomUUID()}, ${externalId}, ${payload.submissionId}, 'WEB'::"LeadIntakeSource", 'PROCESSED'::"LeadIntakeState", ${opts.receivedAt}, ${JSON.stringify(payload)}::jsonb, ${isTest}, now(), now())
            ON CONFLICT ("externalId") DO NOTHING`;

        if (directInsert > 0) {
            return runWinningWebTriageAndCreateLead(tx, externalId, payload, isTest, opts.receivedAt);
        }

        // Step 2: maybe there's a PENDING_FALLBACK row for this submission — take it over.
        const takenOver = await tx.$executeRaw`
            UPDATE "LeadIntakeEvent" SET state = 'PROCESSED', payload = ${JSON.stringify(payload)}::jsonb, source = 'WEB', "isTest" = ${isTest}, "updatedAt" = now()
            WHERE "externalId" = ${externalId} AND state = 'PENDING_FALLBACK'`;

        if (takenOver > 0) {
            return runWinningWebTriageAndCreateLead(tx, externalId, payload, isTest, opts.receivedAt);
        }

        // Step 3: lost the race entirely — link to whatever already exists.
        const existing = await tx.leadIntakeEvent.findUnique({ where: { externalId } });
        return { won: false, leadId: existing?.leadId ?? null, verdict: existing?.verdict ?? null };
    });
}

async function runWinningWebTriageAndCreateLead(
    tx: Db,
    externalId: string,
    payload: WebIntakePayload,
    isTest: boolean,
    receivedAt: Date,
): Promise<IntakeOutcome> {
    const triage = await triageWebLead(payload, tx);
    const client = await findOrCreateClientForContact(tx, { name: payload.name, email: payload.email, phone: payload.phone ?? null });
    const leadName = payload.projectType?.trim() ? `${payload.name.trim() || client.id} — ${payload.projectType.trim()}` : payload.name.trim() || "Website inquiry";
    const lead = await createLeadRow(tx, {
        clientId: client.id,
        name: leadName,
        message: payload.message,
        projectType: payload.projectType ?? null,
        location: payload.location ?? null,
    });
    await tx.leadIntakeEvent.update({
        where: { externalId },
        data: { leadId: lead.id, verdict: triage.verdict, reasons: triage.reasons as unknown as Prisma.InputJsonValue },
    });

    // Template A (spec Goal 4, Template A "Eligibility per message"): created
    // ONLY here, at webhook intake — never for a promoted fallback and never
    // for a later Justin promotion to REAL.
    const eligibility = await evaluateTemplateAEligibility(tx, { verdict: triage.verdict, isTest });
    if (eligibility.eligible && eligibility.template) {
        const content = buildTemplateAContent(eligibility.template, {
            leadId: lead.id, name: payload.name, email: payload.email, intakeReceivedAt: receivedAt, isTest,
        });
        await createOutreachDraftInTx(tx, {
            leadId: lead.id,
            kind: "TEMPLATE_A",
            dedupeKey: `template-a:${lead.id}`,
            isTest,
            status: "READY",
            content,
        });
    }

    return { won: true, leadId: lead.id, verdict: triage.verdict };
}

/**
 * Fallback poller (spec Intake: "The poller writes a PENDING_FALLBACK intake
 * with dueAt set to the email time plus 10 minutes, in the same transaction
 * that marks the Gmail message processed and before the cursor advances").
 * `tx` MUST be the caller's own transaction — this does not open one, by
 * design, so the caller can couple it with the cursor write.
 */
export async function recordPendingFallback(
    tx: Db,
    params: { submissionId: string | null; gmailMessageId: string; receivedAt: Date; rawPayload: unknown; isTest?: boolean },
): Promise<void> {
    // No submissionId at all (couldn't parse X-GTR-Submission-Id from the
    // forwarded copy) means this fallback can never be taken over by a
    // webhook — key it off the message itself so it is still exactly-once.
    const externalId = params.submissionId ? submissionExternalId(params.submissionId) : voiceExternalId(params.gmailMessageId);
    const dueAt = new Date(params.receivedAt.getTime() + FALLBACK_DUE_DELAY_MS);
    await tx.$executeRaw`
        INSERT INTO "LeadIntakeEvent" (id, "externalId", "submissionId", source, state, "dueAt", "receivedAt", payload, "isTest", "createdAt", "updatedAt")
        VALUES (${randomUUID()}, ${externalId}, ${params.submissionId}, 'WEB_EMAIL_FALLBACK'::"LeadIntakeSource", 'PENDING_FALLBACK'::"LeadIntakeState", ${dueAt}, ${params.receivedAt}, ${JSON.stringify(params.rawPayload)}::jsonb, ${params.isTest ?? false}, now(), now())
        ON CONFLICT ("externalId") DO NOTHING`;
}

/** The shape recordPendingFallback actually stores — the raw forwarded email, not a structured form payload. */
export interface FallbackRawPayload {
    fromRaw: string;
    bodyText: string;
    headers: RawHeader[];
}

function isFallbackRawPayload(payload: unknown): payload is FallbackRawPayload {
    return !!payload && typeof payload === "object" && typeof (payload as FallbackRawPayload).bodyText === "string";
}

const FALLBACK_EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const FALLBACK_PHONE_PATTERN = /\+?\d[\d\s().-]{6,}\d/;

/**
 * Best-effort contact extraction from the RAW forwarded email
 * (`recordPendingFallback`'s actual stored shape) — there is no structured
 * field list here the way there is for a real webhook payload, so this can
 * only ever feed a REVIEW-quality lead (never REAL; no triage runs on it
 * either way). A previous version of this function read `payload.name`,
 * `.email`, `.phone`, `.message` directly, which recordPendingFallback never
 * wrote, so every promoted fallback lead came out anonymous and empty.
 */
function extractFallbackContact(payload: FallbackRawPayload): { name: string; email: string | null; phone: string | null; message: string } {
    const email = FALLBACK_EMAIL_PATTERN.exec(payload.bodyText)?.[0]?.trim().toLowerCase() ?? null;
    const phone = FALLBACK_PHONE_PATTERN.exec(payload.bodyText)?.[0]?.trim() ?? null;
    const firstLine = payload.bodyText.split("\n").map(l => l.trim()).find(Boolean) ?? "";
    const name = firstLine && firstLine.length <= 200 ? firstLine : "Website inquiry";
    return { name, email, phone, message: payload.bodyText.trim().slice(0, 10_000) };
}

/**
 * Cron-invoked (spec Intake: "Each cron run promotes due rows with a
 * conditional update, but only if they are still PENDING_FALLBACK").
 * Fallback leads are ALWAYS REVIEW, never A — no triage is run.
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
            const rawPayload = event.payload as unknown;
            const contact = isFallbackRawPayload(rawPayload)
                ? extractFallbackContact(rawPayload)
                : { name: "Website inquiry", email: null, phone: null, message: "" };
            const client = await findOrCreateClientForContact(tx, {
                name: contact.name,
                email: contact.email,
                phone: contact.phone,
            });
            const lead = await createLeadRow(tx, {
                clientId: client.id,
                name: contact.name,
                message: contact.message,
                projectType: null,
                location: null,
            });
            // Fallback leads are always REVIEW by construction (spec Intake) — there is
            // no per-check reason list the way triageWebLead produces one.
            await tx.leadIntakeEvent.update({
                where: { id: row.id },
                data: { leadId: lead.id, verdict: "REVIEW", reasons: ["email-fallback"] as unknown as Prisma.InputJsonValue },
            });
            return { won: true, leadId: lead.id, verdict: "REVIEW" } as IntakeOutcome;
        });
        if (outcome) outcomes.push(outcome);
    }
    return outcomes;
}

/**
 * VOICE intake (spec Intake handler order #2): a voicemail/missed-call
 * notification from voice-noreply@google.com. Always REVIEW, processed
 * immediately (no fallback delay — there is nothing to race with).
 */
export async function intakeVoiceEvent(
    params: { gmailMessageId: string; receivedAt: Date; callerPhone: string | null; summary: string; isTest?: boolean },
    db: PrismaClient = prisma,
): Promise<IntakeOutcome> {
    const externalId = voiceExternalId(params.gmailMessageId);
    return db.$transaction(async tx => {
        const inserted = await tx.$executeRaw`
            INSERT INTO "LeadIntakeEvent" (id, "externalId", source, state, "receivedAt", payload, "isTest", "createdAt", "updatedAt")
            VALUES (${randomUUID()}, ${externalId}, 'VOICE'::"LeadIntakeSource", 'PROCESSED'::"LeadIntakeState", ${params.receivedAt}, ${JSON.stringify({ callerPhone: params.callerPhone, summary: params.summary })}::jsonb, ${params.isTest ?? false}, now(), now())
            ON CONFLICT ("externalId") DO NOTHING`;
        if (inserted === 0) {
            const existing = await tx.leadIntakeEvent.findUnique({ where: { externalId } });
            return { won: false, leadId: existing?.leadId ?? null, verdict: existing?.verdict ?? null };
        }
        const client = await findOrCreateClientForContact(tx, { name: params.callerPhone ?? "Voicemail", email: null, phone: params.callerPhone });
        const lead = await createLeadRow(tx, {
            clientId: client.id,
            name: params.callerPhone ? `Voicemail — ${params.callerPhone}` : "Voicemail",
            message: params.summary,
            projectType: null,
            location: null,
        });
        await tx.leadIntakeEvent.update({ where: { externalId }, data: { leadId: lead.id, verdict: "REVIEW" } });
        return { won: true, leadId: lead.id, verdict: "REVIEW" };
    });
}

/**
 * Justin-only promotion to REAL (spec Triage: "Promotion to REAL is
 * Justin-only and never creates A"). Deliberately does NOT touch Template A
 * eligibility — that is evaluated only at webhook intake time.
 */
export async function promoteLeadToReal(leadId: string, db: Db = prisma): Promise<void> {
    await db.leadIntakeEvent.updateMany({ where: { leadId }, data: { verdict: "REAL" } });
}

/** Widened to `Db` (not just `PrismaClient`) so a caller can run this inside its OWN transaction alongside cancelMessagesForLeadInTx — see actions.ts's markLeadJunkAction. */
export async function markLeadIntakeJunk(leadId: string, db: Db = prisma): Promise<void> {
    await db.leadIntakeEvent.updateMany({ where: { leadId }, data: { verdict: "JUNK" } });
}

export { normalizeEndpoint };
