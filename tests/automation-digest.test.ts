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
    // The bot never sets a top-level Purchase.CustomerRef — only a per-LINE
    // AccountBasedExpenseLineDetail.CustomerRef (qbo-receipt-push.ts) — so
    // this fixture (and the real data it stands in for) carries the project
    // on the line, not at the top level.
    const shopLine = { DetailType: "AccountBasedExpenseLineDetail", AccountBasedExpenseLineDetail: { CustomerRef: { value: "shop-1", name: "Shop" } } };
    const rows = buildDigestRows([
        {
            Id: "101",
            PrivateNote: "Shop - Lowe's ($42.10) [gtr-file:abcdefghijklmnopqrstuvwxyz123]",
            TxnDate: "2026-08-10",
            TotalAmt: 42.1,
            EntityRef: { name: "Lowe's" },
            Line: [shopLine],
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
            Line: [shopLine],
        },
    ]);

    assert.equal(rows.length, 1);
    assert.equal(rows[0].qbPurchaseId, "101");
    assert.equal(rows[0].docNumber, "abcdefghijklmnopqrstu"); // slice(0, 21) of the fileId
    assert.equal(rows[0].vendor, "Lowe's");
    assert.equal(rows[0].amountCents, 4210);
    assert.equal(rows[0].projectName, "Shop");
});

test("buildDigestRows reads the project from the LINE-level CustomerRef, not the top-level Purchase.CustomerRef", () => {
    // createQBReceiptPurchase (qbo-receipt-push.ts) never sets a top-level
    // CustomerRef at all — only AccountBasedExpenseLineDetail.CustomerRef per
    // line. A top-level CustomerRef (if QBO ever echoed one) must be ignored.
    const rows = buildDigestRows([{
        Id: "201",
        PrivateNote: "Mueller Bathroom - Contractor Supply ($125.50) [gtr-file:linefileid1234567890xyz]",
        TxnDate: "2026-08-10",
        TotalAmt: 125.5,
        EntityRef: { name: "Contractor Supply" },
        CustomerRef: { name: "Some Other Name Should Be Ignored" },
        Line: [
            {
                DetailType: "AccountBasedExpenseLineDetail",
                AccountBasedExpenseLineDetail: { CustomerRef: { value: "job-1", name: "Mueller Bathroom" } },
            },
        ],
    }]);

    assert.equal(rows.length, 1);
    assert.equal(rows[0].projectName, "Mueller Bathroom");
});

test("buildDigestRows joins genuinely mixed line-level project names with ', '", () => {
    const rows = buildDigestRows([{
        Id: "202",
        PrivateNote: "Shop - Vendor ($50.00) [gtr-file:mixedfileid1234567890xy]",
        TxnDate: "2026-08-10",
        TotalAmt: 50,
        EntityRef: { name: "Vendor" },
        Line: [
            { DetailType: "AccountBasedExpenseLineDetail", AccountBasedExpenseLineDetail: { CustomerRef: { value: "job-1", name: "Mueller Bathroom" } } },
            { DetailType: "AccountBasedExpenseLineDetail", AccountBasedExpenseLineDetail: { CustomerRef: { value: "job-2", name: "Berg ADU" } } },
            // A duplicate of an existing name must not be double-counted.
            { DetailType: "AccountBasedExpenseLineDetail", AccountBasedExpenseLineDetail: { CustomerRef: { value: "job-1", name: "Mueller Bathroom" } } },
        ],
    }]);

    assert.equal(rows.length, 1);
    assert.equal(rows[0].projectName, "Mueller Bathroom, Berg ADU");
});

test("buildDigestRows reports no project when no line carries a CustomerRef", () => {
    const rows = buildDigestRows([{
        Id: "203",
        PrivateNote: "Overhead purchase [gtr-file:nolinerefid1234567890xy]",
        TxnDate: "2026-08-10",
        TotalAmt: 15,
        EntityRef: { name: "Vendor" },
        Line: [{ DetailType: "AccountBasedExpenseLineDetail", AccountBasedExpenseLineDetail: {} }],
    }]);

    assert.equal(rows.length, 1);
    assert.equal(rows[0].projectName, null);
});

// ── DigestRun claim (fenced CAS) ─────────────────────────────────────────

/** In-memory fake matching the minimal DigestRunClient shape — mirrors the
 * fake ExpenseTransaction pattern in tests/qbo-expense-sync.test.ts. */
