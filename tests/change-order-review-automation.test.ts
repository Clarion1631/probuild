import assert from "node:assert/strict";
import { before, test } from "node:test";
import { readFileSync } from "node:fs";

let reviewModule: Record<string, any> = {};
before(async () => {
    try {
        reviewModule = await import("../src/lib/change-order-review-automation");
    } catch {
        // RED begins with the production executor absent.
    }
});

const dispatch = {
    from: "Golden Touch <notifications@goldentouchremodeling.com>",
    to: ["client@example.com"],
    replyTo: "office@example.com",
    subject: "Review CO-1",
    html: "<p>Review</p>",
    text: "Review",
    bcc: ["audit@example.com"],
};

function job(overrides: Record<string, any> = {}) {
    return {
        id: "review-job",
        changeOrderId: "co-1",
        eventRevision: 3,
        kind: "REVIEW_EMAIL",
        approvalMode: null,
        status: "PROCESSING",
        payload: {
            dispatch,
            expectedRevision: 3,
            expectedTaxFingerprint: '[false,8.8,"Test rate"]',
            expectedTaxTerms: { taxExempt: false, taxRatePercent: 8.8, taxRateName: "Test rate" },
            expectedRecipients: { primary: "client@example.com", additional: [] },
            expectedSubtotalCents: 10_000,
            companyName: "Golden Touch",
            expectedSettings: {
                companyName: "Golden Touch",
                replyTo: "office@example.com",
                bcc: ["audit@example.com"],
            },
        },
        result: null,
        idempotencyKey: "co-job/review-job",
        attempts: 1,
        maxAttempts: 8,
        nextAttemptAt: null,
        firstProviderAttemptAt: null,
        processingStartedAt: new Date("2026-08-16T12:00:00Z"),
        claimToken: "claim-1",
        ...overrides,
    };
}

test("review generations are true nonces, including repeated A→B→A preview terms", () => {
    assert.equal(typeof reviewModule.newChangeOrderReviewGeneration, "function");
    const a1 = reviewModule.newChangeOrderReviewGeneration();
    const b = reviewModule.newChangeOrderReviewGeneration();
    const a2 = reviewModule.newChangeOrderReviewGeneration();
    assert.notEqual(a1, b);
    assert.notEqual(a1, a2);
    assert.match(a1, /^[0-9a-f-]{36}$/i);
});

test("review execution checkpoints before the locked provider delivery and reports durable completion", async () => {
    assert.equal(typeof reviewModule.executeReviewEmailAutomationJob, "function");
    const calls: string[] = [];
    const outcome = await reviewModule.executeReviewEmailAutomationJob(job(), {
        now: () => new Date("2026-08-16T12:01:00Z"),
        checkpoint: async (claimed: any) => {
            calls.push("checkpoint");
            return claimed;
        },
        deliverLocked: async () => {
            calls.push("locked-provider-and-commit");
            return { kind: "completed" };
        },
    });

    assert.deepEqual(calls, ["checkpoint", "locked-provider-and-commit"]);
    assert.deepEqual(outcome, { kind: "completed" });
});

test("review execution cancels a final CAS conflict without calling the provider", async () => {
    let sends = 0;
    const outcome = await reviewModule.executeReviewEmailAutomationJob(job(), {
        checkpoint: async (claimed: any) => claimed,
        deliverLocked: async () => {
            sends++;
            return { kind: "canceled", result: { code: "RECIPIENT_CONFLICT" } };
        },
    });
    assert.equal(sends, 1, "the locked delivery owns validation and returns before its provider boundary");
    assert.deepEqual(outcome, { kind: "canceled", result: { code: "RECIPIENT_CONFLICT" } });
});

test("review execution parks attempts outside the provider idempotency horizon", async () => {
    let checkpointed = false;
    const outcome = await reviewModule.executeReviewEmailAutomationJob(job({
        firstProviderAttemptAt: new Date("2026-08-15T12:00:00Z"),
    }), {
        now: () => new Date("2026-08-16T12:00:00Z"),
        checkpoint: async (claimed: any) => {
            checkpointed = true;
            return claimed;
        },
        deliverLocked: async () => ({ kind: "completed" }),
    });
    assert.equal(checkpointed, false);
    assert.equal(outcome.kind, "needs-attention");
    assert.match(outcome.error, /idempotency window/i);
});

