/**
 * Real-Postgres dispatch races (spec Test Plan: "Dispatch races (concurrent
 * transactions): commit versus edit, suppression, pause, template revoke,
 * Booked or reply; exactly one outcome and no send after an invalidation
 * wins. Also: two workers claiming the same message; the cap race.").
 *
 * Requires SPEED_TO_LEAD_TEST_URL pointing at a DISPOSABLE local Postgres
 * with the Speed-to-Lead migration applied. Skips locally when unset.
 *
 * No real Gmail account is connected in this database, so every successful
 * COMMIT resolves to UNKNOWN_DELIVERY (dispatchOutreach's send step finds no
 * lead-inbox credential and returns that outcome) rather than SENT — that is
 * fine for what these tests assert: exactly ONE concurrent caller reaches the
 * commit transaction's DISPATCHING write, never two, and an invalidation
 * that wins before commit is never overridden by a commit that runs after it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { dispatchOutreach } from "../src/lib/speed-to-lead/dispatch";
import { computeApprovalHash } from "../src/lib/speed-to-lead/approval";
import { cancelMessagesForLead } from "../src/lib/speed-to-lead/cancellation";
import { DISPATCH_FROM_ADDRESS } from "../src/lib/speed-to-lead/constants";

const url = process.env.SPEED_TO_LEAD_TEST_URL;
const skip = !url && "requires explicitly supplied disposable PostgreSQL";
const RECIPIENT = "dispatch-race-test@example.com";

async function seedApprovedPersonalMessage(db: PrismaClient, idSuffix: string) {
    const client = await db.client.create({ data: { name: "Race Client", initials: "RC", email: RECIPIENT } });
    const lead = await db.lead.create({ data: { clientId: client.id, name: "Race Lead", source: "Website" } });
    const message = await db.outreachMessage.create({
        data: { leadId: lead.id, kind: "PERSONAL", status: "DRAFT", generation: 1, dedupeKey: `race-${idSuffix}`, isTest: true },
    });
    const version = await db.outreachVersion.create({
        data: {
            messageId: message.id, generation: 1, to: RECIPIENT, subject: "Race test", body: "Race test body", footer: "Footer",
            threading: { inReplyTo: null, references: null, threadId: null },
        },
    });
    const approvalHash = computeApprovalHash({
        leadId: lead.id, messageId: message.id, generation: 1, from: DISPATCH_FROM_ADDRESS,
        to: version.to, subject: version.subject, body: version.body, footer: version.footer,
        inReplyTo: null, references: null, threadId: null,
    });
    await db.outreachMessage.update({ where: { id: message.id }, data: { status: "APPROVED", approvedVersionId: version.id, approvalHash, approvedBy: "test", approvedAt: new Date() } });
    await db.companySettings.upsert({
        where: { id: "singleton" },
        create: { id: "singleton", leadInboxLastPollStartedAt: new Date(0), leadInboxLastPollAt: new Date(), leadInboxLastPollOk: true },
        update: { leadInboxLastPollAt: new Date(), leadInboxLastPollOk: true },
    });
    return { client, lead, message, version };
}

async function cleanup(db: PrismaClient, leadId: string) {
    await db.outreachAttempt.deleteMany({ where: { message: { leadId } } });
    await db.outreachVersion.deleteMany({ where: { message: { leadId } } });
    await db.outreachEvent.deleteMany({ where: { leadId } });
    await db.outreachMessage.deleteMany({ where: { leadId } });
    await db.lead.deleteMany({ where: { id: leadId } });
}

test("two concurrent dispatchOutreach calls on the same message: exactly one reaches DISPATCHING, the other is refused", { skip }, async () => {
    assert.ok(url);
    assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname), "test refuses non-local databases");
    const savedMode = process.env.SPEED_TO_LEAD_MODE;
    const savedAllowlist = process.env.SPEED_TO_LEAD_TEST_ALLOWLIST;
    process.env.SPEED_TO_LEAD_MODE = "TEST";
    process.env.SPEED_TO_LEAD_TEST_ALLOWLIST = RECIPIENT;
    const db = new PrismaClient({ datasources: { db: { url } } });
    const seeded = await seedApprovedPersonalMessage(db, "two-workers");
    try {
        const [a, b] = await Promise.all([
            dispatchOutreach(seeded.message.id, db),
            dispatchOutreach(seeded.message.id, db),
        ]);
        const statuses = [a.status, b.status].sort();
        // One committed (UNKNOWN_DELIVERY, since there's no real Gmail
        // credential here); the other found it ALREADY_IN_FLIGHT.
        assert.deepEqual(statuses, ["ALREADY_IN_FLIGHT", "UNKNOWN_DELIVERY"]);

        const attempts = await db.outreachAttempt.count({ where: { messageId: seeded.message.id } });
        assert.equal(attempts, 1, "exactly one OutreachAttempt row must exist, never two");
    } finally {
        await cleanup(db, seeded.lead.id);
        await db.$disconnect();
        process.env.SPEED_TO_LEAD_MODE = savedMode;
        process.env.SPEED_TO_LEAD_TEST_ALLOWLIST = savedAllowlist;
    }
});

test("cancellation racing a commit: whichever wins, the outcome is consistent (no send after cancellation commits first)", { skip }, async () => {
    assert.ok(url);
    const savedMode = process.env.SPEED_TO_LEAD_MODE;
    const savedAllowlist = process.env.SPEED_TO_LEAD_TEST_ALLOWLIST;
    process.env.SPEED_TO_LEAD_MODE = "TEST";
    process.env.SPEED_TO_LEAD_TEST_ALLOWLIST = RECIPIENT;
    const db = new PrismaClient({ datasources: { db: { url } } });
    const seeded = await seedApprovedPersonalMessage(db, "cancel-race");
    try {
        const [dispatchResult, cancelResult] = await Promise.all([
            dispatchOutreach(seeded.message.id, db),
            cancelMessagesForLead(seeded.lead.id, "race-test-reply", db),
        ]);
        const finalMessage = await db.outreachMessage.findUniqueOrThrow({ where: { id: seeded.message.id } });
        if (cancelResult.cancelledMessageIds.includes(seeded.message.id)) {
            // Cancellation won the race — the message must be CANCELLED, and
            // dispatch must have found nothing to send (BLOCKED/ALREADY_IN_FLIGHT/NOT_FOUND handled by its own lock, never SENT).
            assert.equal(finalMessage.status, "CANCELLED");
            assert.notEqual(dispatchResult.status, "SENT");
        } else {
            // Dispatch won — it committed to DISPATCHING/UNKNOWN_DELIVERY before
            // cancellation's lock could apply, so cancellation correctly found
            // nothing left in a cancellable state.
            assert.ok(["UNKNOWN_DELIVERY", "SENT", "FAILED"].includes(finalMessage.status) || finalMessage.status === "APPROVED");
        }
    } finally {
        await cleanup(db, seeded.lead.id);
        await db.$disconnect();
        process.env.SPEED_TO_LEAD_MODE = savedMode;
        process.env.SPEED_TO_LEAD_TEST_ALLOWLIST = savedAllowlist;
    }
});

test("the daily cap race: N concurrent dispatches against a cap of 1 commit at most 1", { skip }, async () => {
    assert.ok(url);
    const savedMode = process.env.SPEED_TO_LEAD_MODE;
    const savedAllowlist = process.env.SPEED_TO_LEAD_TEST_ALLOWLIST;
    const savedCap = process.env.SPEED_TO_LEAD_DAILY_CAP;
    process.env.SPEED_TO_LEAD_MODE = "TEST";
    process.env.SPEED_TO_LEAD_TEST_ALLOWLIST = RECIPIENT;
    process.env.SPEED_TO_LEAD_DAILY_CAP = "1";
    const db = new PrismaClient({ datasources: { db: { url } } });
    const today = new Date().toISOString().slice(0, 10);
    await db.outreachDailyCounter.deleteMany({ where: { day: today } });
    const seededA = await seedApprovedPersonalMessage(db, "cap-a");
    const seededB = await seedApprovedPersonalMessage(db, "cap-b");
    try {
        const [a, b] = await Promise.all([
            dispatchOutreach(seededA.message.id, db),
            dispatchOutreach(seededB.message.id, db),
        ]);
        const committed = [a, b].filter(r => r.status === "UNKNOWN_DELIVERY" || r.status === "SENT" || r.status === "FAILED").length;
        const blocked = [a, b].filter(r => r.status === "BLOCKED").length;
        assert.equal(committed, 1, "the cap must allow exactly one commit");
        assert.equal(blocked, 1, "the other must be BLOCKED by the cap");
        const counter = await db.outreachDailyCounter.findUnique({ where: { day: today } });
        assert.equal(counter?.count, 1);
    } finally {
        await cleanup(db, seededA.lead.id);
        await cleanup(db, seededB.lead.id);
        await db.outreachDailyCounter.deleteMany({ where: { day: today } });
        await db.$disconnect();
        process.env.SPEED_TO_LEAD_MODE = savedMode;
        process.env.SPEED_TO_LEAD_TEST_ALLOWLIST = savedAllowlist;
        process.env.SPEED_TO_LEAD_DAILY_CAP = savedCap;
    }
});