function createFakeDigestRunClient(initial: Partial<DigestRunRow>[] = []): DigestRunClient & { rows: Map<string, DigestRunRow> } {
    const rows = new Map(initial.map((r) => [
        r.digestDate!,
        { alertSent: false, lastError: null, ...r } as DigestRunRow,
    ]));
    return {
        rows,
        async findUnique({ where }) {
            return rows.get(where.digestDate) ?? null;
        },
        async findFirst({ where }) {
            for (const row of rows.values()) {
                if (where.status !== undefined && row.status !== where.status) continue;
                if (where.alertSent !== undefined && row.alertSent !== where.alertSent) continue;
                const attemptsFilter = where.attempts as { gte?: number } | undefined;
                if (attemptsFilter?.gte !== undefined && row.attempts < attemptsFilter.gte) continue;
                return row;
            }
            return null;
        },
        async create({ data }) {
            if (rows.has(data.digestDate)) {
                const err = new Error("unique constraint") as Error & { code?: string };
                err.code = "P2002";
                throw err;
            }
            const row: DigestRunRow = { alertSent: false, lastError: null, ...data };
            rows.set(data.digestDate, row);
            return row;
        },
        async updateMany({ where, data }) {
            const row = rows.get(where.digestDate as string);
            if (!row) return { count: 0 };
            if (where.status !== undefined && row.status !== where.status) return { count: 0 };
            if (where.claimToken !== undefined && row.claimToken !== where.claimToken) return { count: 0 };
            if (where.alertSent !== undefined && row.alertSent !== where.alertSent) return { count: 0 };
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
    // Delivery of the ALERT itself is durably recorded, not fire-and-forget.
    assert.equal(row?.alertSent, true);
});

test("runDigestTick retries the terminal-failure alert on a LATER tick when the first alert attempt itself fails", async () => {
    let alertAttempts = 0;
    let alertShouldSucceed = false;
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
        sendTerminalAlert: async () => {
            alertAttempts += 1;
            return { success: alertShouldSucceed };
        },
    });

    // Tick 1: hits the attempt cap, tries to alert immediately — Resend
    // rejects the ALERT itself this time.
    const first = await runDigestTick(deps, { vanessaEmail: "v@x.com", digestCcEmail: "cc@x.com" });
    assert.equal(first.ok, false);
    assert.equal(alertAttempts, 1);
    let row = await digestRunClient.findUnique({ where: { digestDate: "2026-08-10" } });
    assert.equal(row?.status, "FAILED");
    assert.equal(row?.alertSent, false);
    assert.equal(row?.lastError, "Resend reported failure sending the digest");

    // Tick 2 (an hour later): the digest date itself is terminal and
    // unclaimable, but the pending-alert retry must still fire — and this
    // time Resend accepts it.
    alertShouldSucceed = true;
    const second = await runDigestTick(deps, { vanessaEmail: "v@x.com", digestCcEmail: "cc@x.com" });
    assert.equal(alertAttempts, 2);
    row = await digestRunClient.findUnique({ where: { digestDate: "2026-08-10" } });
    assert.equal(row?.alertSent, true);
    // The digest date itself is still terminally FAILED — only the alert changed.
    assert.equal(row?.status, "FAILED");
    void second;

    // Tick 3: alert already delivered — must not be retried again.
    const third = await runDigestTick(deps, { vanessaEmail: "v@x.com", digestCcEmail: "cc@x.com" });
    assert.equal(alertAttempts, 2);
    void third;
});

test("runDigestTick's pending-alert retry runs even outside the send window, and even for a date that is no longer 'yesterday'", async () => {
    let alertAttempts = 0;
    const digestRunClient = createFakeDigestRunClient([
        {
            // A date well in the past relative to `now` below — no longer
            // "yesterday" for any digestDate this tick would itself compute.
            digestDate: "2026-08-01",
            status: "FAILED",
            attempts: MAX_DIGEST_ATTEMPTS,
            claimToken: "prev",
            leaseExpiresAt: new Date("2026-08-01T12:00:00.000Z"),
            alertSent: false,
            lastError: "boom",
        },
    ]);
    const deps = baseDeps({
        digestRunClient,
        now: () => new Date("2026-08-11T10:00:00.000Z"), // 03:00 PDT — BEFORE the send window
        sendTerminalAlert: async ({ digestDate, attempts, lastError }) => {
            alertAttempts += 1;
            assert.equal(digestDate, "2026-08-01");
            assert.equal(attempts, MAX_DIGEST_ATTEMPTS);
            assert.equal(lastError, "boom");
            return { success: true };
        },
    });

    const result = await runDigestTick(deps, { vanessaEmail: "v@x.com", digestCcEmail: "cc@x.com" });
    assert.equal(alertAttempts, 1);
    assert.deepEqual(result, { ok: true, skipped: "before-send-window" }); // the CURRENT digestDate's own outcome is unaffected
    const row = await digestRunClient.findUnique({ where: { digestDate: "2026-08-01" } });
    assert.equal(row?.alertSent, true);
});

test("runDigestTick surfaces ok:false (-> 500) when the pending-alert retry itself fails, even though today's own digest sends fine", async () => {
    let sendDigestCalls = 0;
    const digestRunClient = createFakeDigestRunClient([
        {
            // An OLDER, unrelated terminally-FAILED date whose alert keeps failing.
            digestDate: "2026-08-01",
            status: "FAILED",
            attempts: MAX_DIGEST_ATTEMPTS,
            claimToken: "prev",
            leaseExpiresAt: new Date("2026-08-01T12:00:00.000Z"),
            alertSent: false,
            lastError: "boom",
        },
    ]);
    const deps = baseDeps({
        digestRunClient, // baseDeps' now() is within the send window; computes digestDate "2026-08-10"
        sendDigest: async () => { sendDigestCalls += 1; return { success: true }; },
        sendTerminalAlert: async () => ({ success: false }), // the ALERT itself keeps being rejected
    });

    const result = await runDigestTick(deps, { vanessaEmail: "v@x.com", digestCcEmail: "cc@x.com" });

    // The tick's overall result must be ok:false — digestResultResponse maps
    // that to HTTP 500 — reporting the ALERT failure, not silently 200.
    assert.deepEqual(result, {
        ok: false,
        digestDate: "2026-08-01",
        attempts: MAX_DIGEST_ATTEMPTS,
        error: "terminal-failure alert delivery is still failing for 2026-08-01",
    });

    // Today's own digest (an unrelated date) must still have run in the SAME
    // tick — not skipped just because the alert retry failed.
    assert.equal(sendDigestCalls, 1);
    const todayRow = await digestRunClient.findUnique({ where: { digestDate: "2026-08-10" } });
    assert.equal(todayRow?.status, "SENT");

    // The stuck alert's row is untouched (still unsent) — no false "delivered".
    const alertRow = await digestRunClient.findUnique({ where: { digestDate: "2026-08-01" } });
    assert.equal(alertRow?.alertSent, false);
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