test("a CAS conflict after an earlier ambiguous provider attempt needs human attention", async () => {
    const outcome = await reviewModule.executeReviewEmailAutomationJob(job({
        firstProviderAttemptAt: new Date("2026-08-16T11:59:00Z"),
    }), {
        now: () => new Date("2026-08-16T12:00:00Z"),
        checkpoint: async (claimed: any) => claimed,
        deliverLocked: async () => ({ kind: "canceled", result: { code: "RECIPIENT_CONFLICT" } }),
    });
    assert.equal(outcome.kind, "needs-attention");
    assert.match(outcome.error, /prior provider attempt/i);
});

test("review settings expectations detect BCC removal/change plus reply-to and company-name drift", () => {
    assert.equal(typeof reviewModule.reviewEmailSettingsExpectation, "function");
    assert.equal(typeof reviewModule.reviewEmailSettingsConflictError, "function");
    const recipients = { primary: "client@example.com", additional: ["copy@example.com"] };
    const expected = reviewModule.reviewEmailSettingsExpectation({
        recipients,
        companyName: "Golden Touch",
        email: "office@example.com",
        notificationEmail: "audit@example.com",
    });
    assert.deepEqual(expected, {
        companyName: "Golden Touch",
        replyTo: "office@example.com",
        bcc: ["audit@example.com"],
    });
    for (const current of [
        { ...expected, bcc: [] },
        reviewModule.reviewEmailSettingsExpectation({
            recipients,
            companyName: "Golden Touch",
            email: "office@example.com",
            notificationEmail: null,
        }),
        reviewModule.reviewEmailSettingsExpectation({
            recipients,
            companyName: "Golden Touch",
            email: "office@example.com",
            notificationEmail: "changed-audit@example.com",
        }),
        reviewModule.reviewEmailSettingsExpectation({
            recipients,
            companyName: "Golden Touch",
            email: "changed-office@example.com",
            notificationEmail: "audit@example.com",
        }),
        reviewModule.reviewEmailSettingsExpectation({
            recipients,
            companyName: "Changed Contractor",
            email: "office@example.com",
            notificationEmail: "audit@example.com",
        }),
    ]) {
        assert.match(
            reviewModule.reviewEmailSettingsConflictError(expected, current) || "",
            /company or email delivery settings changed/i,
        );
    }
});

