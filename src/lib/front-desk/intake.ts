/**
 * Front Desk v1 §1 "Feeding v1a" — the one function the post-call path
 * (post-call.ts) and the missed-transfer path (transfer.ts §3.4) both call,
 * so a call touched by both produces exactly one Lead and one alert row per
 * channel no matter which path runs first or both run concurrently.
 */
import { randomUUID } from "node:crypto";
import type { Prisma, FrontDeskOutcome } from "@prisma/client";
import { findOrCreateClientForContact, createLeadRow } from "@/lib/speed-to-lead/intake";
import { createLeadAlertsInTx } from "@/lib/speed-to-lead/alerts";
import type { TriageReason } from "@/lib/speed-to-lead/triage";

export interface FrontDeskLeadFacts {
    callerName: string | null;
    callbackPhone: string | null;
    email: string | null;
    city: string | null;
    projectType: string | null;
    projectSummary: string | null;
    preferredTimes: string | null;
    messageForRichard: string | null;
    transcriptSummary: string | null;
}

export type FrontDeskAlertChannel = "NTFY_URGENT";

export interface UpsertFrontDeskLeadParams {
    conversationId: string;
    /** post-call always wins a merge conflict over a transfer-time placeholder field (§1 "Feeding v1a" step 3). */
    source: "post-call" | "transfer";
    facts: FrontDeskLeadFacts;
    outcome: FrontDeskOutcome;
    reasons: TriageReason[];
    isTest: boolean;
    /** false only for SPAM — no lead, no alert, the row stays for recovery. */
    needLead: boolean;
    extraChannels: readonly FrontDeskAlertChannel[];
}

export interface UpsertFrontDeskLeadResult {
    leadId: string | null;
    verdict: "REAL" | "REVIEW" | "JUNK" | null;
}

/** The transfer-time placeholder message (§3.4) — replaced by the richer post-call summary when it arrives (§1 step 5). */
export const FRONT_DESK_MISSED_TRANSFER_PLACEHOLDER_MESSAGE = "Missed transfer, details from the call";

type FactsPayload = Record<string, unknown>;

function mergeFrontDeskFacts(existing: FactsPayload, facts: FrontDeskLeadFacts, source: "post-call" | "transfer"): FactsPayload {
    const merged: FactsPayload = { ...existing };
    for (const [key, value] of Object.entries(facts)) {
        if (value === null || value === undefined) continue;
        const currentlySet = merged[key] !== undefined && merged[key] !== null;
        // A non-null post-call field always wins; a transfer-time field only fills a gap.
        if (source === "post-call" || !currentlySet) {
            merged[key] = value;
        }
    }
    return merged;
}

function buildLeadMessage(facts: FrontDeskLeadFacts): string {
    const parts = [
        facts.projectSummary,
        facts.transcriptSummary,
        facts.preferredTimes ? `Preferred times: ${facts.preferredTimes}` : null,
        facts.messageForRichard,
    ].filter((p): p is string => !!p && p.trim().length > 0);
    const joined = parts.join("\n\n").trim();
    return (joined || FRONT_DESK_MISSED_TRANSFER_PLACEHOLDER_MESSAGE).slice(0, 10_000);
}

/**
 * §1 "Feeding v1a" steps 1–8. Runs inside the caller's own transaction.
 * `needLead=false` (SPAM only) never creates a Lead or an alert; the
 * LeadIntakeEvent row is kept, JUNK-verdicted, for recovery on the settings
 * page. A lead that already exists for this conversation is never
 * downgraded by a later SPAM determination.
 */
