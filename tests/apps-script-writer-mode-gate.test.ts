import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// Guards the RECEIPT_WRITER_MODE gate in docs/apps-script/runReceiptAutomation.gs.
// receiptWriterMode_ / forwardReceiptFromScanV2_ are deployed from receiptV2Dispatch.gs
// (not in this repo), so the harness supplies them. The scanner must never fall back to
// legacy processing when the helper is absent.

type Mode = "legacy" | "v2" | "paused";

function iterator<T>(items: T[]) {
    let index = 0;
    return { hasNext: () => index < items.length, next: () => items[index++] };
}

function scanner(opts: { mode?: Mode; quota?: number; forwardThrows?: boolean; defineModeHelper?: boolean }) {
    const effects = { quotaChecks: 0, forwards: [] as string[], emails: 0, fetches: 0, moves: [] as string[],
        nameReads: 0, descriptionReads: 0, descriptionWrites: 0, logs: [] as string[], scanned: 0 };
    const makeFile = (id: string) => ({
        getId: () => id,
        getName: () => { effects.nameReads++; return id + ".png"; },
        getMimeType: () => "image/png",
        getBlob: () => ({ getBytes: () => [1], getName: () => id + ".png", getContentType: () => "image/png" }),
        getDescription: () => { effects.descriptionReads++; return "{}"; },
        setDescription: () => { effects.descriptionWrites++; },
        moveTo: (where: string) => effects.moves.push(where),
        getDateCreated: () => new Date("2026-09-08T00:00:00Z"),
    });
    const files = [makeFile("file-A"), makeFile("file-B")];
    const projectFolder = { getName: () => "Mueller", getFiles: () => iterator(files), getFolders: () => iterator([]) };
    const context = vm.createContext({
        Session: { getEffectiveUser: () => ({ getEmail: () => "test@example.com" }) },
        Logger: { log: (line: string) => effects.logs.push(String(line)) },
        PropertiesService: { getScriptProperties: () => ({ getProperty: () => "test" }) },
        Utilities: { base64Encode: () => "AQ==" },
        UrlFetchApp: { fetch: () => { effects.fetches++; return { getResponseCode: () => 200, getContentText: () => "{}" }; } },
        MailApp: {
            getRemainingDailyQuota: () => { effects.quotaChecks++; return opts.quota ?? 100; },
            sendEmail: () => { effects.emails++; },
        },
        LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
        DriveApp: { getFolderById: (id: string) => ({ id, getFolders: () => iterator([projectFolder]) }) },
    });
    vm.runInContext(readFileSync("docs/apps-script/runReceiptAutomation.gs", "utf8"), context);
    Object.assign(context, {
        sweepChatReceipts: () => {},
        reconcileIntakeFoldersDaily_: () => {},
        getOrCreateFolder: () => "review",
        ensureShopCategories: () => {},
        forwardReceiptFromScanV2_: (file: { getId: () => string }, ctx: { projectName: string }) => {
            effects.forwards.push(file.getId() + "@" + ctx.projectName);
            if (opts.forwardThrows) throw new Error("v2 forwarding disabled");
        },
        // Legacy pipeline entry points. Reaching any of these in a non-legacy mode is a failure.
        getState: () => { effects.scanned++; return {}; },
        setState: () => { effects.descriptionWrites++; },
        sendToQBO: () => { effects.emails++; },
        sendReceiptToQuickBooksViaAPI: () => { effects.fetches++; return {}; },
    });
    if (opts.defineModeHelper !== false) {
        Object.assign(context, { receiptWriterMode_: () => opts.mode ?? "legacy" });
    }
    return { context, effects, files };
}

function assertNoLegacyWork(effects: ReturnType<typeof scanner>["effects"], label: string) {
    assert.equal(effects.nameReads, 0, label + ": file name never read");
    assert.equal(effects.descriptionReads, 0, label + ": legacy state never read");
    assert.equal(effects.descriptionWrites, 0, label + ": legacy state never written");
    assert.equal(effects.scanned, 0, label + ": legacy parse never entered");
    assert.equal(effects.emails, 0, label + ": no QBO or alert email");
    assert.equal(effects.fetches, 0, label + ": no QBO API call");
    assert.deepEqual(effects.moves, [], label + ": no archive or park move");
}

test("paused mode returns before any parse, book, or archive", () => {
    const h = scanner({ mode: "paused" });
    h.context.processSingleFile(h.files[0], { projectName: "Mueller" }, "archive", "review");
    assertNoLegacyWork(h.effects, "paused");
    assert.deepEqual(h.effects.forwards, [], "paused never forwards to v2 either");
});

test("v2 mode forwards under the scan and a failed forward is caught with no legacy fallback", () => {
    const h = scanner({ mode: "v2", forwardThrows: true });
    h.context.runReceiptAutomation();
    assert.deepEqual(h.effects.forwards, ["file-A@Mueller", "file-B@Mueller"], "the scan continues past a failed forward");
    assert.ok(h.effects.logs.some(l => /\[V2 REVIEW\] forwarding failed: v2 forwarding disabled/.test(l)));
    assertNoLegacyWork(h.effects, "v2 failure");
});

test("v2 mode success still does no legacy work", () => {
    const h = scanner({ mode: "v2" });
    h.context.processSingleFile(h.files[0], { projectName: "Mueller" }, "archive", "review");
    assert.deepEqual(h.effects.forwards, ["file-A@Mueller"]);
    assertNoLegacyWork(h.effects, "v2 success");
});

test("mail quota gating applies to legacy only", () => {
    const legacy = scanner({ mode: "legacy", quota: 0 });
    legacy.context.runReceiptAutomation();
    assert.equal(legacy.effects.quotaChecks, 1);
    assert.equal(legacy.effects.scanned, 0, "legacy with no quota skips the whole scan");
    assert.ok(legacy.effects.logs.some(l => /Daily mail quota is exhausted/.test(l)));

    const v2 = scanner({ mode: "v2", quota: 0 });
    v2.context.runReceiptAutomation();
    assert.equal(v2.effects.quotaChecks, 0, "v2 never consults the mail quota");
    assert.deepEqual(v2.effects.forwards, ["file-A@Mueller", "file-B@Mueller"], "v2 scans with zero quota");
    assertNoLegacyWork(v2.effects, "v2 zero quota");

    const paused = scanner({ mode: "paused", quota: 0 });
    paused.context.runReceiptAutomation();
    assert.equal(paused.effects.quotaChecks, 0, "paused never consults the mail quota");
    assertNoLegacyWork(paused.effects, "paused zero quota");
    assert.deepEqual(paused.effects.forwards, []);
});

test("a missing mode helper fails closed instead of falling back to legacy", () => {
    const h = scanner({ defineModeHelper: false });
    assert.throws(() => h.context.processSingleFile(h.files[0], { projectName: "Mueller" }, "archive", "review"),
        /receiptWriterMode_ is not defined/);
    assertNoLegacyWork(h.effects, "missing helper");
});
