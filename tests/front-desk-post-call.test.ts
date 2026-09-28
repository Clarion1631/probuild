/**
 * Front Desk v1 acceptance tests 11 (outcome precedence) and 13 (bad
 * data_collection_results fields become null). No DB — `determinePostCallOutcome`
 * takes a `tx`-shaped object; here it is a tiny hand-rolled fake.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { postCallEnvelopeSchema, extractPostCallFacts, determinePostCallOutcome } from "../src/lib/front-desk/post-call";

interface FakeTxOpts {
    bookedRow?: unknown;
    uncertainRow?: unknown;
    transfer?: { status: string; screenAcceptedAt: Date | null } | null;
}

function fakeTx(opts: FakeTxOpts) {
    return {
        frontDeskBooking: {
            findFirst: async ({ where }: { where: { status: string | { in: string[] } } }) => {
                if (where.status === "BOOKED") return opts.bookedRow ?? null;
                return opts.uncertainRow ?? null;
            },
        },
        frontDeskTransfer: {
            findUnique: async () => opts.transfer ?? null,
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
}

test("outcome #1: a BOOKED booking row wins even over caller_kind=spam", async () => {
    const tx = fakeTx({ bookedRow: { id: "b1" } });
    const result = await determinePostCallOutcome(tx, "c1", "spam");
    assert.equal(result.outcome, "BOOKED");
    assert.deepEqual(result.reasons, ["front-desk-booked"]);
});

test("outcome #2: TRANSFERRED — CONNECTED transfer", async () => {
    const tx = fakeTx({ transfer: { status: "CONNECTED", screenAcceptedAt: null } });
    const result = await determinePostCallOutcome(tx, "c1", "new_project");
    assert.equal(result.outcome, "TRANSFERRED");
});

test("outcome #2: TRANSFERRED — DIALING with screenAcceptedAt set", async () => {
    const tx = fakeTx({ transfer: { status: "DIALING", screenAcceptedAt: new Date() } });
    const result = await determinePostCallOutcome(tx, "c1", "new_project");
    assert.equal(result.outcome, "TRANSFERRED");
});

test("outcome #3: MISSED_TRANSFER", async () => {
    const tx = fakeTx({ transfer: { status: "MISSED", screenAcceptedAt: null } });
    const result = await determinePostCallOutcome(tx, "c1", "new_project");
    assert.equal(result.outcome, "MISSED_TRANSFER");
    assert.deepEqual(result.reasons, ["front-desk-missed-transfer"]);
});

test("outcome #4: PREPARED, or DIALING not yet accepted — MESSAGE, front-desk-transfer-pending", async () => {
    const preparedTx = fakeTx({ transfer: { status: "PREPARED", screenAcceptedAt: null } });
    assert.deepEqual((await determinePostCallOutcome(preparedTx, "c1", "new_project")).reasons, ["front-desk-transfer-pending"]);

    const dialingTx = fakeTx({ transfer: { status: "DIALING", screenAcceptedAt: null } });
    const result = await determinePostCallOutcome(dialingTx, "c1", "new_project");
    assert.equal(result.outcome, "MESSAGE");
    assert.deepEqual(result.reasons, ["front-desk-transfer-pending"]);
});

test("outcome #5: SPAM for caller_kind spam or vendor_or_sales, with no other reasons", async () => {
    const tx = fakeTx({});
    assert.deepEqual((await determinePostCallOutcome(tx, "c1", "spam")).reasons, ["front-desk-spam"]);
    assert.deepEqual((await determinePostCallOutcome(tx, "c1", "vendor_or_sales")).reasons, ["front-desk-spam"]);
    assert.equal((await determinePostCallOutcome(tx, "c1", "spam")).outcome, "SPAM");
});

test("outcome #6: default MESSAGE, plus front-desk-existing-client for that caller_kind", async () => {
    const tx = fakeTx({});
    const other = await determinePostCallOutcome(tx, "c1", "other");
    assert.deepEqual(other.reasons, ["front-desk-message"]);
    const existing = await determinePostCallOutcome(tx, "c1", "existing_client");
    assert.deepEqual(existing.reasons, ["front-desk-message", "front-desk-existing-client"]);
});

test("a SUBMITTING/UNCERTAIN booking row adds front-desk-booking-uncertain to a non-SPAM outcome", async () => {
    const tx = fakeTx({ uncertainRow: { id: "u1" } });
    const result = await determinePostCallOutcome(tx, "c1", "new_project");
    assert.equal(result.bookingUncertain, true);
    assert.ok(result.reasons.includes("front-desk-booking-uncertain"));
});

test("bookingUncertain never modifies the SPAM outcome's reasons", async () => {
    const tx = fakeTx({ uncertainRow: { id: "u1" } });
    const result = await determinePostCallOutcome(tx, "c1", "spam");
    assert.deepEqual(result.reasons, ["front-desk-spam"]);
});

// ── Extraction (test 13) ─────────────────────────────────────────────────

function envelope(dataCollectionResults: Record<string, { value?: unknown }>) {
    return postCallEnvelopeSchema.parse({
        type: "post_call_transcription",
        data: {
            agent_id: "agent_x",
            conversation_id: "conv_1",
            metadata: { phone_call: { external_number: "+13605550100", call_sid: "CA123" } },
            analysis: { transcript_summary: "Wants a kitchen remodel.", data_collection_results: dataCollectionResults },
        },
    });
}

test("bad data_collection_results fields become null; caller_name/callback_number missing still yields a usable phone from caller ID", () => {
    const env = envelope({
        caller_name: { value: 12345 }, // wrong type -> null
        caller_kind: { value: "not-a-real-kind" }, // invalid enum -> null
        city: { value: "Vancouver" },
    });
    const facts = extractPostCallFacts(env);
    assert.equal(facts.callerName, null);
    assert.equal(facts.callerKind, null);
    assert.equal(facts.city, "Vancouver");
    assert.equal(facts.phoneE164, "+13605550100"); // falls back to caller ID
});

test("confirmed callback_number wins over the caller ID when both are present", () => {
    const env = envelope({ callback_number: { value: "(360) 555-0199" } });
    const facts = extractPostCallFacts(env);
    assert.equal(facts.phoneE164, "+13605550199");
});

test("no data_collection_results at all extracts to all-null facts without throwing", () => {
    const env = postCallEnvelopeSchema.parse({
        type: "post_call_transcription",
        data: { agent_id: "agent_x", conversation_id: "conv_2" },
    });
    const facts = extractPostCallFacts(env);
    assert.equal(facts.callerName, null);
    assert.equal(facts.phoneE164, null);
});

test("a valid caller_kind passes through", () => {
    const env = envelope({ caller_kind: { value: "existing_client" } });
    assert.equal(extractPostCallFacts(env).callerKind, "existing_client");
});
