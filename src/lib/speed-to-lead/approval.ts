import { createHash, timingSafeEqual } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { canonicalJson } from "@/lib/mcp-schedule-tools";
import { DISPATCH_FROM_ADDRESS } from "./constants";
import { isValidSingleRecipient, assertNoHeaderInjection, assertCompliantFooter } from "./contact-endpoint";
import { logOutreachEvent } from "./audit";

type Db = PrismaClient | Prisma.TransactionClient;

/** Matches the OutreachStatus enum (prisma/schema.prisma) — used to cast a raw-query-read status string back to Prisma's enum type after it has already been validated against an explicit allowlist. */
type OutreachStatusValue = "DRAFT" | "READY" | "PENDING_APPROVAL" | "APPROVED" | "DISPATCHING" | "SENT" | "FAILED" | "UNKNOWN_DELIVERY" | "CANCELLED" | "SUPERSEDED" | "EXPIRED" | "BLOCKED";

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
    // Recipient format / header-injection only — NOT the footer-compliance
    // check assertValidDraftContent also runs at edit time: an initial
    // TEMPLATE_A draft's footer comes straight from an already-validated
    // template (see template.ts's own assertValidTemplateFields), and
    // readiness.ts's own internal test fixtures intentionally use a
    // non-commercial footer for a check that never leaves isTest/allowlisted
    // recipients — this only closes "invalid content can consume an attempt
    // first" for the part every caller must satisfy regardless.
    assertValidRecipientAndHeaders(params.content);
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
    await logOutreachEvent(tx, { leadId: params.leadId, messageId: message.id, kind: "draft-created", detail: { kind: params.kind } });
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
/**
 * The recipient-format/header-injection half of draft validation — split out
 * from the footer-compliance check below so it can run at EVERY stage a
 * message's content is ever written or re-checked (initial creation,
 * edit/regenerate, approval, and dispatch's own commit), not only at the
 * edit boundary. Without this at creation/approval/commitment, invalid
 * content could ride all the way to an OutreachAttempt (consuming a daily-cap
 * slot and an attempt) before buildRawMessage finally caught it at send time.
 */
export function assertValidRecipientAndHeaders(content: Pick<DraftContent, "to" | "subject" | "threading">): void {
    if (!isValidSingleRecipient(content.to)) throw new Error("invalid recipient: exactly one mailbox address is required");
    assertNoHeaderInjection(content.subject, "subject");
    if (content.threading.inReplyTo) assertNoHeaderInjection(content.threading.inReplyTo, "inReplyTo");
    if (content.threading.references) assertNoHeaderInjection(content.threading.references, "references");
}

/**
 * Validated once here, at the EDIT boundary (the approval UI's "To" field is
 * a plain editable text input), and again at buildRawMessage — the actual
 * RFC822-building boundary — so a CRLF-injected Bcc or a comma-separated
 * recipient list can never reach either a stored draft or a sent message.
 */
function assertValidDraftContent(content: DraftContent): void {
    assertValidRecipientAndHeaders(content);
    // Required content, enforced server-side rather than trusted from the
    // caller: an empty or non-compliant footer would leave an approved,
    // sent message with no opt-out instructions (or mailing address) at all.
    assertCompliantFooter(content.footer, "footer");
}

/** The ordinary "edit a draft" source statuses. Send-again needs a DIFFERENT set (FAILED/UNKNOWN_DELIVERY) — see the `allowedStatuses` param below, which callers pass explicitly rather than this default silently growing to cover both. */
const DEFAULT_EDITABLE_STATUSES = ["DRAFT", "READY", "PENDING_APPROVAL", "APPROVED"] as const;

