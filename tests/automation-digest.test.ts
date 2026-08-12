import assert from "node:assert/strict";
import test from "node:test";
import {
    getPacificDateAndHour,
    previousCalendarDate,
    nextCalendarDate,
    pacificDayWindowUtc,
    isWithinSendWindow,
    claimDigestRun,
    finalizeDigestRun,
    buildDigestRows,
    runDigestTick,
    MAX_DIGEST_ATTEMPTS,
    type DigestRunRow,
    type DigestRunClient,
    type AutomationDigestDeps,
} from "../src/lib/automation-digest";

// ── Pacific date/hour math ───────────────────────────────────────────────

test("getPacificDateAndHour reads the Pacific calendar date and hour, not UTC", () => {
    // 2026-08-11T13:00:00Z is 06:00 PDT (UTC-7) on the same calendar date.
    const { pacificDate, pacificHour } = getPacificDateAndHour(new Date("2026-08-11T13:00:00.000Z"));
    assert.equal(pacificDate, "2026-08-11");
    assert.equal(pacificHour, 6);

    // 2026-08-11T06:00:00Z is still 2026-08-10 23:00 PDT — previous Pacific day.
    const late = getPacificDateAndHour(new Date("2026-08-11T06:00:00.000Z"));
    assert.equal(late.pacificDate, "2026-08-10");
    assert.equal(late.pacificHour, 23);
});

test("isWithinSendWindow gates on the first Pacific hour at/after 06:00", () => {
    assert.equal(isWithinSendWindow(new Date("2026-08-11T13:00:00.000Z")), true); // 06:00 PDT
    assert.equal(isWithinSendWindow(new Date("2026-08-11T12:59:00.000Z")), false); // 05:59 PDT
    assert.equal(isWithinSendWindow(new Date("2026-08-11T23:00:00.000Z")), true); // 16:00 PDT
});

test("previousCalendarDate / nextCalendarDate are pure calendar-date arithmetic", () => {
    assert.equal(previousCalendarDate("2026-08-11"), "2026-08-10");
    assert.equal(nextCalendarDate("2026-08-10"), "2026-08-11");
    // Month/year boundaries
    assert.equal(previousCalendarDate("2026-01-01"), "2025-12-31");
    assert.equal(nextCalendarDate("2025-12-31"), "2026-01-01");
});

test("pacificDayWindowUtc spans a normal 24h Pacific day, converted to UTC", () => {
    // 2026-08-11 is PDT (UTC-7): local midnight = 07:00 UTC, next midnight - 1ms = next day 06:59:59.999 UTC.
    const { startUtc, endUtc } = pacificDayWindowUtc("2026-08-11");
    assert.equal(startUtc.toISOString(), "2026-08-11T07:00:00.000Z");
    assert.equal(endUtc.toISOString(), "2026-08-12T06:59:59.999Z");
    assert.equal(endUtc.getTime() - startUtc.getTime(), 24 * 60 * 60 * 1000 - 1);
});

test("pacificDayWindowUtc handles the spring-forward DST transition (2026-03-08, PST->PDT)", () => {
    // 2026-03-08 02:00 local is skipped (clocks jump to 03:00) — that Pacific
    // calendar day is only 23 real hours. Local midnight is still PST
    // (UTC-8) since the transition happens at 2am, after midnight.
    const { startUtc, endUtc } = pacificDayWindowUtc("2026-03-08");
    assert.equal(startUtc.toISOString(), "2026-03-08T08:00:00.000Z");
    // Next day's local midnight is already PDT (UTC-7), so the window is 23h.
    assert.equal(endUtc.getTime() - startUtc.getTime(), 23 * 60 * 60 * 1000 - 1);
});

test("pacificDayWindowUtc handles the fall-back DST transition (2026-11-01, PDT->PST)", () => {
    // That Pacific calendar day is 25 real hours (1am repeats).
    const { startUtc, endUtc } = pacificDayWindowUtc("2026-11-01");
    assert.equal(startUtc.toISOString(), "2026-11-01T07:00:00.000Z");
    assert.equal(endUtc.getTime() - startUtc.getTime(), 25 * 60 * 60 * 1000 - 1);
});

// ── buildDigestRows: marker filter + de-dupe ────────────────────────────

