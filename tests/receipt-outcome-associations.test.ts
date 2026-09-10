import { test } from "node:test";
import assert from "node:assert/strict";
import { requestIdFor } from "../src/lib/receipt-request-cards";
import { auditReceiptOutcomes } from "../scripts/lib/receipt-outcome-audit.mjs";
import {
    loadReceiptOutcomeAudit,
    formatReceiptOutcomeAudit,
    receiptRequestId,
    RECEIPT_OUTCOME_ROW_LIMIT,
    type ReceiptOutcomeReport,
    type ReceiptOutcomeRow,
} from "../src/lib/receipt-outcome-audit";

const NOW = "2026-09-09T20:00:00Z";
const NOWD = () => new Date("2026-09-09T20:00:00.000Z");
const REQ = "receipt-req-buyer-2026-09-01";
type O = Record<string, unknown>;

const issue = (o: O = {}) => ({ id: "iss-1", targetType: "bank-line", targetKey: "bl-1", displayDetails: null, firstObservedAt: "2026-09-01T00:00:00Z", clearedAt: null, createdAt: "2026-09-01T00:00:00Z", ...o });
const memo = (pdfId = "pdf-1") => JSON.stringify({ resolution: "memo-signed", pdfId });
const item = (o: O = {}) => ({ n: 1, targetKey: "bl-1", issueId: "iss-1", fingerprint: "pb-bl-1", date: "2026-09-01", vendor: "Vendor Secret", cents: 1234, amount: "$12.34", cardTail: "9999", ...o });
const card = (o: O = {}) => ({ id: "card-1", requestId: REQ, itemsJson: JSON.stringify([item()]), status: "POSTED", postedAt: "2026-09-01T02:00:00Z", threadName: "spaces/s/threads/t", messageName: "spaces/s/messages/m", attempts: 1, lastError: null, resendQueuedAt: null, createdAt: "2026-09-01T01:00:00Z", ...o });
const unposted = (o: O = {}) => card({ status: "PENDING", postedAt: null, threadName: null, messageName: null, ...o });
const artifact = (o: O = {}) => ({ id: "art-1", pdfId: "pdf-1", targetType: "bank-line", targetKey: "bl-1", issueId: "iss-1", createdAt: "2026-09-02T00:00:00Z", ...o });
const run = (s: O = {}): ReceiptOutcomeReport => auditReceiptOutcomes({ capturedAt: NOW, scope: "test", issues: [], cards: [], artifacts: [], ...s }, NOW);
const row = (r: ReceiptOutcomeReport, k = "bl-1"): ReceiptOutcomeRow => {
    const f = r.rows.find(x => x.targetKey === k);
    assert.ok(f, `row ${k}`);
    return f!;
};
const full = () => ({ issues: [issue({ displayDetails: memo() })], cards: [card()], artifacts: [artifact()] });
const VALID_CARD = { cardId: "card-1", requestId: REQ, threadName: "spaces/s/threads/t", messageName: "spaces/s/messages/m", postedAt: "2026-09-01T02:00:00Z", itemNumber: 1, fingerprint: "pb-bl-1" };

test("valid full shape: posted card and backed artifact are both verified with exact fields only", () => {
    const a = run(full());
    const r = row(a);
    assert.equal(r.stage, "filed_in_probuild");
    assert.deepEqual(r.associations, {
        cards: [VALID_CARD],
        cardEvidence: "verified",
        filedArtifact: { pdfId: "pdf-1", createdAt: "2026-09-02T00:00:00Z" },
        artifactEvidence: "verified",
    });
    assert.equal(a.counts.filedInProbuild, 1);
    assert.equal(a.counts.postedToChat, 1);
});

test("multiple valid posted cards are all preserved, sorted by card id", () => {
    const a = run({ issues: [issue()], cards: [card({ id: "card-b" }), card({ id: "card-a" })] });
    const r = row(a);
    assert.equal(r.associations.cardEvidence, "verified");
    assert.deepEqual(r.associations.cards!.map(c => c.cardId), ["card-a", "card-b"]);
    assert.equal(a.counts.postedToChat, 1);
});

