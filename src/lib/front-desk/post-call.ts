/**
 * Front Desk v1 §1 — the post-call webhook's envelope schema, fact
 * extraction, and outcome precedence table. The route (post-call/route.ts)
 * owns mode/size/signature/parse/type/agent gating; this module is what runs
 * INSIDE the one interactive transaction once all of that has passed.
 */
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient, FrontDeskOutcome } from "@prisma/client";
import { normalizeCallerPhoneE164 } from "@/lib/speed-to-lead/intake";
import type { TriageReason } from "@/lib/speed-to-lead/triage";
import { upsertFrontDeskLeadInTx } from "./intake";

type Db = PrismaClient | Prisma.TransactionClient;

// ── §1 step 4: envelope schema ──────────────────────────────────────────────

const dataCollectionValueSchema = z.object({ value: z.unknown().optional() }).passthrough();

export const postCallEnvelopeSchema = z.object({
    type: z.string(),
    data: z.object({
        agent_id: z.string().optional().nullable(),
        conversation_id: z.string().min(1),
        metadata: z.object({
            phone_call: z.object({
                external_number: z.string().optional().nullable(),
                agent_number: z.string().optional().nullable(),
                call_sid: z.string().optional().nullable(),
            }).optional().nullable(),
        }).optional().nullable(),
        analysis: z.object({
            call_successful: z.unknown().optional().nullable(),
            transcript_summary: z.string().optional().nullable(),
            data_collection_results: z.record(z.string(), dataCollectionValueSchema).optional().nullable(),
        }).optional().nullable(),
    }),
}).passthrough();

export type PostCallEnvelope = z.infer<typeof postCallEnvelopeSchema>;

// ── §1 "Extraction" ──────────────────────────────────────────────────────

const CALLER_KIND_VALUES = ["new_project", "existing_client", "vendor_or_sales", "spam", "other"] as const;
export type FrontDeskCallerKind = (typeof CALLER_KIND_VALUES)[number];

export interface FrontDeskCallFacts {
    callerName: string | null;
    callbackNumber: string | null;
    email: string | null;
    city: string | null;
    projectType: string | null;
    projectSummary: string | null;
    callerKind: FrontDeskCallerKind | null;
    preferredTimes: string | null;
    messageForRichard: string | null;
    language: string | null;
    transcriptSummary: string | null;
    externalNumber: string | null;
    callSid: string | null;
    phoneE164: string | null;
}

/** One field's extraction, isolated: a bad shape for THIS id never fails the whole webhook. */
function readStringField(results: Record<string, { value?: unknown }> | null | undefined, id: string): string | null {
    try {
        const raw = results?.[id]?.value;
        if (typeof raw !== "string") return null;
        const trimmed = raw.trim();
        return trimmed.length > 0 ? trimmed : null;
    } catch {
        return null;
    }
}

function readCallerKind(results: Record<string, { value?: unknown }> | null | undefined): FrontDeskCallerKind | null {
    try {
        const raw = results?.["caller_kind"]?.value;
        return typeof raw === "string" && (CALLER_KIND_VALUES as readonly string[]).includes(raw) ? (raw as FrontDeskCallerKind) : null;
    } catch {
        return null;
    }
}

/**
 * Every field wrapped so one bad field never fails the webhook (§1
 * "Extraction"). `phoneE164` prefers the confirmed callback number,
 * normalized E.164 US, else the caller ID, else null.
 */
export function extractPostCallFacts(envelope: PostCallEnvelope): FrontDeskCallFacts {
    const results = envelope.data.analysis?.data_collection_results ?? null;
    const callbackNumber = readStringField(results, "callback_number");
    const externalNumber = (() => {
        try {
            const raw = envelope.data.metadata?.phone_call?.external_number;
            return typeof raw === "string" && raw.trim() ? raw.trim() : null;
        } catch {
            return null;
        }
    })();
    const callSid = (() => {
        try {
            const raw = envelope.data.metadata?.phone_call?.call_sid;
            return typeof raw === "string" && raw.trim() ? raw.trim() : null;
        } catch {
            return null;
        }
    })();
    const transcriptSummary = (() => {
        try {
            const raw = envelope.data.analysis?.transcript_summary;
            return typeof raw === "string" && raw.trim() ? raw.trim() : null;
        } catch {
            return null;
        }
    })();

    const phoneCandidate = callbackNumber ?? externalNumber;
    const phoneE164 = phoneCandidate ? normalizeCallerPhoneE164(phoneCandidate) : null;

    return {
        callerName: readStringField(results, "caller_name"),
        callbackNumber,
        email: readStringField(results, "email"),
        city: readStringField(results, "city"),
        projectType: readStringField(results, "project_type"),
        projectSummary: readStringField(results, "project_summary"),
        callerKind: readCallerKind(results),
        preferredTimes: readStringField(results, "preferred_times"),
        messageForRichard: readStringField(results, "message_for_richard"),
        language: readStringField(results, "language"),
        transcriptSummary,
        externalNumber,
        callSid,
        phoneE164,
    };
}

// ── §1 "Outcome" ──────────────────────────────────────────────────────────

export interface PostCallOutcomeResult {
    outcome: FrontDeskOutcome;
    reasons: TriageReason[];
    bookingUncertain: boolean;
}

