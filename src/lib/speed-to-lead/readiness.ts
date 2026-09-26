import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { currentFingerprint } from "./fingerprint";
import { intakeWebhookLead } from "./intake";
import { dispatchOutreach } from "./dispatch";
import { approveOutreachVersion, submitForApproval, createOutreachDraft, computeApprovalHash } from "./approval";
import { suppressEndpoint, clearEndpointSuppression } from "./contact-endpoint";
import { pushToJustin } from "./push";
import { DISPATCH_FROM_ADDRESS } from "./constants";
import type { WebIntakePayload } from "./payload";

/**
 * Release readiness runner (spec Release "Readiness runner"). Every check
 * uses `isTest` leads and allowlisted recipients only — this is meant to run
 * safely against production. Writes exactly one append-only ReadinessRecord;
 * there is no edit path (spec: "There is no edit path").
 */
export interface ReadinessCheckResult {
    name: string;
    ok: boolean;
    detail?: string;
}

function testPayload(overrides: Partial<WebIntakePayload> = {}): WebIntakePayload {
    const now = Date.now();
    return {
        submissionId: `readiness-${now}-${Math.random().toString(36).slice(2)}`,
        name: "Readiness Check",
        email: process.env.SPEED_TO_LEAD_READINESS_TEST_EMAIL ?? "readiness-test@example.com",
        phone: null,
        message: "This is an automated readiness check submission with enough letters to pass triage.",
        projectType: null,
        location: null,
        honeypot: "",
        renderedAtMs: now - 10_000,
        submittedAtMs: now,
        smsConsent: false,
        attribution: {},
        ...overrides,
    };
}

async function checkPositivePath(db: PrismaClient): Promise<ReadinessCheckResult[]> {
    const results: ReadinessCheckResult[] = [];
    const payload = testPayload();
    const intake = await intakeWebhookLead(payload, { receivedAt: new Date(), isTest: true }, db);
    results.push({ name: "signed test intake -> REAL triage", ok: intake.won && intake.verdict === "REAL", detail: JSON.stringify(intake) });
    if (!intake.leadId) return results;

    const aMessage = await db.outreachMessage.findFirst({ where: { leadId: intake.leadId, kind: "TEMPLATE_A" } });
    if (aMessage) {
        const aOutcome = await dispatchOutreach(aMessage.id, db);
        results.push({ name: "template A commits from the test fixture and SENT", ok: aOutcome.status === "SENT" || aOutcome.status === "UNKNOWN_DELIVERY", detail: JSON.stringify(aOutcome) });
    } else {
        results.push({ name: "template A commits from the test fixture and SENT", ok: false, detail: "no A message was created — is the test template fixture approved?" });
    }

    const draft = await createOutreachDraft({
        leadId: intake.leadId,
        kind: "PERSONAL",
        dedupeKey: `readiness-personal-${intake.leadId}`,
        isTest: true,
        content: {
            to: payload.email, subject: "Readiness check reply", body: "Automated readiness check personal reply.",
            footer: "Golden Touch Remodeling readiness check.", threading: { inReplyTo: null, references: null, threadId: null },
        },
    }, db);
    const version = await db.outreachVersion.findFirstOrThrow({ where: { messageId: draft.id, generation: 1 } });
    await submitForApproval(draft.id, version.id, db);
    const approvalHash = computeApprovalHash({
        leadId: intake.leadId, messageId: draft.id, generation: 1, from: DISPATCH_FROM_ADDRESS,
        to: version.to, subject: version.subject, body: version.body, footer: version.footer,
        inReplyTo: null, references: null, threadId: null,
    });
    await approveOutreachVersion({ messageId: draft.id, versionId: version.id, approvalHash, approvedBy: "readiness-runner", leadId: intake.leadId }, db);
    const personalOutcome = await dispatchOutreach(draft.id, db);
    results.push({ name: "personal reply approved and SENT", ok: personalOutcome.status === "SENT" || personalOutcome.status === "UNKNOWN_DELIVERY", detail: JSON.stringify(personalOutcome) });

    const push = await pushToJustin("Speed-to-Lead readiness check", "This is an automated readiness check push.");
    results.push({ name: "push delivered", ok: push.sent, detail: JSON.stringify(push) });

    return results;
}