test("pdf mismatch: artifact evidence is conflict with null artifact, card evidence untouched", () => {
    const a = run({ ...full(), artifacts: [artifact({ pdfId: "pdf-other" })] });
    const r = row(a);
    assert.equal(r.associations.artifactEvidence, "conflict");
    assert.equal(r.associations.filedArtifact, null);
    assert.equal(r.associations.cardEvidence, "verified");
    assert.equal(a.counts.filedInProbuild, 0);
});

test("multiple artifacts or an artifact without resolution are conflicts with null evidence", () => {
    const a = run({ ...full(), artifacts: [artifact(), artifact({ id: "art-2" })] });
    assert.equal(row(a).associations.artifactEvidence, "conflict");
    assert.equal(row(a).associations.filedArtifact, null);
    const b = run({ issues: [issue()], artifacts: [artifact()] });
    assert.equal(row(b).associations.artifactEvidence, "conflict");
    assert.equal(row(b).associations.filedArtifact, null);
});

test("no artifact is absent, never conflict", () => {
    const a = run({ issues: [issue({ displayDetails: memo() })], cards: [card()] });
    assert.ok(row(a).flags.includes("resolution_without_artifact"));
    assert.equal(row(a).associations.artifactEvidence, "absent");
    assert.equal(row(a).associations.filedArtifact, null);
    const b = run({ issues: [issue()] });
    assert.equal(row(b).associations.artifactEvidence, "absent");
});

test("missing or unposted cards never claim a delivered association", () => {
    const none = run({ issues: [issue()] });
    assert.deepEqual(none.rows[0].associations.cards, []);
    assert.equal(none.rows[0].associations.cardEvidence, "absent");
    for (const c of [
        unposted(),
        unposted({ status: "POSTED" }),
        card({ postedAt: "2027-01-01T00:00:00Z" }),
        card({ messageName: "spaces/other/messages/m" }),
        card({ threadName: null }),
    ]) {
        const a = run({ issues: [issue()], cards: [c] });
        assert.deepEqual(row(a).associations.cards, c.status === "PENDING" ? [] : null);
        assert.equal(row(a).associations.cardEvidence, c.status === "PENDING" ? "absent" : "unavailable");
        assert.notEqual(row(a).postedToChat, true);
    }
});

test("recreated issue: artifact still binds by natural key and is verified", () => {
    const a = run({
        issues: [issue({ id: "iss-new", displayDetails: memo(), firstObservedAt: "2026-09-03T00:00:00Z", createdAt: "2026-09-03T00:00:00Z" })],
        cards: [card()],
        artifacts: [artifact({ issueId: "iss-old", createdAt: "2026-09-04T00:00:00Z" })],
    });
    const r = row(a);
    assert.equal(r.issueId, "iss-new");
    assert.equal(r.associations.artifactEvidence, "verified");
    assert.deepEqual(r.associations.filedArtifact, { pdfId: "pdf-1", createdAt: "2026-09-04T00:00:00Z" });
});

test("unknown or malformed sources make evidence unavailable, and card list null only when cards are globally unknown", () => {
    const a = run({ issues: null, cards: [card()], artifacts: null });
    assert.equal(row(a).associations.artifactEvidence, "unavailable");
    assert.equal(row(a).associations.filedArtifact, null);
    assert.equal(row(a).associations.cardEvidence, "verified");
    const b = run({ issues: [issue()], cards: null });
    assert.equal(row(b).associations.cards, null);
    assert.equal(row(b).associations.cardEvidence, "unavailable");
    for (const cards of [[card(), { id: "card-x" }], [card(), card({ id: "card-2", itemsJson: "nope" })], [card(), null]]) {
        const c = run({ issues: [issue()], cards });
        assert.equal(row(c).associations.cards, null, "global unknown must not yield a partial list");
        assert.equal(row(c).associations.cardEvidence, "unavailable");
        assert.equal(c.counts.postedToChat, null);
    }
    const d = run({ ...full(), issues: [issue({ displayDetails: "{broken" })] });
    assert.equal(row(d).associations.artifactEvidence, "unavailable");
    assert.equal(row(d).associations.filedArtifact, null);
});