export async function createNewGeneration(
    messageId: string,
    content: DraftContent,
    db: PrismaClient = prisma,
    opts: { allowedStatuses?: readonly string[]; targetStatus?: "DRAFT" | "READY" } = {},
) {
    assertValidDraftContent(content);
    const allowedStatuses = opts.allowedStatuses ?? DEFAULT_EDITABLE_STATUSES;
    // Personal/follow-up edits and resends land back in DRAFT and need a
    // fresh approval (spec Approval "Versions"). Template A is different: it
    // is pre-approved via the TEMPLATE's own standing approval and never goes
    // through the manual approval flow at all — dispatch.ts's commit only
    // ever accepts a TEMPLATE_A message from READY, so a Template A
    // send-again must land there directly, never at DRAFT (see
    // sendAgainOutreachMessageAction in actions.ts, the only caller that
    // passes this).
    const targetStatus = opts.targetStatus ?? "DRAFT";
    return db.$transaction(async tx => {
        // Lock the message row FIRST (the same "message row" rung dispatch.ts's
        // commit and cancellation.ts's cancel both take) — an unlocked read
        // here let an edit observe APPROVED, wait behind a concurrent commit,
        // and then unconditionally overwrite whatever the commit left (DISPATCHING,
        // SENT, or CANCELLED) back to DRAFT, resurrecting a message that had
        // already committed or been invalidated.
        const rows = await tx.$queryRaw<{ id: string; status: string; generation: number }[]>`
            SELECT id, status, generation FROM "OutreachMessage" WHERE id = ${messageId} FOR UPDATE`;
        const lockedRow = rows[0];
        if (!lockedRow) throw new Error("message not found");
        if (!allowedStatuses.includes(lockedRow.status)) {
            throw new Error("already in flight");
        }
        const locked = lockedRow;
        const nextGeneration = locked.generation + 1;
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
        // approval"). Conditional on the exact row we locked and validated,
        // never a blind write.
        const { count } = await tx.outreachMessage.updateMany({
            where: { id: messageId, status: locked.status as OutreachStatusValue, generation: locked.generation },
            data: { generation: nextGeneration, status: targetStatus, approvedVersionId: null, approvalHash: null, approvedBy: null, approvedAt: null },
        });
        if (count === 0) throw new Error("already in flight");
        const updated = await tx.outreachMessage.findUniqueOrThrow({ where: { id: messageId } });
        await logOutreachEvent(tx, { leadId: updated.leadId, messageId, kind: "draft-edited", detail: { generation: nextGeneration } });
        return updated;
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
        // Re-checked here too (not just at the edit boundary) — this is the
        // step that claims the daily-cap/attempt path for real, so invalid
        // content must never get this far even if it somehow bypassed
        // createOutreachDraftInTx/createNewGeneration.
        assertValidRecipientAndHeaders({ to: version.to, subject: version.subject, threading: version.threading as unknown as ThreadingInfo });
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
    // Everything below happens inside ONE transaction that must always COMMIT
    // (never throw once it has written anything) — a hash mismatch resets the
    // row to DRAFT and that reset has to land for real, or a throw here would
    // roll it back too and strand the row in PENDING_APPROVAL forever
    // (submitForApproval's own CAS only ever accepts DRAFT). The mismatch is
    // reported to the caller via the `ok: false` result, after commit.
    const result = await db.$transaction(async tx => {
        // Lock the message row first — the same rung dispatch.ts's commit and
        // cancellation.ts's cancel both take — so neither can race this read:
        // without it, an unlocked read here could observe PENDING_APPROVAL,
        // lose the lock to a concurrent cancellation, and then unconditionally
        // overwrite CANCELLED back to APPROVED.
        const rows = await tx.$queryRaw<{ id: string; status: string; generation: number }[]>`
            SELECT id, status, generation FROM "OutreachMessage" WHERE id = ${params.messageId} FOR UPDATE`;
        const locked = rows[0];
        if (!locked) throw new Error("message not found");
        const version = await tx.outreachVersion.findUniqueOrThrow({ where: { id: params.versionId } });
        if (version.messageId !== params.messageId || version.generation !== locked.generation) {
            throw new Error("stale version — a newer draft exists");
        }
        if (locked.status !== "PENDING_APPROVAL") {
            throw new Error(`cannot approve from status ${locked.status}`);
        }
        const threading = version.threading as unknown as ThreadingInfo;
        // Re-checked again at approval — the step immediately before a
        // message becomes eligible for dispatch's own commit — so invalid
        // recipient/header content can never ride an attempt this far.
        assertValidRecipientAndHeaders({ to: version.to, subject: version.subject, threading });
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
            await tx.outreachMessage.updateMany({ where: { id: params.messageId, status: "PENDING_APPROVAL" }, data: { status: "DRAFT" } });
            return { ok: false as const };
        }
        const { count } = await tx.outreachMessage.updateMany({
            where: { id: params.messageId, status: "PENDING_APPROVAL", generation: locked.generation },
            data: {
                status: "APPROVED",
                approvedVersionId: params.versionId,
                approvalHash: expected,
                approvedBy: params.approvedBy,
                approvedAt: new Date(),
            },
        });
        if (count === 0) throw new Error(`cannot approve from status ${locked.status}`);
        await logOutreachEvent(tx, { leadId: params.leadId, messageId: params.messageId, kind: "approved", detail: { approvedBy: params.approvedBy, versionId: params.versionId } });
        return { ok: true as const };
    });
    if (!result.ok) throw new Error("approval hash mismatch — the draft changed, reload and re-approve");
    return db.outreachMessage.findUniqueOrThrow({ where: { id: params.messageId } });
}