test("buildDigestRows keeps only automation-marked purchases and de-dupes by Purchase Id", () => {
    const rows = buildDigestRows([
        {
            Id: "101",
            PrivateNote: "Shop - Lowe's ($42.10) [gtr-file:abcdefghijklmnopqrstuvwxyz123]",
            TxnDate: "2026-08-10",
            TotalAmt: 42.1,
            EntityRef: { name: "Lowe's" },
            CustomerRef: { name: "Shop" },
        },
        // Hand-booked via the QBO receipts inbox — no marker, must be excluded.
        { Id: "102", PrivateNote: "Manual entry", TxnDate: "2026-08-10", TotalAmt: 9.99 },
        // Duplicate Id (e.g. overlapping pagination) — must collapse to one row.
        {
            Id: "101",
            PrivateNote: "Shop - Lowe's ($42.10) [gtr-file:abcdefghijklmnopqrstuvwxyz123]",
            TxnDate: "2026-08-10",
            TotalAmt: 42.1,
            EntityRef: { name: "Lowe's" },
            CustomerRef: { name: "Shop" },
        },
    ]);

    assert.equal(rows.length, 1);
    assert.equal(rows[0].qbPurchaseId, "101");
    assert.equal(rows[0].docNumber, "abcdefghijklmnopqrstu"); // slice(0, 21) of the fileId
    assert.equal(rows[0].vendor, "Lowe's");
    assert.equal(rows[0].amountCents, 4210);
    assert.equal(rows[0].projectName, "Shop");
});

// ── DigestRun claim (fenced CAS) ─────────────────────────────────────────

/** In-memory fake matching the minimal DigestRunClient shape — mirrors the
 * fake ExpenseTransaction pattern in tests/qbo-expense-sync.test.ts. */
function createFakeDigestRunClient(initial: DigestRunRow[] = []): DigestRunClient & { rows: Map<string, DigestRunRow> } {
    const rows = new Map(initial.map((r) => [r.digestDate, r]));
    return {
        rows,
        async findUnique({ where }) {
            return rows.get(where.digestDate) ?? null;
        },
        async create({ data }) {
            if (rows.has(data.digestDate)) {
                const err = new Error("unique constraint") as Error & { code?: string };
                err.code = "P2002";
                throw err;
            }
            const row: DigestRunRow = { ...data };
            rows.set(data.digestDate, row);
            return row;
        },
        async updateMany({ where, data }) {
            const row = rows.get(where.digestDate as string);
            if (!row) return { count: 0 };
            if (where.status !== undefined && row.status !== where.status) return { count: 0 };
            if (where.claimToken !== undefined && row.claimToken !== where.claimToken) return { count: 0 };
            Object.assign(row, data);
            return { count: 1 };
        },
    };
}

test("claimDigestRun claims a fresh date at attempts=1", async () => {
    const client = createFakeDigestRunClient();
    const now = new Date("2026-08-11T13:00:00.000Z");
    const result = await claimDigestRun(client, "2026-08-10", now);
    assert.equal(result.claimed, true);
    if (result.claimed) {
        assert.equal(result.attempts, 1);
        assert.equal(client.rows.get("2026-08-10")?.status, "PROCESSING");
    }
});

test("claimDigestRun refuses a date that's already SENT", async () => {
    const client = createFakeDigestRunClient([
        { digestDate: "2026-08-10", status: "SENT", attempts: 1, claimToken: "t1", leaseExpiresAt: new Date("2026-08-11T13:05:00Z") },
    ]);
    const result = await claimDigestRun(client, "2026-08-10", new Date("2026-08-11T14:00:00.000Z"));
    assert.deepEqual(result, { claimed: false, reason: "already-sent" });
});

test("claimDigestRun refuses a date whose lease is still live (another worker in-flight)", async () => {
    const now = new Date("2026-08-11T13:02:00.000Z");
    const client = createFakeDigestRunClient([
        { digestDate: "2026-08-10", status: "PROCESSING", attempts: 1, claimToken: "t1", leaseExpiresAt: new Date("2026-08-11T13:05:00.000Z") },
    ]);
    const result = await claimDigestRun(client, "2026-08-10", now);
    assert.deepEqual(result, { claimed: false, reason: "in-flight" });
});