test("malformed n, fingerprint, duplicates, or request id fail closed without changing counts", () => {
    const baseline = run(full()).counts;
    const bad: O[] = [item({ n: 0 }), item({ n: 1.5 }), item({ n: "1" }), item({ n: -3 }), item({ n: Number.MAX_SAFE_INTEGER + 2 }), item({ fingerprint: "pb-other" }), item({ fingerprint: null }), item({ fingerprint: "fp-1" })];
    for (const it of bad) {
        const a = run({ ...full(), cards: [card({ itemsJson: JSON.stringify([it]) })] });
        assert.equal(row(a).associations.cardEvidence, "conflict", JSON.stringify(it));
        assert.equal(row(a).associations.cards, null);
        assert.deepEqual(a.counts, baseline);
    }
    const dupN = run({ issues: [issue(), issue({ id: "iss-2", targetKey: "bl-2" })], cards: [card({ itemsJson: JSON.stringify([item(), item({ n: 1, targetKey: "bl-2", fingerprint: "pb-bl-2" })]) })] });
    assert.equal(row(dupN, "bl-1").associations.cardEvidence, "conflict");
    assert.equal(row(dupN, "bl-2").associations.cardEvidence, "conflict");
    assert.equal(dupN.counts.postedToChat, 2);
    const dupTarget = run({ ...full(), cards: [card({ itemsJson: JSON.stringify([item(), item({ n: 2 })]) })] });
    assert.equal(row(dupTarget).associations.cardEvidence, "conflict");
    assert.deepEqual(dupTarget.counts, baseline);
    const badReq = run({ ...full(), cards: [card({ requestId: "nope" })] });
    assert.equal(row(badReq).associations.cardEvidence, "conflict");
    assert.deepEqual(badReq.counts, baseline);
    const noReq = run({ ...full(), cards: [card({ requestId: null })] });
    assert.equal(row(noReq).associations.cardEvidence, "unavailable");
    assert.equal(row(noReq).associations.cards, null);
    assert.deepEqual(noReq.counts, baseline);
    const mixed = run({ ...full(), cards: [card(), card({ id: "card-2", requestId: "nope" })] });
    assert.equal(row(mixed).associations.cardEvidence, "conflict", "one bad card fails the target closed");
});

test("invalid artifact timestamp yields null createdAt, never a claimed time", () => {
    const a = run({ ...full(), artifacts: [artifact({ createdAt: "not-a-date" })] });
    assert.equal(row(a).stage, "filed_in_probuild");
    assert.ok(row(a).flags.includes("artifact_created_invalid"));
    assert.deepEqual(row(a).associations.filedArtifact, { pdfId: "pdf-1", createdAt: null });
});

test("privacy: no vendor, amount, card tail, or raw error; pdf id only inside filedArtifact", () => {
    const a = run({ ...full(), cards: [card({ lastError: "boom secret" })] });
    const out = JSON.stringify(a);
    for (const s of ["Vendor Secret", "$12.34", "9999", "boom secret", "cents"]) assert.ok(!out.includes(s), s);
    const cardKeys = Object.keys(a.rows[0].associations.cards![0]).sort();
    assert.deepEqual(cardKeys, ["cardId", "fingerprint", "itemNumber", "messageName", "postedAt", "requestId", "threadName"]);
    const stripped = JSON.stringify(a, (k, v) => (k === "filedArtifact" ? undefined : v));
    assert.ok(!stripped.includes("pdf-1"));
});

