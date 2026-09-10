import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
    loadReceiptOutcomeAudit,
    formatReceiptOutcomeAudit,
    unavailableReceiptOutcomeAudit,
    RECEIPT_OUTCOME_HEADING,
    RECEIPT_OUTCOME_UNAVAILABLE,
} from "../src/lib/receipt-outcome-audit";

const NOW = () => new Date("2026-09-09T14:00:00.000Z");

function source(relative: string): string {
    return readFileSync(new URL(relative, import.meta.url), "utf8");
}

test("reader rejection yields unavailable with null counts, never zero", async () => {
    const audit = await loadReceiptOutcomeAudit({
        readSnapshot: async () => { throw new Error("db exploded: host=secret-internal"); },
        now: NOW,
    });
    assert.equal(audit.collectionStatus, "unavailable");
    assert.equal((audit as { collectionError?: string }).collectionError, RECEIPT_OUTCOME_UNAVAILABLE);
    assert.equal(audit.counts.observedTargets, null);
    assert.equal(audit.counts.postedToChat, null);
    assert.equal(audit.counts.eligibleRequests, null);
    assert.ok(!JSON.stringify(audit).includes("secret-internal"), "raw diagnostics must not leak");
});

test("empty successful read counts zero observed targets but keeps eligibility unknown", async () => {
    const audit = await loadReceiptOutcomeAudit({
        readSnapshot: async () => ({ issues: [], cards: [], artifacts: [] }),
        now: NOW,
    });
    assert.equal(audit.collectionStatus, "available");
    assert.equal(audit.counts.observedTargets, 0);
    assert.equal(audit.counts.eligibleRequests, null);
    assert.ok(Array.isArray(audit.rows));
    assert.ok(Array.isArray(audit.evidenceErrors));
});

test("Date objects in the raw read are serialised before the summariser sees them", async () => {
    const audit = await loadReceiptOutcomeAudit({
        readSnapshot: async () => ({
            issues: [{
                id: "issue_1", targetType: "bank-line", targetKey: "bank:1",
                displayDetails: null, firstObservedAt: new Date("2026-09-01T00:00:00Z"),
                clearedAt: null, createdAt: new Date("2026-09-01T00:00:00Z"),
            }],
            cards: [],
            artifacts: [],
        }),
        now: NOW,
    });
    assert.equal(audit.collectionStatus, "available");
    assert.equal(typeof audit.counts.observedTargets, "number");
});

test("formatter shows unknown for null counts and says unavailable when the source failed", () => {
    const text = formatReceiptOutcomeAudit(unavailableReceiptOutcomeAudit(NOW().toISOString()));
    assert.ok(text.startsWith(RECEIPT_OUTCOME_HEADING));
    assert.match(text, /UNAVAILABLE/);
    assert.match(text, /Charges checked: unknown/);
    assert.match(text, /All requests needing a receipt: unknown/);
    assert.match(text, /Reached the purchaser: unknown/);
    assert.match(text, /Return confirmation saved: unknown/);
    assert.match(text, /check running successfully does not mean the receipt work is finished/);
    assert.match(text, /does not confirm QuickBooks entry or finished job costing/);
    assert.ok(!/%/.test(text), "no percentages");
});

test("formatted digest carries counts only, no owner PII or record IDs", async () => {
    const audit = await loadReceiptOutcomeAudit({
        readSnapshot: async () => ({
            issues: [{
                id: "issue_abc123", targetType: "bank-line", targetKey: "bank:9",
                displayDetails: "Home Depot 09/01 $412.10", firstObservedAt: new Date("2026-09-01T00:00:00Z"),
                clearedAt: null, createdAt: new Date("2026-09-01T00:00:00Z"),
            }],
            cards: [{
                id: "card_xyz789", owner: "purchaser@example.com", pacificDate: "2026-09-01",
                itemsJson: [{ targetKey: "bank:9" }], status: "posted", postedAt: new Date("2026-09-02T00:00:00Z"),
                threadName: "spaces/AAA/threads/BBB", messageName: "spaces/AAA/messages/CCC",
                attempts: 1, lastError: null, resendQueuedAt: null, createdAt: new Date("2026-09-02T00:00:00Z"),
            }],
            artifacts: [],
        }),
        now: NOW,
    });
    const text = formatReceiptOutcomeAudit(audit);
    for (const secret of ["example.com", "issue_abc123", "card_xyz789", "spaces/AAA", "Home Depot", "412.10"]) {
        assert.ok(!text.includes(secret), `digest must not contain ${secret}`);
    }
});

test("health route: outcomes-only branch sits after auth and before the health sweep", () => {
    const src = source("../src/app/api/health/pipeline/route.ts");
    const auth = src.indexOf("hasCronSecret(request)");
    const only = src.indexOf('get("outcomes") === "only"');
    const audit = src.indexOf("loadReceiptOutcomeAudit(");
    const health = src.indexOf("await getPipelineHealth()");
    assert.ok(auth >= 0 && only >= 0 && audit >= 0 && health >= 0, "expected markers present");
    assert.ok(auth < only, "outcomes-only check must come after auth");
    assert.ok(only < health, "outcomes-only must short-circuit before getPipelineHealth");
    assert.ok(audit < health, "audit is loaded before the QBO-probing health sweep in the short-circuit");
    assert.match(src, /receiptOutcomes/);
});