test("claimDigestRun steals a stale PROCESSING lease and increments attempts", async () => {
    const now = new Date("2026-08-11T13:10:00.000Z"); // after the 13:05 lease expiry
    const client = createFakeDigestRunClient([
        { digestDate: "2026-08-10", status: "PROCESSING", attempts: 1, claimToken: "stale-token", leaseExpiresAt: new Date("2026-08-11T13:05:00.000Z") },
    ]);
    const result = await claimDigestRun(client, "2026-08-10", now);
    assert.equal(result.claimed, true);
    if (result.claimed) {
        assert.equal(result.attempts, 2);
        assert.notEqual(result.claimToken, "stale-token");
    }
});

test("claimDigestRun retries a FAILED date under the attempt cap", async () => {
    const client = createFakeDigestRunClient([
        { digestDate: "2026-08-10", status: "FAILED", attempts: 3, claimToken: "t3", leaseExpiresAt: new Date("2026-08-11T12:00:00.000Z") },
    ]);
    const result = await claimDigestRun(client, "2026-08-10", new Date("2026-08-11T14:00:00.000Z"));
    assert.equal(result.claimed, true);
    if (result.claimed) assert.equal(result.attempts, 4);
});

test("claimDigestRun refuses a FAILED date once it's hit the attempt cap", async () => {
    const client = createFakeDigestRunClient([
        { digestDate: "2026-08-10", status: "FAILED", attempts: MAX_DIGEST_ATTEMPTS, claimToken: "t5", leaseExpiresAt: new Date("2026-08-11T12:00:00.000Z") },
    ]);
    const result = await claimDigestRun(client, "2026-08-10", new Date("2026-08-11T14:00:00.000Z"));
    assert.deepEqual(result, { claimed: false, reason: "terminal-failed" });
});

test("finalizeDigestRun is fenced: a stolen claimToken cannot overwrite the new worker's result", async () => {
    const client = createFakeDigestRunClient([
        { digestDate: "2026-08-10", status: "PROCESSING", attempts: 2, claimToken: "new-worker-token", leaseExpiresAt: new Date("2026-08-11T13:20:00.000Z") },
    ]);
    // An old worker whose lease already expired (and was stolen) tries to
    // finalize with its OLD token — must be a silent no-op, never a write.
    const finalized = await finalizeDigestRun(client, "2026-08-10", "old-stale-token", "SENT");
    assert.equal(finalized, false);
    assert.equal(client.rows.get("2026-08-10")?.status, "PROCESSING");
});

test("finalizeDigestRun succeeds when the claimToken still matches", async () => {
    const client = createFakeDigestRunClient([
        { digestDate: "2026-08-10", status: "PROCESSING", attempts: 1, claimToken: "my-token", leaseExpiresAt: new Date("2026-08-11T13:20:00.000Z") },
    ]);
    const finalized = await finalizeDigestRun(client, "2026-08-10", "my-token", "SENT");
    assert.equal(finalized, true);
    assert.equal(client.rows.get("2026-08-10")?.status, "SENT");
});

// ── runDigestTick orchestration ──────────────────────────────────────────

function baseDeps(overrides: Partial<AutomationDigestDeps> = {}): AutomationDigestDeps {
    return {
        now: () => new Date("2026-08-11T13:00:00.000Z"), // 06:00 PDT — within send window
        digestRunClient: createFakeDigestRunClient(),
        getTokens: async () => ({ accessToken: "a", refreshToken: "r", realmId: "1" }),
        queryPurchasesCreatedBetween: async () => [],
        findDriveLinks: async () => new Map(),
        sendDigest: async () => ({ success: true }),
        sendTerminalAlert: async () => ({ success: true }),
        ...overrides,
    };
}

test("runDigestTick skips outside the send window without claiming anything", async () => {
    const digestRunClient = createFakeDigestRunClient();
    const deps = baseDeps({ now: () => new Date("2026-08-11T10:00:00.000Z"), digestRunClient }); // 03:00 PDT
    const result = await runDigestTick(deps, { vanessaEmail: "v@x.com", digestCcEmail: "cc@x.com" });
    assert.deepEqual(result, { ok: true, skipped: "before-send-window" });
    assert.equal(digestRunClient.rows.size, 0);
});

