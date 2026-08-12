import assert from "node:assert/strict";
import test from "node:test";
import { markPurchaseReviewedCore, type PurchaseReviewClient, type PurchaseReviewRow } from "../src/lib/purchase-review";
import { hasPermission } from "../src/lib/access-rules";

const REVIEWER = { id: "user-1", name: "Vanessa" };

/** In-memory fake matching the minimal PurchaseReviewClient shape — mirrors
 * the fake ExpenseTransaction pattern in tests/qbo-expense-sync.test.ts. */
function createFakeReviewClient(initial: PurchaseReviewRow[] = []): PurchaseReviewClient & { rows: PurchaseReviewRow[] } {
    const rows = [...initial];
    return {
        rows,
        async create({ data }) {
            const conflict = rows.some((r) => r.qboPurchaseId === data.qboPurchaseId && r.qboSyncToken === data.qboSyncToken);
            if (conflict) {
                const err = new Error("unique constraint") as Error & { code?: string };
                err.code = "P2002";
                throw err;
            }
            const row: PurchaseReviewRow = {
                qboPurchaseId: data.qboPurchaseId,
                qboSyncToken: data.qboSyncToken,
                reviewerName: data.reviewerName,
                reviewedAt: new Date("2026-08-11T15:00:00.000Z"),
            };
            rows.push(row);
            return row;
        },
        async findUnique({ where }) {
            const key = where.qboPurchaseId_qboSyncToken;
            return rows.find((r) => r.qboPurchaseId === key.qboPurchaseId && r.qboSyncToken === key.qboSyncToken) ?? null;
        },
    };
}

test("markPurchaseReviewedCore inserts a review when the SyncToken matches what's current in QBO", async () => {
    const client = createFakeReviewClient();
    const result = await markPurchaseReviewedCore(
        { client, getCurrentSyncToken: async () => "3" },
        REVIEWER,
        "purchase-1",
        "3",
    );
    assert.deepEqual(result, { ok: true, reviewedAt: "2026-08-11T15:00:00.000Z", reviewerName: "Vanessa" });
    assert.equal(client.rows.length, 1);
    assert.equal(client.rows[0].reviewerName, "Vanessa");
});

test("markPurchaseReviewedCore rejects a stale SyncToken instead of certifying a version the reviewer never saw", async () => {
    const client = createFakeReviewClient();
    const result = await markPurchaseReviewedCore(
        { client, getCurrentSyncToken: async () => "4" }, // QBO has moved on to SyncToken 4
        REVIEWER,
        "purchase-1",
        "3", // reviewer only saw SyncToken 3 rendered
    );
    assert.deepEqual(result, { ok: false, reason: "stale-sync-token", currentSyncToken: "4" });
    assert.equal(client.rows.length, 0);
});

test("markPurchaseReviewedCore reports purchase-not-found when QBO no longer has the purchase", async () => {
    const client = createFakeReviewClient();
    const result = await markPurchaseReviewedCore(
        { client, getCurrentSyncToken: async () => null },
        REVIEWER,
        "purchase-1",
        "3",
    );
    assert.deepEqual(result, { ok: false, reason: "purchase-not-found" });
});

test("markPurchaseReviewedCore treats a concurrent duplicate insert as a no-op, not an error", async () => {
    // Simulate two reviewers clicking "Mark reviewed" on the same rendered
    // version at once: the client's create() throws P2002 on the SECOND
    // caller because the first one already landed the exact same row.
    const existingRow: PurchaseReviewRow = {
        qboPurchaseId: "purchase-1",
        qboSyncToken: "3",
        reviewerName: "Marge",
        reviewedAt: new Date("2026-08-11T15:00:00.000Z"),
    };
    const client = createFakeReviewClient([existingRow]);
    const result = await markPurchaseReviewedCore(
        { client, getCurrentSyncToken: async () => "3" },
        { id: "user-2", name: "Vanessa" },
        "purchase-1",
        "3",
    );
    // No-op: succeeds with whichever row actually won the race (Marge's),
    // rather than throwing or creating a second row for the same version.
    assert.deepEqual(result, { ok: true, reviewedAt: "2026-08-11T15:00:00.000Z", reviewerName: "Marge" });
    assert.equal(client.rows.length, 1);
});

test("markPurchaseReviewedCore lets a re-review after a QBO change insert a NEW row for the new SyncToken", async () => {
    const client = createFakeReviewClient([
        { qboPurchaseId: "purchase-1", qboSyncToken: "3", reviewerName: "Marge", reviewedAt: new Date("2026-08-10T15:00:00.000Z") },
    ]);
    const result = await markPurchaseReviewedCore(
        { client, getCurrentSyncToken: async () => "4" },
        REVIEWER,
        "purchase-1",
        "4", // reviewer is now reviewing the NEW rendered version
    );
    assert.equal(result.ok, true);
    assert.equal(client.rows.length, 2); // old row untouched, new row added
});

test("markPurchaseReviewedCore rejects blank ids", async () => {
    const client = createFakeReviewClient();
    await assert.rejects(
        () => markPurchaseReviewedCore({ client, getCurrentSyncToken: async () => "1" }, REVIEWER, "  ", "1"),
    );
});

// ── Unauthorized caller: the boundary markPurchaseReviewed's actions.ts
// wrapper actually enforces (assertStaffPermission("financialReports")) ──

test("a FIELD_CREW user without the financialReports permission is rejected at the same boundary markPurchaseReviewed relies on", () => {
    const fieldCrew = { role: "FIELD_CREW", permissions: null };
    assert.equal(hasPermission(fieldCrew, "financialReports"), false);
});

test("an ADMIN or a user with the financialReports permission granted is allowed through", () => {
    assert.equal(hasPermission({ role: "ADMIN", permissions: null }, "financialReports"), true);
    assert.equal(hasPermission({ role: "FINANCE", permissions: { financialReports: true } }, "financialReports"), true);
    assert.equal(hasPermission({ role: "FINANCE", permissions: { financialReports: false } }, "financialReports"), false);
});