test("daily digest route wires the real loader and formatter as an optional dependency", () => {
    const src = source("../src/app/api/cron/pipeline-digest/route.ts");
    assert.match(src, /getReceiptOutcomes\?: \(\) => Promise<ReceiptOutcomeAudit>/);
    assert.match(src, /getReceiptOutcomes: \(\) => loadReceiptOutcomeAudit\(\)/);
    assert.match(src, /formatReceiptOutcomeAudit\(receiptOutcomes\)/);
    assert.ok(src.indexOf("await dependencies.getHealth()") < src.indexOf("dependencies.getReceiptOutcomes"));
    assert.match(src, /ok: health\.ok/, "health.ok keeps its operational meaning");
});

test("any overflowing evidence source makes the entire report unavailable", async () => {
    for (const key of ["issues", "cards", "artifacts"] as const) {
        const raw = { issues: [], cards: [], artifacts: [] } as { issues: unknown[]; cards: unknown[]; artifacts: unknown[] };
        raw[key] = Array.from({ length: 2001 }, (_, i) => ({ id: `row-${i}` }));
        const audit = await loadReceiptOutcomeAudit({ readSnapshot: async () => raw, now: NOW });
        assert.equal(audit.collectionStatus, "unavailable", key);
        assert.equal(audit.collectionError, "receipt-outcome-row-limit", key);
        assert.equal(audit.rows.length, 0, key);
        assert.ok(Object.values(audit.counts).every(value => value === null), key);
        assert.match(formatReceiptOutcomeAudit(audit), /too many records/i);
    }
});

test("the exact row cap remains readable, with no silent lower cutoff", async () => {
    const issues = Array.from({ length: 2000 }, (_, i) => ({
        id: `issue-${i}`, targetType: "bank-line", targetKey: `charge-${i}`,
        displayDetails: null, firstObservedAt: "2026-09-01T00:00:00Z", createdAt: "2026-09-01T00:00:00Z", clearedAt: null,
    }));
    const audit = await loadReceiptOutcomeAudit({ readSnapshot: async () => ({ issues, cards: [], artifacts: [] }), now: NOW });
    assert.equal(audit.collectionStatus, "available");
    assert.equal(audit.counts.observedTargets, 2000);
});

test("all three database reads use the same cap plus one overflow sentinel", () => {
    const src = source("../src/lib/receipt-outcome-audit.ts");
    assert.equal((src.match(/take: RECEIPT_OUTCOME_ROW_LIMIT \+ 1/g) ?? []).length, 3);
    assert.match(src, /RECEIPT_OUTCOME_ROW_LIMIT = 2_000/);
});

// ---- review corrections: snapshot clock after read, and "Records needing review" counting ----

const rvIssue = (over: Record<string, unknown> = {}) => ({
    id: "i1",
    targetType: "bank-line",
    targetKey: "tk1",
    displayDetails: JSON.stringify({ resolution: "memo-signed", pdfId: "pdf1" }),
    firstObservedAt: "2026-09-01T10:00:00.000Z",
    clearedAt: "2026-09-02T10:00:00.000Z",
    createdAt: "2026-09-01T10:00:00.000Z",
    ...over,
});
const rvArtifact = (over: Record<string, unknown> = {}) => ({
    id: "a1",
    pdfId: "pdf1",
    targetType: "bank-line",
    targetKey: "tk1",
    issueId: "i1",
    createdAt: "2026-09-02T10:00:00.000Z",
    ...over,
});
const rvCard = (over: Record<string, unknown> = {}) => ({
    id: "c1",
    itemsJson: JSON.stringify([{
        n: 1, targetKey: "tk1", issueId: "i1", fingerprint: "pb-tk1",
        date: "2026-09-01", vendor: "Example Vendor", cents: 1234,
        amount: "12.34", cardTail: null,
    }]),
    status: "POSTED",
    postedAt: "2026-09-01T11:00:00.000Z",
    threadName: "spaces/S1/threads/t1",
    messageName: "spaces/S1/messages/m1",
    attempts: 1,
    lastError: null,
    resendQueuedAt: null,
    createdAt: "2026-09-01T10:30:00.000Z",
    ...over,
});
async function rvRun(raw: { issues: unknown[]; cards: unknown[]; artifacts: unknown[] }) {
    return loadReceiptOutcomeAudit({ readSnapshot: async () => raw, now: NOW });
}
function rvReview(text: string): string {
    const m = /Records needing review: (\S+)/.exec(text);
    assert.ok(m, "Records needing review line present");
    return m![1];
}