export async function upsertFrontDeskLeadInTx(
    tx: Prisma.TransactionClient,
    params: UpsertFrontDeskLeadParams,
): Promise<UpsertFrontDeskLeadResult> {
    const externalId = `fd:${params.conversationId}`;

    await tx.$executeRaw`
        INSERT INTO "LeadIntakeEvent" (id, "externalId", source, state, "receivedAt", payload, "isTest", "createdAt", "updatedAt")
        VALUES (${randomUUID()}, ${externalId}, 'FRONT_DESK_CALL'::"LeadIntakeSource", 'PROCESSED'::"LeadIntakeState", now(), '{}'::jsonb, ${params.isTest}, now(), now())
        ON CONFLICT ("externalId") DO NOTHING`;

    const rows = await tx.$queryRaw<{ id: string; leadId: string | null; payload: unknown; verdict: string | null; reasons: unknown }[]>`
        SELECT id, "leadId", payload, verdict, reasons FROM "LeadIntakeEvent" WHERE "externalId" = ${externalId} FOR UPDATE`;
    const current = rows[0];
    if (!current) throw new Error("front-desk lead intake row missing after insert");

    const mergedPayload = mergeFrontDeskFacts((current.payload as FactsPayload | null) ?? {}, params.facts, params.source);
    mergedPayload.outcome = params.outcome;

    if (params.outcome === "SPAM") {
        if (!current.leadId) {
            await tx.leadIntakeEvent.update({
                where: { id: current.id },
                data: { payload: mergedPayload as Prisma.InputJsonValue, verdict: "JUNK", reasons: params.reasons as unknown as Prisma.InputJsonValue },
            });
            return { leadId: null, verdict: "JUNK" };
        }
        // A lead already exists (e.g. an earlier transfer created one) — never downgraded by a later SPAM call.
        await tx.leadIntakeEvent.update({ where: { id: current.id }, data: { payload: mergedPayload as Prisma.InputJsonValue } });
        return { leadId: current.leadId, verdict: current.verdict as UpsertFrontDeskLeadResult["verdict"] };
    }

    let leadId = current.leadId;
    let verdict: UpsertFrontDeskLeadResult["verdict"] = current.verdict as UpsertFrontDeskLeadResult["verdict"];

    if (!leadId && params.needLead) {
        const client = await findOrCreateClientForContact(tx, {
            name: params.facts.callerName ?? "Caller",
            email: params.facts.email,
            phone: params.facts.callbackPhone,
        });
        const lead = await createLeadRow(tx, {
            clientId: client.id,
            name: `${params.facts.callerName ?? "Caller"} - ${params.facts.projectType ?? "Front desk call"}`,
            message: buildLeadMessage(params.facts),
            projectType: params.facts.projectType,
            location: params.facts.city,
            source: "Front Desk Call",
        });
        leadId = lead.id;
        verdict = "REVIEW";
        await tx.leadIntakeEvent.update({
            where: { id: current.id },
            data: { payload: mergedPayload as Prisma.InputJsonValue, leadId, verdict, reasons: params.reasons as unknown as Prisma.InputJsonValue },
        });
    } else if (leadId) {
        const existingReasons = Array.isArray(current.reasons) ? (current.reasons as TriageReason[]) : [];
        const unionReasons = [...new Set([...existingReasons, ...params.reasons])];
        await tx.leadIntakeEvent.update({
            where: { id: current.id },
            data: { payload: mergedPayload as Prisma.InputJsonValue, reasons: unionReasons as unknown as Prisma.InputJsonValue },
        });
        if (params.source === "post-call") {
            const newMessage = buildLeadMessage(params.facts);
            if (newMessage && newMessage !== FRONT_DESK_MISSED_TRANSFER_PLACEHOLDER_MESSAGE) {
                await tx.lead.updateMany({
                    where: { id: leadId, message: FRONT_DESK_MISSED_TRANSFER_PLACEHOLDER_MESSAGE },
                    data: { message: newMessage },
                });
            }
        }
    } else {
        await tx.leadIntakeEvent.update({ where: { id: current.id }, data: { payload: mergedPayload as Prisma.InputJsonValue } });
    }

    if (leadId) {
        await createLeadAlertsInTx(tx, { leadId, verdict: verdict ?? "REVIEW", reasons: params.reasons, isTest: params.isTest });
        for (const channel of params.extraChannels) {
            await tx.$executeRaw`
                INSERT INTO "LeadAlert" (id, "leadId", channel, status, "isTest", "createdAt", "updatedAt")
                VALUES (${randomUUID()}, ${leadId}, ${channel}::"LeadAlertChannel", 'PENDING'::"LeadAlertStatus", ${params.isTest}, now(), now())
                ON CONFLICT ("leadId", channel) DO NOTHING`;
        }
    }

    return { leadId, verdict };
}