test("runDigestTick sends and marks SENT on success", async () => {
    let sendCalls = 0;
    const deps = baseDeps({
        queryPurchasesCreatedBetween: async () => [{
            Id: "1", PrivateNote: "[gtr-file:abc]", TxnDate: "2026-08-10", TotalAmt: 10, EntityRef: { name: "V" }, CustomerRef: { name: "P" },
        }],
        sendDigest: async () => { sendCalls += 1; return { success: true }; },
    });
    const result = await runDigestTick(deps, { vanessaEmail: "v@x.com", digestCcEmail: "cc@x.com" });
    assert.equal(sendCalls, 1);
    assert.equal(result.ok, true);
    if (result.ok && "sent" in result) {
        assert.equal(result.digestDate, "2026-08-10");
        assert.equal(result.rowCount, 1);
    }
    const row = await deps.digestRunClient.findUnique({ where: { digestDate: "2026-08-10" } });
    assert.equal(row?.status, "SENT");
});

test("runDigestTick marks FAILED (not SENT) when Resend delivery fails, and does not alert before the attempt cap", async () => {
    let alertCalls = 0;
    const deps = baseDeps({
        sendDigest: async () => ({ success: false }),
        sendTerminalAlert: async () => { alertCalls += 1; return { success: true }; },
    });
    const result = await runDigestTick(deps, { vanessaEmail: "v@x.com", digestCcEmail: "cc@x.com" });
    assert.equal(result.ok, false);
    const row = await deps.digestRunClient.findUnique({ where: { digestDate: "2026-08-10" } });
    assert.equal(row?.status, "FAILED");
    assert.equal(row?.attempts, 1);
    assert.equal(alertCalls, 0);
});

test("runDigestTick marks FAILED on a thrown error too (QBO lookup/render failure), not just a false send result", async () => {
    const deps = baseDeps({
        queryPurchasesCreatedBetween: async () => { throw new Error("QBO query failed"); },
    });
    const result = await runDigestTick(deps, { vanessaEmail: "v@x.com", digestCcEmail: "cc@x.com" });
    assert.equal(result.ok, false);
    const row = await deps.digestRunClient.findUnique({ where: { digestDate: "2026-08-10" } });
    assert.equal(row?.status, "FAILED");
});

test("runDigestTick sends the terminal-failure alert once attempts reach the cap", async () => {
    let alertCalls = 0;
    const digestRunClient = createFakeDigestRunClient([
        {
            digestDate: "2026-08-10",
            status: "FAILED",
            attempts: MAX_DIGEST_ATTEMPTS - 1,
            claimToken: "prev",
            leaseExpiresAt: new Date("2026-08-11T12:00:00.000Z"),
        },
    ]);
    const deps = baseDeps({
        digestRunClient,
        sendDigest: async () => ({ success: false }),
        sendTerminalAlert: async ({ attempts }) => {
            alertCalls += 1;
            assert.equal(attempts, MAX_DIGEST_ATTEMPTS);
            return { success: true };
        },
    });
    const result = await runDigestTick(deps, { vanessaEmail: "v@x.com", digestCcEmail: "cc@x.com" });
    assert.equal(result.ok, false);
    assert.equal(alertCalls, 1);
    const row = await digestRunClient.findUnique({ where: { digestDate: "2026-08-10" } });
    assert.equal(row?.status, "FAILED");
    assert.equal(row?.attempts, MAX_DIGEST_ATTEMPTS);
});

test("runDigestTick is a no-op on an already-SENT date — Resend is never called again", async () => {
    let sendCalls = 0;
    const digestRunClient = createFakeDigestRunClient([
        { digestDate: "2026-08-10", status: "SENT", attempts: 1, claimToken: "prev", leaseExpiresAt: new Date("2026-08-11T12:00:00.000Z") },
    ]);
    const deps = baseDeps({ digestRunClient, sendDigest: async () => { sendCalls += 1; return { success: true }; } });
    const result = await runDigestTick(deps, { vanessaEmail: "v@x.com", digestCcEmail: "cc@x.com" });
    assert.deepEqual(result, { ok: true, skipped: "already-sent" });
    assert.equal(sendCalls, 0);
});