test("snapshot clock is observed after the read, so a card posted mid-read counts as posted", async () => {
    let clock = new Date("2026-09-09T14:00:00.000Z");
    const raw = {
        issues: [rvIssue({ displayDetails: null, clearedAt: null })],
        cards: [rvCard({ postedAt: new Date("2026-09-09T14:02:00.000Z") })],
        artifacts: [],
    };
    const report = await loadReceiptOutcomeAudit({
        readSnapshot: async () => {
            clock = new Date("2026-09-09T14:05:00.000Z");
            return raw;
        },
        now: () => clock,
    });
    assert.equal(report.collectionStatus, "available");
    assert.equal(report.capturedAt, "2026-09-09T14:05:00.000Z");
    assert.equal(report.counts.postedToChat, 1);
    assert.equal((report.rows[0] as { postedToChat: unknown }).postedToChat, true);
});

test("failed read also stamps the clock observed after the attempt", async () => {
    let clock = new Date("2026-09-09T14:00:00.000Z");
    const report = await loadReceiptOutcomeAudit({
        readSnapshot: async () => {
            clock = new Date("2026-09-09T14:05:00.000Z");
            throw new Error("boom");
        },
        now: () => clock,
    });
    assert.equal(report.collectionStatus, "unavailable");
    assert.equal(report.capturedAt, "2026-09-09T14:05:00.000Z");
});

test("records needing review: clean filed target counts 0", async () => {
    const report = await rvRun({ issues: [rvIssue()], cards: [rvCard()], artifacts: [rvArtifact()] });
    assert.equal(report.counts.filedInProbuild, 1);
    assert.equal(rvReview(formatReceiptOutcomeAudit(report)), "0");
});

test("records needing review: memo-signed without a bound artifact counts 1", async () => {
    const report = await rvRun({ issues: [rvIssue()], cards: [rvCard()], artifacts: [] });
    assert.equal(report.evidenceErrors.length, 0);
    assert.equal(rvReview(formatReceiptOutcomeAudit(report)), "1");
});

test("records needing review: mismatched pdf counts 1", async () => {
    const report = await rvRun({ issues: [rvIssue()], cards: [rvCard()], artifacts: [rvArtifact({ pdfId: "pdf-other" })] });
    assert.equal(rvReview(formatReceiptOutcomeAudit(report)), "1");
});

test("records needing review: several flags on one target count 1", async () => {
    const report = await rvRun({
        issues: [rvIssue({ clearedAt: null }), rvIssue({ id: "i2", clearedAt: null, createdAt: "2026-09-01T12:00:00.000Z" })],
        cards: [rvCard()],
        artifacts: [rvArtifact(), rvArtifact({ id: "a2", pdfId: "pdf2" })],
    });
    const flags = (report.rows[0] as { flags: string[] }).flags;
    assert.ok(flags.includes("identity_conflict") && flags.includes("artifact_conflict"));
    assert.equal(rvReview(formatReceiptOutcomeAudit(report)), "1");
});

test("records needing review: duplicate identity error plus the same flagged target counts 1, not 2", async () => {
    const report = await rvRun({
        issues: [rvIssue(), rvIssue({ clearedAt: null })],
        cards: [rvCard()],
        artifacts: [rvArtifact()],
    });
    assert.deepEqual(report.evidenceErrors, ["issue_identity_conflict"]);
    assert.ok((report.rows[0] as { flags: string[] }).flags.includes("identity_conflict"));
    assert.equal(rvReview(formatReceiptOutcomeAudit(report)), "1");
});

test("records needing review: orphan artifact with no target counts 1", async () => {
    const report = await rvRun({ issues: [], cards: [], artifacts: [rvArtifact({ targetKey: "tk-orphan" })] });
    assert.equal(report.rows.length, 0);
    assert.deepEqual(report.evidenceErrors, ["artifact_without_target"]);
    assert.equal(rvReview(formatReceiptOutcomeAudit(report)), "1");
});

test("records needing review: benign pending flags count 0", async () => {
    const report = await rvRun({
        issues: [rvIssue({ displayDetails: null, clearedAt: null, firstObservedAt: "not-a-date" })],
        cards: [],
        artifacts: [],
    });
    const flags = (report.rows[0] as { flags: string[] }).flags;
    assert.ok(flags.includes("no_request_card") && flags.includes("elapsed_unavailable"));
    assert.equal(rvReview(formatReceiptOutcomeAudit(report)), "0");
});

test("records needing review: unavailable read shows unknown", async () => {
    const report = await loadReceiptOutcomeAudit({ readSnapshot: async () => { throw new Error("boom"); }, now: NOW });
    assert.equal(rvReview(formatReceiptOutcomeAudit(report)), "unknown");
});


test("review count deduplicates repeated targets and repeated unrepresented errors", async () => {
    const report=await rvRun({issues:[rvIssue()],cards:[rvCard()],artifacts:[]});
    report.rows=[report.rows[0],report.rows[0]];
    report.evidenceErrors=['artifact_without_target','artifact_without_target'];
    assert.equal(rvReview(formatReceiptOutcomeAudit(report)), '2');
});

test("malformed review report sources stay unknown and do not throw", async () => {
    const report=await rvRun({issues:[],cards:[],artifacts:[]});
    report.rows=null as unknown as unknown[];
    assert.equal(rvReview(formatReceiptOutcomeAudit(report)), 'unknown');
});