async function checkNegativePaths(db: PrismaClient): Promise<ReadinessCheckResult[]> {
    const results: ReadinessCheckResult[] = [];

    // Recipient not on the allowlist.
    {
        const payload = testPayload({ email: "not-allowlisted@example.com" });
        const intake = await intakeWebhookLead(payload, { receivedAt: new Date(), isTest: true }, db);
        const aMessage = intake.leadId ? await db.outreachMessage.findFirst({ where: { leadId: intake.leadId, kind: "TEMPLATE_A" } }) : null;
        const outcome = aMessage ? await dispatchOutreach(aMessage.id, db) : { status: "BLOCKED" as const, reason: "no A message" };
        results.push({ name: "recipient not on allowlist -> BLOCKED", ok: outcome.status === "BLOCKED", detail: JSON.stringify(outcome) });
    }

    // Suppressed endpoint.
    {
        const email = process.env.SPEED_TO_LEAD_READINESS_TEST_EMAIL ?? "readiness-test@example.com";
        await suppressEndpoint(email, { reason: "readiness-check", source: "readiness" }, db);
        const payload = testPayload({ email });
        const intake = await intakeWebhookLead(payload, { receivedAt: new Date(), isTest: true }, db);
        const aMessage = intake.leadId ? await db.outreachMessage.findFirst({ where: { leadId: intake.leadId, kind: "TEMPLATE_A" } }) : null;
        const outcome = aMessage ? await dispatchOutreach(aMessage.id, db) : { status: "BLOCKED" as const, reason: "no A message" };
        results.push({ name: "suppressed endpoint -> BLOCKED", ok: outcome.status === "BLOCKED", detail: JSON.stringify(outcome) });
        await clearEndpointSuppression(email, { clearedBy: "readiness-runner", reason: "readiness check cleanup" }, db);
    }

    // Pause on.
    {
        await db.automationSetting.upsert({ where: { key: "speedToLeadPaused" }, create: { key: "speedToLeadPaused", value: "true" }, update: { value: "true" } });
        const payload = testPayload();
        const intake = await intakeWebhookLead(payload, { receivedAt: new Date(), isTest: true }, db);
        const aMessage = intake.leadId ? await db.outreachMessage.findFirst({ where: { leadId: intake.leadId, kind: "TEMPLATE_A" } }) : null;
        const outcome = aMessage ? await dispatchOutreach(aMessage.id, db) : { status: "BLOCKED" as const, reason: "no A message" };
        results.push({ name: "pause on -> BLOCKED", ok: outcome.status === "BLOCKED", detail: JSON.stringify(outcome) });
        await db.automationSetting.upsert({ where: { key: "speedToLeadPaused" }, create: { key: "speedToLeadPaused", value: "false" }, update: { value: "false" } });
    }

    // Stale poll.
    {
        await db.companySettings.upsert({
            where: { id: "singleton" },
            create: { id: "singleton", leadInboxLastPollAt: new Date(Date.now() - 60 * 60 * 1000), leadInboxLastPollOk: true },
            update: { leadInboxLastPollAt: new Date(Date.now() - 60 * 60 * 1000), leadInboxLastPollOk: true },
        });
        const payload = testPayload();
        const intake = await intakeWebhookLead(payload, { receivedAt: new Date(), isTest: true }, db);
        const aMessage = intake.leadId ? await db.outreachMessage.findFirst({ where: { leadId: intake.leadId, kind: "TEMPLATE_A" } }) : null;
        const outcome = aMessage ? await dispatchOutreach(aMessage.id, db) : { status: "BLOCKED" as const, reason: "no A message" };
        results.push({ name: "stale poll -> BLOCKED", ok: outcome.status === "BLOCKED", detail: JSON.stringify(outcome) });
    }

    // Expired A.
    {
        const payload = testPayload();
        const receivedAt = new Date(Date.now() - 60 * 60 * 1000); // an hour ago — past the 15-minute deadline
        const intake = await intakeWebhookLead(payload, { receivedAt, isTest: true }, db);
        const aMessage = intake.leadId ? await db.outreachMessage.findFirst({ where: { leadId: intake.leadId, kind: "TEMPLATE_A" } }) : null;
        const outcome = aMessage ? await dispatchOutreach(aMessage.id, db) : { status: "BLOCKED" as const, reason: "no A message" };
        results.push({ name: "expired A -> BLOCKED", ok: outcome.status === "BLOCKED", detail: JSON.stringify(outcome) });
    }

    // Revoked template.
    {
        const template = await db.outreachTemplate.findFirst({ where: { testOnly: true, approvedAt: { not: null }, revokedAt: null } });
        if (template) {
            await db.outreachTemplate.update({ where: { id: template.id }, data: { revokedAt: new Date() } });
            const payload = testPayload();
            const intake = await intakeWebhookLead(payload, { receivedAt: new Date(), isTest: true }, db);
            const aMessage = intake.leadId ? await db.outreachMessage.findFirst({ where: { leadId: intake.leadId, kind: "TEMPLATE_A" } }) : null;
            const outcome = aMessage ? await dispatchOutreach(aMessage.id, db) : { status: "BLOCKED" as const, reason: "no A message — template already unapproved" };
            results.push({ name: "revoked template -> BLOCKED", ok: outcome.status === "BLOCKED" || !aMessage, detail: JSON.stringify(outcome) });
            await db.outreachTemplate.update({ where: { id: template.id }, data: { revokedAt: null } });
        } else {
            results.push({ name: "revoked template -> BLOCKED", ok: false, detail: "no test template fixture to revoke" });
        }
    }

    return results;
}

export async function runReadinessCheck(params: { deploySha?: string | null }, db: PrismaClient = prisma): Promise<{ passed: boolean; results: ReadinessCheckResult[] }> {
    const fingerprint = currentFingerprint();
    if (!fingerprint) {
        const results: ReadinessCheckResult[] = [{ name: "fingerprint available", ok: false, detail: "SPEED_TO_LEAD_FINGERPRINT is unset" }];
        await db.readinessRecord.create({ data: { fingerprint: "unknown", deploySha: params.deploySha ?? null, passed: false, results: results as unknown as Prisma.InputJsonValue } });
        return { passed: false, results };
    }

    const positive = await checkPositivePath(db);
    const negative = await checkNegativePaths(db);
    const results = [...positive, ...negative];
    const passed = results.every(r => r.ok);

    await db.readinessRecord.create({
        data: { fingerprint, deploySha: params.deploySha ?? null, passed, results: results as unknown as Prisma.InputJsonValue },
    });

    return { passed, results };
}
