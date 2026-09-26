import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { currentFingerprint } from "./fingerprint";
import { intakeWebhookLead } from "./intake";
import { dispatchOutreach, reconcileUnknownDeliveries } from "./dispatch";
import { approveOutreachVersion, submitForApproval, createOutreachDraft, computeApprovalHash } from "./approval";
import { suppressEndpoint, clearEndpointSuppression, getEndpointStatus } from "./contact-endpoint";
import { pushToJustin } from "./push";
import { DISPATCH_FROM_ADDRESS, isProduction } from "./constants";
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

/**
 * A commit that only reaches UNKNOWN_DELIVERY is not evidence the send
 * actually works — reconciliation (dispatch.ts) is what would eventually
 * resolve it either way in production, so readiness runs that resolution
 * itself right now and only counts a message as proven if it actually
 * reaches SENT (still bounded to isTest/allowlisted recipients throughout).
 */
async function resolvedOutcomeStatus(db: PrismaClient, messageId: string, outcome: { status: string }): Promise<string> {
    if (outcome.status !== "UNKNOWN_DELIVERY") return outcome.status;
    await reconcileUnknownDeliveries(db, new Date());
    const message = await db.outreachMessage.findUnique({ where: { id: messageId }, select: { status: true } });
    return message?.status ?? outcome.status;
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
        const resolved = await resolvedOutcomeStatus(db, aMessage.id, aOutcome);
        results.push({ name: "template A commits from the test fixture and SENT", ok: resolved === "SENT", detail: JSON.stringify({ ...aOutcome, resolved }) });
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
    const resolvedPersonal = await resolvedOutcomeStatus(db, draft.id, personalOutcome);
    results.push({ name: "personal reply approved and SENT", ok: resolvedPersonal === "SENT", detail: JSON.stringify({ ...personalOutcome, resolved: resolvedPersonal }) });

    const push = await pushToJustin("Speed-to-Lead readiness check", "This is an automated readiness check push.");
    results.push({ name: "push delivered", ok: push.sent, detail: JSON.stringify(push) });

    return results;
}

/**
 * Every negative-path check below dispatches a REAL A message for its
 * fixture — a missing A message means the guard it's meant to test was never
 * actually exercised at all, which used to read as a pass ("no A message" ->
 * BLOCKED -> ok:true) regardless of the reason. That is fixed here: no A
 * message is now its own explicit failure, never mistaken for the guard
 * under test.
 */
async function dispatchTemplateAOrFail(db: PrismaClient, leadId: string | null, checkName: string): Promise<ReadinessCheckResult> {
    const aMessage = leadId ? await db.outreachMessage.findFirst({ where: { leadId, kind: "TEMPLATE_A" } }) : null;
    if (!aMessage) {
        return { name: checkName, ok: false, detail: "no A message was created — the guard under test was never exercised (is the test template fixture approved?)" };
    }
    const outcome = await dispatchOutreach(aMessage.id, db);
    return { name: checkName, ok: outcome.status === "BLOCKED", detail: JSON.stringify(outcome) };
}