test("first review attempt locks settings after Client/Estimate and before job/provider; prior attempts skip the new veto", async () => {
    const reviewSource = readFileSync("src/lib/change-order-review-automation.ts", "utf8");
    const preflightStart = reviewSource.indexOf("async function checkpointReviewEmailFirstAttemptLocked(");
    const deliveryStart = reviewSource.indexOf("async function deliverReviewEmailLocked(", preflightStart);
    const preflight = reviewSource.slice(preflightStart, deliveryStart);
    const deliveryEnd = reviewSource.indexOf("export async function executeReviewEmailAutomationJob", deliveryStart);
    const delivery = reviewSource.slice(deliveryStart, deliveryEnd);
    const clientLock = preflight.indexOf('FROM "Client"');
    const estimateLock = preflight.indexOf('FROM "Estimate"');
    const settingsLock = preflight.indexOf('FROM "CompanySettings"');
    const jobLock = preflight.indexOf('FROM "ChangeOrderAutomationJob"');
    const durableCheckpoint = preflight.indexOf("checkpointChangeOrderAutomationProviderDispatch(tx");
    const provider = delivery.indexOf("await send(payload.dispatch");
    assert.ok(clientLock >= 0 && estimateLock > clientLock && settingsLock > estimateLock,
        "canonical review lock order must reach CompanySettings after Client/Estimate");
    assert.ok(jobLock > settingsLock && durableCheckpoint > jobLock,
        "live settings must be fenced before committing the first-provider checkpoint");
    assert.ok(provider >= 0 && !delivery.includes('FROM "CompanySettings"'),
        "provider delivery and retries must use only the already-validated frozen payload");

    let observedPrior: boolean | undefined;
    const outcome = await reviewModule.executeReviewEmailAutomationJob(job({
        firstProviderAttemptAt: new Date("2026-08-16T11:59:00Z"),
    }), {
        now: () => new Date("2026-08-16T12:00:00Z"),
        checkpoint: async (claimed: any) => claimed,
        deliverLocked: async (_job: any, _payload: any, _send: any, _now: any, hadPrior: boolean) => {
            observedPrior = hadPrior;
            return { kind: "completed" };
        },
    });
    assert.equal(observedPrior, true);
    assert.deepEqual(outcome, { kind: "completed" });

    const crashEvents: string[] = [];
    const checkpointedAfterCrash = job({
        firstProviderAttemptAt: new Date("2026-08-16T12:00:00Z"),
    });
    const firstOutcome = await reviewModule.executeReviewEmailAutomationJob(job(), {
        now: () => new Date("2026-08-16T12:00:00Z"),
        checkpointFirstAttempt: async () => {
            crashEvents.push("locked-live-validation+checkpoint-commit");
            return { kind: "ready", job: checkpointedAfterCrash };
        },
        deliverLocked: async () => {
            crashEvents.push("crash-before-provider-result");
            return { kind: "retry", error: "simulated process crash" };
        },
    });
    assert.equal(firstOutcome.kind, "retry");
    const retryOutcome = await reviewModule.executeReviewEmailAutomationJob(checkpointedAfterCrash, {
        now: () => new Date("2026-08-16T12:01:00Z"),
        checkpoint: async (claimed: any) => {
            crashEvents.push("frozen-checkpoint-resume");
            return claimed;
        },
        checkpointFirstAttempt: async () => {
            throw new Error("retry must not run mutable live validation");
        },
        deliverLocked: async (_job: any, _payload: any, _send: any, _now: any, hadPrior: boolean) => {
            crashEvents.push(`frozen-provider:${hadPrior}`);
            return { kind: "completed" };
        },
    });
    assert.deepEqual(retryOutcome, { kind: "completed" });
    assert.deepEqual(crashEvents, [
        "locked-live-validation+checkpoint-commit",
        "crash-before-provider-result",
        "frozen-checkpoint-resume",
        "frozen-provider:true",
    ]);

    const billingSource = readFileSync("src/lib/billing-core.ts", "utf8");
    const sendStart = billingSource.indexOf("export async function sendChangeOrderToClientCore(");
    const sendEnd = billingSource.indexOf("async function deliverManualMilestoneAttempt(", sendStart);
    const send = billingSource.slice(sendStart, sendEnd);
    assert.match(send, /const expectedSettings = reviewEmailSettingsExpectation\(/);
    assert.match(send, /payload:\s*\{[\s\S]*expectedSettings,/);
});

test("review delivery locks Project before ChangeOrder and project deletion is shell-only under the Project lock", () => {
    const reviewSource = readFileSync("src/lib/change-order-review-automation.ts", "utf8");
    const deliveryStart = reviewSource.indexOf("async function deliverReviewEmailLocked(");
    const deliveryEnd = reviewSource.indexOf("export async function executeReviewEmailAutomationJob", deliveryStart);
    const delivery = reviewSource.slice(deliveryStart, deliveryEnd);
    const projectLock = delivery.indexOf('FROM "Project"');
    const changeOrderLock = delivery.indexOf('FROM "ChangeOrder"');
    assert.ok(projectLock >= 0 && changeOrderLock > projectLock, "review delivery must lock Project before ChangeOrder");

    const billingSource = readFileSync("src/lib/billing-core.ts", "utf8");
    const sendStart = billingSource.indexOf("export async function sendChangeOrderToClientCore(");
    const sendEnd = billingSource.indexOf("export ", sendStart + 20);
    const signatureSend = billingSource.slice(sendStart, sendEnd < 0 ? undefined : sendEnd);
    const sendProjectLock = signatureSend.indexOf('FROM "Project"');
    const sendChangeOrderLock = signatureSend.indexOf('FROM "ChangeOrder"');
    assert.ok(
        sendProjectLock >= 0 && sendChangeOrderLock > sendProjectLock,
        "signature-send preparation must lock Project before ChangeOrder",
    );

    const actionsSource = readFileSync("src/lib/actions.ts", "utf8");
    const deleteStart = actionsSource.indexOf("export async function deleteProjects(");
    const deleteEnd = actionsSource.indexOf("\nexport async function", deleteStart + 1);
    const deleteAction = actionsSource.slice(deleteStart, deleteEnd < 0 ? undefined : deleteEnd);
    const parentLock = deleteAction.indexOf('FROM "Project"');
    const protectedRead = deleteAction.indexOf("const protectedProject = await tx.project.findFirst");
    const deleteMany = deleteAction.indexOf("tx.project.deleteMany");
    assert.ok(parentLock >= 0 && protectedRead > parentLock, "project deletion must re-read business evidence after locking Project");
    assert.ok(deleteMany > protectedRead, "project deletion must refuse evidence before deleting the shell");
    assert.match(deleteAction, /\{ changeOrders: \{ some: \{\} \} \}/, "any descendant CO makes the project non-shell");
});