/**
 * ProBuild's own rows beat the model's claims. The first matching row of
 * §1's table wins. Reads FrontDeskBooking/FrontDeskTransfer for this
 * conversation — always called from inside the caller's transaction so it
 * sees a consistent snapshot alongside the writes that follow it.
 */
export async function determinePostCallOutcome(
    tx: Db,
    conversationId: string,
    callerKind: FrontDeskCallerKind | null,
): Promise<PostCallOutcomeResult> {
    const [bookedRow, uncertainRow, transfer] = await Promise.all([
        tx.frontDeskBooking.findFirst({ where: { conversationId, status: "BOOKED" } }),
        tx.frontDeskBooking.findFirst({ where: { conversationId, status: { in: ["SUBMITTING", "UNCERTAIN"] } } }),
        tx.frontDeskTransfer.findUnique({ where: { conversationId } }),
    ]);
    const bookingUncertain = !!uncertainRow;
    const withUncertain = (reasons: TriageReason[]): TriageReason[] =>
        bookingUncertain ? [...reasons, "front-desk-booking-uncertain"] : reasons;

    if (bookedRow) {
        return { outcome: "BOOKED", reasons: withUncertain(["front-desk-booked"]), bookingUncertain };
    }
    if (transfer && (transfer.status === "CONNECTED" || (transfer.status === "DIALING" && transfer.screenAcceptedAt))) {
        return { outcome: "TRANSFERRED", reasons: withUncertain(["front-desk-transferred"]), bookingUncertain };
    }
    if (transfer && transfer.status === "MISSED") {
        return { outcome: "MISSED_TRANSFER", reasons: withUncertain(["front-desk-missed-transfer"]), bookingUncertain };
    }
    if (transfer && (transfer.status === "PREPARED" || (transfer.status === "DIALING" && !transfer.screenAcceptedAt))) {
        return { outcome: "MESSAGE", reasons: withUncertain(["front-desk-transfer-pending"]), bookingUncertain };
    }
    if (callerKind === "spam" || callerKind === "vendor_or_sales") {
        return { outcome: "SPAM", reasons: ["front-desk-spam"], bookingUncertain: false };
    }
    const reasons: TriageReason[] = ["front-desk-message"];
    if (callerKind === "existing_client") reasons.push("front-desk-existing-client");
    return { outcome: "MESSAGE", reasons: withUncertain(reasons), bookingUncertain };
}

// ── Idempotency (§1 "Idempotency per conversation_id") ──────────────────────

export interface ProcessPostCallResult {
    duplicate: boolean;
    leadId: string | null;
    outcome: FrontDeskOutcome | null;
}

/**
 * Runs INSIDE the caller's transaction. Steps 1–2 of §1's idempotency dance:
 * insert-if-missing, then a conditional UPDATE that only the first delivery
 * wins (`postCallProcessedAt IS NULL`). A concurrent twin blocks on the row
 * lock the UPDATE takes; once the winner commits, the loser's own UPDATE
 * matches zero rows and returns `duplicate: true` with no other writes — a
 * crashed transaction rolls the marker back, so a retry processes it again.
 */
export async function processPostCallInTx(
    tx: Prisma.TransactionClient,
    params: { conversationId: string; agentId: string | null; isTest: boolean; facts: FrontDeskCallFacts },
): Promise<ProcessPostCallResult> {
    const { conversationId, agentId, isTest, facts } = params;

    await tx.$executeRaw`
        INSERT INTO "FrontDeskCall" (id, "conversationId", "agentId", "isTest", "callerPhoneE164", "createdAt", "updatedAt")
        VALUES (${randomUUID()}, ${conversationId}, ${agentId}, ${isTest}, ${facts.phoneE164}, now(), now())
        ON CONFLICT ("conversationId") DO NOTHING`;

    const claimed = await tx.$executeRaw`
        UPDATE "FrontDeskCall"
        SET "postCallProcessedAt" = now(), "updatedAt" = now(), "callerPhoneE164" = COALESCE("callerPhoneE164", ${facts.phoneE164})
        WHERE "conversationId" = ${conversationId} AND "postCallProcessedAt" IS NULL`;

    if (claimed === 0) {
        const existing = await tx.frontDeskCall.findUnique({ where: { conversationId } });
        return { duplicate: true, leadId: existing?.leadId ?? null, outcome: existing?.outcome ?? null };
    }

    const { outcome, reasons, bookingUncertain } = await determinePostCallOutcome(tx, conversationId, facts.callerKind);
    const isSpam = outcome === "SPAM";

    const result = await upsertFrontDeskLeadInTx(tx, {
        conversationId,
        source: "post-call",
        facts: {
            callerName: facts.callerName,
            callbackPhone: facts.phoneE164,
            email: facts.email,
            city: facts.city,
            projectType: facts.projectType,
            projectSummary: facts.projectSummary,
            preferredTimes: facts.preferredTimes,
            messageForRichard: facts.messageForRichard,
            transcriptSummary: facts.transcriptSummary,
        },
        outcome,
        reasons,
        isTest,
        needLead: !isSpam,
        extraChannels: [],
    });

    await tx.frontDeskCall.update({
        where: { conversationId },
        data: { outcome, leadId: result.leadId },
    });

    void bookingUncertain;
    return { duplicate: false, leadId: result.leadId, outcome };
}
