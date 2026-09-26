import { createHash, timingSafeEqual } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { canonicalJson } from "@/lib/mcp-schedule-tools";
import { DISPATCH_FROM_ADDRESS } from "./constants";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Approval (spec "Approval (Justin only, email only)"):
 * "approvalHash = sha256(canonicalJson({environment, companyId, leadId,
 * messageId, generation, channel:"EMAIL", from, to, subject, body, footer,
 * inReplyTo, references, threadId}))". `environment` is VERCEL_ENV plus the
 * app base URL. This app is single-tenant — `companyId` is the same
 * "singleton" id CompanySettings itself uses.
 */
export const COMPANY_ID = "singleton";

export interface ApprovalHashInput {
    leadId: string;
    messageId: string;
    generation: number;
    from: string;
    to: string;
    subject: string;
    body: string;
    footer: string;
    inReplyTo: string | null;
    references: string | null;
    threadId: string | null;
}

export function currentEnvironmentContext(env: NodeJS.ProcessEnv = process.env): string {
    const vercelEnv = env.VERCEL_ENV ?? "development";
    const baseUrl = env.NEXT_PUBLIC_APP_URL ?? env.NEXTAUTH_URL ?? "";
    return `${vercelEnv}|${baseUrl}`;
}

export function computeApprovalHash(input: ApprovalHashInput, env: NodeJS.ProcessEnv = process.env): string {
    const payload = {
        environment: currentEnvironmentContext(env),
        companyId: COMPANY_ID,
        leadId: input.leadId,
        messageId: input.messageId,
        generation: input.generation,
        channel: "EMAIL" as const,
        from: input.from,
        to: input.to,
        subject: input.subject,
        body: input.body,
        footer: input.footer,
        inReplyTo: input.inReplyTo ?? "",
        references: input.references ?? "",
        threadId: input.threadId ?? "",
    };
    return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

/** Constant-time compare of two hex hashes (spec: "compared in constant time"). */
export function hashesMatch(a: string, b: string): boolean {
    const bufA = Buffer.from(a, "hex");
    const bufB = Buffer.from(b, "hex");
    if (bufA.length === 0 || bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
}

export interface ThreadingInfo {
    inReplyTo: string | null;
    references: string | null;
    threadId: string | null;
}

export interface DraftContent {
    to: string;
    subject: string;
    body: string;
    footer: string;
    threading: ThreadingInfo;
    templateVersionId?: string | null;
    renderInputs?: unknown;
}

/**
 * Create the FIRST version (generation 1) of a new outreach message, in
 * DRAFT. Callers pick `dedupeKey` (spec: `OutreachMessage.dedupeKey @unique`)
 * so a retried draft-creation call is idempotent rather than doubling up.
 */
export interface CreateOutreachDraftParams {
    leadId: string;
    kind: "PERSONAL" | "FOLLOWUP" | "TEMPLATE_A";
    dedupeKey: string;
    isTest?: boolean;
    content: DraftContent;
    status?: "DRAFT" | "READY";
}

/**
 * The inner logic, usable INSIDE a transaction the caller already opened
 * (intake.ts's winning webhook transaction, for the Template A message it
 * creates atomically with the Lead). Never opens its own transaction —
 * `Prisma.TransactionClient` has no `$transaction` method, so this must not
 * either.
 */
export async function createOutreachDraftInTx(tx: Db, params: CreateOutreachDraftParams) {
    const existing = await tx.outreachMessage.findUnique({ where: { dedupeKey: params.dedupeKey } });
    if (existing) return existing;
    const message = await tx.outreachMessage.create({
        data: {
            leadId: params.leadId,
            kind: params.kind,
            status: params.status ?? "DRAFT",
            generation: 1,
            dedupeKey: params.dedupeKey,
            isTest: params.isTest ?? false,
        },
    });
    await tx.outreachVersion.create({
        data: {
            messageId: message.id,
            generation: 1,
            to: params.content.to,
            subject: params.content.subject,
            body: params.content.body,
            footer: params.content.footer,
            threading: params.content.threading as unknown as Prisma.InputJsonValue,
            templateVersionId: params.content.templateVersionId ?? null,
            renderInputs: (params.content.renderInputs ?? null) as Prisma.InputJsonValue | undefined,
        },
    });
    return message;
}

/** Top-level entry point: opens its own transaction. See createOutreachDraftInTx for the in-transaction version. */
export async function createOutreachDraft(params: CreateOutreachDraftParams, db: PrismaClient = prisma) {
    return db.$transaction(tx => createOutreachDraftInTx(tx, params));
}

/**
 * Edit or regenerate: a NEW immutable version, never a mutation of an
 * existing one (spec Approval "Versions"). Refuses (throws) once the message
 * has reached DISPATCHING or later — "A version already in DISPATCHING can't
 * be superseded" — the caller renders that as "already in flight".
 */
export async function createNewGeneration(
    messageId: string,
    content: DraftContent,
    db: PrismaClient = prisma,
) {
    return db.$transaction(async tx => {
        const message = await tx.outreachMessage.findUniqueOrThrow({ where: { id: messageId } });
        if (!["DRAFT", "READY", "PENDING_APPROVAL", "APPROVED"].includes(message.status)) {
            throw new Error("already in flight");
        }
        const nextGeneration = message.generation + 1;
        await tx.outreachVersion.create({
            data: {
                messageId,
                generation: nextGeneration,
                to: content.to,
                subject: content.subject,
                body: content.body,
                footer: content.footer,
                threading: content.threading as unknown as Prisma.InputJsonValue,
                templateVersionId: content.templateVersionId ?? null,
                renderInputs: (content.renderInputs ?? null) as Prisma.InputJsonValue | undefined,
            },
        });
        // Editing invalidates any approval in progress on the OLD generation —
        // back to DRAFT, and a fresh approval is required (spec: "The next
        // personal reply is a new draft generation ... and it needs a fresh
        // approval").
        return tx.outreachMessage.update({
            where: { id: messageId },
            data: { generation: nextGeneration, status: "DRAFT", approvedVersionId: null, approvalHash: null, approvedBy: null, approvedAt: null },
        });
    });
}

/**
 * Step 1 of approval: claim the draft so a double-click can't race itself.
 * CAS on (status='DRAFT', generation=version.generation) -> PENDING_APPROVAL.
 */
export async function submitForApproval(messageId: string, versionId: string, db: PrismaClient = prisma) {
    return db.$transaction(async tx => {
        const version = await tx.outreachVersion.findUniqueOrThrow({ where: { id: versionId } });
        if (version.messageId !== messageId) throw new Error("version does not belong to this message");
        const { count } = await tx.outreachMessage.updateMany({
            where: { id: messageId, status: "DRAFT", generation: version.generation },
            data: { status: "PENDING_APPROVAL" },
        });
        if (count === 0) throw new Error("not a fresh draft — reload and try again");
        return version;
    });
}

/**
 * Step 2 of approval: verify the caller's approvalHash matches what the
 * server itself computes right now, and only then mark APPROVED. A mismatch
 * (stale page, edited underneath, wrong environment) reverts to DRAFT rather
 * than leaving the row stuck in PENDING_APPROVAL.
 */
export async function approveOutreachVersion(
    params: { messageId: string; versionId: string; approvalHash: string; approvedBy: string; leadId: string },
    db: PrismaClient = prisma,
) {
    return db.$transaction(async tx => {
        const message = await tx.outreachMessage.findUniqueOrThrow({ where: { id: params.messageId } });
        const version = await tx.outreachVersion.findUniqueOrThrow({ where: { id: params.versionId } });
        if (version.messageId !== params.messageId || version.generation !== message.generation) {
            throw new Error("stale version — a newer draft exists");
        }
        if (message.status !== "PENDING_APPROVAL") {
            throw new Error(`cannot approve from status ${message.status}`);
        }
        const threading = version.threading as unknown as ThreadingInfo;
        const expected = computeApprovalHash({
            leadId: params.leadId,
            messageId: params.messageId,
            generation: version.generation,
            from: DISPATCH_FROM_ADDRESS,
            to: version.to,
            subject: version.subject,
            body: version.body,
            footer: version.footer,
            inReplyTo: threading?.inReplyTo ?? null,
            references: threading?.references ?? null,
            threadId: threading?.threadId ?? null,
        });
        if (!hashesMatch(expected, params.approvalHash)) {
            await tx.outreachMessage.update({ where: { id: params.messageId }, data: { status: "DRAFT" } });
            throw new Error("approval hash mismatch — the draft changed, reload and re-approve");
        }
        return tx.outreachMessage.update({
            where: { id: params.messageId },
            data: {
                status: "APPROVED",
                approvedVersionId: params.versionId,
                approvalHash: expected,
                approvedBy: params.approvedBy,
                approvedAt: new Date(),
            },
        });
    });
}