test("server derives requestId from owner + pacificDate, ignores any raw requestId, and never forwards owner", async () => {
    const raw = (over: O = {}) => ({ issues: [issue()], cards: [{ ...card(), requestId: "receipt-req-stale-2026-01-01", owner: "buyer", pacificDate: "2026-09-01", ...over }], artifacts: [] });
    const ok = await loadReceiptOutcomeAudit({ readSnapshot: async () => raw(), now: NOWD });
    assert.equal(ok.collectionStatus, "available");
    assert.equal(ok.rows[0].associations.cardEvidence, "verified");
    assert.equal(ok.rows[0].associations.cards![0].requestId, REQ);
    assert.ok(!JSON.stringify(ok).includes("stale"));
    for (const over of [{ owner: "has space" }, { owner: "" }, { owner: null }, { owner: undefined }, { pacificDate: "2026-02-30" }, { pacificDate: "09/01/2026" }, { pacificDate: null }]) {
        const bad = await loadReceiptOutcomeAudit({ readSnapshot: async () => raw(over), now: NOWD });
        assert.equal(bad.rows[0].associations.cardEvidence, "unavailable", JSON.stringify(over));
        assert.equal(bad.rows[0].associations.cards, null);
        assert.equal(bad.counts.postedToChat, 1, "counts unchanged");
    }
    assert.equal(receiptRequestId("buyer", "2026-09-01"), REQ);
    assert.equal(receiptRequestId("a b", "2026-09-01"), null);
    assert.equal(receiptRequestId("buyer", "2026-13-01"), null);
});

test("row cap behaviour unchanged: overflow is unavailable, the exact cap is readable with associations", async () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({
        id: `card-${i}`, owner: "buyer", pacificDate: "2026-09-01",
        itemsJson: JSON.stringify([{ n: 1, targetKey: `bl-${i}`, fingerprint: `pb-bl-${i}` }]),
        status: "POSTED", postedAt: "2026-09-01T02:00:00Z", threadName: "spaces/s/threads/t", messageName: "spaces/s/messages/m",
        attempts: 1, lastError: null, resendQueuedAt: null, createdAt: "2026-09-01T01:00:00Z",
    }));
    const over = await loadReceiptOutcomeAudit({ readSnapshot: async () => ({ issues: [], cards: many(RECEIPT_OUTCOME_ROW_LIMIT + 1), artifacts: [] }), now: NOWD });
    assert.equal(over.collectionStatus, "unavailable");
    assert.equal((over as { collectionError?: string }).collectionError, "receipt-outcome-row-limit");
    assert.equal(over.rows.length, 0);
    const ok = await loadReceiptOutcomeAudit({ readSnapshot: async () => ({ issues: [], cards: many(RECEIPT_OUTCOME_ROW_LIMIT), artifacts: [] }), now: NOWD });
    assert.equal(ok.collectionStatus, "available");
    assert.equal(ok.counts.observedTargets, RECEIPT_OUTCOME_ROW_LIMIT);
    assert.ok(ok.rows.every(r => r.associations.cardEvidence === "verified" && r.associations.cards!.length === 1));
});

// Astra review regressions: invalid times and identities never become verified joins.
test("request ID uses the bridge contract and rejects malformed date or email input", async () => {
    assert.equal(receiptRequestId("CJ", "2026-09-09"), requestIdFor("CJ", "2026-09-09"));
    assert.equal(receiptRequestId("buyer@example.com", "2026-09-09"), null);
    for (const requestId of ["receipt-req-CJ-2026-02-30", "receipt-req-buyer@example.com-2026-09-09"]) {
        const a = run({ ...full(), cards: [card({ requestId })] });
        assert.equal(row(a).associations.cardEvidence, "conflict");
        assert.equal(row(a).associations.cards, null);
    }
});
test("future artifact time stays unknown without changing the accepted PDF binding", () => {
    const a = run({ ...full(), artifacts: [artifact({ createdAt: "2027-01-01T00:00:00Z" })] });
    assert.equal(row(a).filedInProbuild, true);
    assert.deepEqual(row(a).associations.filedArtifact, { pdfId: "pdf-1", createdAt: null });
    assert.ok(row(a).flags.includes("artifact_created_future"));
});

test("digest never includes the protected association identifiers", () => {
    const report = run(full());
    const text = formatReceiptOutcomeAudit({ ...report, collectionStatus: "available" });
    for (const secret of ["pdf-1", "card-1", REQ, "spaces/s", "pb-bl-1"]) assert.ok(!text.includes(secret), secret);
});