async function checkNegativePaths(db: PrismaClient): Promise<ReadinessCheckResult[]> {
    const results: ReadinessCheckResult[] = [];

    // Recipient not on the allowlist — no pre-existing state to disturb.
    {
        const payload = testPayload({ email: "not-allowlisted@example.com" });
        const intake = await intakeWebhookLead(payload, { receivedAt: new Date(), isTest: true }, db);
        results.push(await dispatchTemplateAOrFail(db, intake.leadId, "recipient not on allowlist -> BLOCKED"));
    }

    // Suppressed endpoint — captures and restores whatever suppression state
    // this exact address had BEFORE the check, rather than unconditionally
    // clearing it: a real, deliberate suppression on this address (or a
    // concurrent readiness run) must survive this check untouched.
    {
        const email = process.env.SPEED_TO_LEAD_READINESS_TEST_EMAIL ?? "readiness-test@example.com";
        const before = await getEndpointStatus(email, db);
        try {
            await suppressEndpoint(email, { reason: "readiness-check", source: "readiness" }, db);
            const payload = testPayload({ email });
            const intake = await intakeWebhookLead(payload, { receivedAt: new Date(), isTest: true }, db);
            results.push(await dispatchTemplateAOrFail(db, intake.leadId, "suppressed endpoint -> BLOCKED"));
        } finally {
            if (before.suppressed) {
                await suppressEndpoint(email, { reason: before.reason ?? "restored after readiness check", source: "readiness-restore" }, db);
            } else {
                await clearEndpointSuppression(email, { clearedBy: "readiness-runner", reason: "readiness check cleanup" }, db);
            }
        }
    }

    // Pause on — restores the ORIGINAL value (which may already have been
    // "true", e.g. Justin deliberately paused the system), never a hardcoded
    // "false". Forcing pause off here would silently undo a real pause.
    {
        const before = await db.automationSetting.findUnique({ where: { key: "speedToLeadPaused" } });
        try {
            await db.automationSetting.upsert({ where: { key: "speedToLeadPaused" }, create: { key: "speedToLeadPaused", value: "true" }, update: { value: "true" } });
            const payload = testPayload();
            const intake = await intakeWebhookLead(payload, { receivedAt: new Date(), isTest: true }, db);
            results.push(await dispatchTemplateAOrFail(db, intake.leadId, "pause on -> BLOCKED"));
        } finally {
            const restoreValue = before?.value ?? "false";
            await db.automationSetting.upsert({ where: { key: "speedToLeadPaused" }, create: { key: "speedToLeadPaused", value: restoreValue }, update: { value: restoreValue } });
        }
    }

    // Stale poll — restores the ORIGINAL poll-health fields afterward.
    // Leaving them at the fake stale value (as before) blocks every OTHER
    // dispatch's freshness check until the next real poll happens to run.
    {
        const before = await db.companySettings.findUnique({
            where: { id: "singleton" },
            select: { leadInboxLastPollStartedAt: true, leadInboxLastPollAt: true, leadInboxLastPollOk: true },
        });
        try {
            await db.companySettings.upsert({
                where: { id: "singleton" },
                create: { id: "singleton", leadInboxLastPollAt: new Date(Date.now() - 60 * 60 * 1000), leadInboxLastPollOk: true },
                update: { leadInboxLastPollAt: new Date(Date.now() - 60 * 60 * 1000), leadInboxLastPollOk: true },
            });
            const payload = testPayload();
            const intake = await intakeWebhookLead(payload, { receivedAt: new Date(), isTest: true }, db);
            results.push(await dispatchTemplateAOrFail(db, intake.leadId, "stale poll -> BLOCKED"));
        } finally {
            await db.companySettings.update({
                where: { id: "singleton" },
                data: {
                    leadInboxLastPollStartedAt: before?.leadInboxLastPollStartedAt ?? null,
                    leadInboxLastPollAt: before?.leadInboxLastPollAt ?? null,
                    leadInboxLastPollOk: before?.leadInboxLastPollOk ?? null,
                },
            });
        }
    }

    // Expired A — no pre-existing state to disturb.
    {
        const payload = testPayload();
        const receivedAt = new Date(Date.now() - 60 * 60 * 1000); // an hour ago — past the 15-minute deadline
        const intake = await intakeWebhookLead(payload, { receivedAt, isTest: true }, db);
        results.push(await dispatchTemplateAOrFail(db, intake.leadId, "expired A -> BLOCKED"));
    }

    // Revoked template — restores the fixture's ORIGINAL revokedAt (always
    // null here, since the fixture is selected as unrevoked, but the read-
    // then-restore shape stays consistent with the other checks and survives
    // a concurrent revoke of the same row).
    {
        const template = await db.outreachTemplate.findFirst({ where: { testOnly: true, approvedAt: { not: null }, revokedAt: null } });
        if (template) {
            try {
                await db.outreachTemplate.update({ where: { id: template.id }, data: { revokedAt: new Date() } });
                const payload = testPayload();
                const intake = await intakeWebhookLead(payload, { receivedAt: new Date(), isTest: true }, db);
                // A revoked template correctly makes evaluateTemplateAEligibility
                // refuse to create an A message at all — that is this guard
                // working, not "the guard was never exercised", so this one
                // check alone treats "no A message" as a pass.
                const aMessage = intake.leadId ? await db.outreachMessage.findFirst({ where: { leadId: intake.leadId, kind: "TEMPLATE_A" } }) : null;
                const outcome = aMessage ? await dispatchOutreach(aMessage.id, db) : null;
                results.push({ name: "revoked template -> BLOCKED", ok: !aMessage || outcome?.status === "BLOCKED", detail: JSON.stringify({ aMessageCreated: !!aMessage, outcome }) });
            } finally {
                await db.outreachTemplate.update({ where: { id: template.id }, data: { revokedAt: null } });
            }
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

    // Production guard: a PASSED record is what Justin's LIVE activation
    // (fingerprint.ts's activateLive) trusts as proof PRODUCTION ITSELF is
    // ready — nothing stopped this from running in preview/dev and storing a
    // PASSED record under the same fingerprint, which would be evidence
    // about the wrong environment entirely.
    if (!isProduction()) {
        const results: ReadinessCheckResult[] = [{ name: "running in production", ok: false, detail: "readiness can only PASS when run in production (VERCEL_ENV=production) — this is what activateLive() trusts as proof production is ready" }];
        await db.readinessRecord.create({ data: { fingerprint, deploySha: params.deploySha ?? null, passed: false, results: results as unknown as Prisma.InputJsonValue } });
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
