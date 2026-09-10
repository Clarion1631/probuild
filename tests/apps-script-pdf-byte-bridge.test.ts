import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";

// Real pinned pdf-lib from node_modules: host copy validates output, UMD copy runs inside the scanner VM.
const require = createRequire(path.join(process.cwd(), "package.json"));
const host: any = require("pdf-lib");
const umdSource = readFileSync(require.resolve("pdf-lib/dist/pdf-lib.min.js"), "utf8");
const SIZES: Array<[number, number]> = [[200, 300], [400, 500], [600, 700]];

function toSigned(u8: Uint8Array): number[] { return Array.from(u8, (b) => (b > 127 ? b - 256 : b)); }

async function makePdf(): Promise<number[]> {
    const doc = await host.PDFDocument.create();
    for (const [w, h] of SIZES) doc.addPage([w, h]);
    return toSigned(await doc.save());
}

function harness(signedBytes: number[]) {
    const effects = { fetches: 0, notices: [] as string[], moves: [] as string[], children: [] as any[] };
    const folder = (name: string): any => ({ getName: () => name });
    const parent: any = { getName: () => "Project A", getFilesByName: () => ({ hasNext: () => false }),
        createFile: (blob: any) => { effects.children.push(blob); return { setDescription() {} }; } };
    const file: any = { getId: () => "scan-1", getName: () => "scan.pdf", getMimeType: () => "application/pdf",
        getBlob: () => ({ getBytes: () => signedBytes }), getParents: () => ({ next: () => parent }),
        setDescription() {}, moveTo: (where: any) => effects.moves.push(where.getName()) };
    const context = vm.createContext({
        Session: { getEffectiveUser: () => ({ getEmail: () => "test@example.com" }) },
        Logger: { log() {} }, PropertiesService: { getScriptProperties: () => ({ getProperty: () => "test" }) },
        setTimeout, clearTimeout, TextEncoder, TextDecoder, console, // pdf-lib yields via setTimeout while parsing
        DriveApp: { getFolderById: (id: string) => folder("root:" + id) },
        Utilities: { newBlob: (bytes: any, mime: string, name: string) => {
            assert.ok(Array.isArray(bytes) && !ArrayBuffer.isView(bytes), "newBlob must get a plain JS array, never a typed array");
            assert.ok(bytes.every((b: number) => Number.isInteger(b) && b >= -128 && b <= 127), "newBlob bytes are signed -128..127");
            return { bytes, mime, name }; } },
        UrlFetchApp: { fetch: () => { effects.fetches++; throw new Error("unexpected backend fetch"); } },
        MailApp: { sendEmail: (...args: string[]) => effects.notices.push(args.join("\n")) },
    });
    vm.runInContext(readFileSync("docs/apps-script/runReceiptAutomation.gs", "utf8"), context);
    vm.runInContext(umdSource, context, { filename: "pdf-lib.min.js" }); // SAME realm as the scanner
    Object.assign(context, {
        loadPdfLib_: () => context.PDFLib,
        // Gemini JSON.parse creates arrays in the scanner realm in production.
        analyzeMultiPageMapWithGemini: vm.runInContext(`() => ({ transactions: [
            { pages: [1, 3], vendor: "Bigfoot", total_amount: 12, date: "2026-09-01" },
            { pages: [2], vendor: "Yeti", total_amount: 34, date: "2026-09-02" } ] })`, context),
        todayStr: () => "2026-09-10", getOrCreateFolder: (_root: unknown, name: string) => folder(name),
    });
    const run = () => context.tryAutoSplitMultiDoc(file, { projectName: "Test" }, "archive", "scan.pdf");
    const constant = (name: string) => vm.runInContext(name, context);
    return { context, effects, run, constant };
}

// Bounded wait for the async split chain: it always ends in exactly one email (success or failure).
async function settle(effects: { notices: string[] }) {
    for (let i = 0; i < 400 && effects.notices.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(effects.notices.length, 1, "split chain settled with exactly one outcome email");
}

test("baseline: plain signed array and foreign-realm typed array are rejected; same-realm Uint8Array loads", async () => {
    const signed = await makePdf();
    const h = harness(signed);
    assert.notEqual(h.constant("Uint8Array"), Uint8Array, "scanner VM realm differs from host realm");
    await assert.rejects(h.context.PDFLib.PDFDocument.load(signed),
        (e: any) => e.name === "TypeError" && /Uint8Array/.test(e.message) && /Array/.test(e.message));
    await assert.rejects(h.context.PDFLib.PDFDocument.load(Uint8Array.from(signed)), (e: any) => e.name === "TypeError");
    const doc = await h.context.PDFLib.PDFDocument.load(new (h.constant("Uint8Array"))(signed));
    assert.equal(doc.getPageCount(), 3);
});

test("real multi-page PDF splits through the signed-byte bridge with correct pages and sizes", async () => {
    const signed = await makePdf();
    assert.ok(signed.some((b) => b < 0), "fixture contains negative signed input bytes");
    const h = harness(signed);
    assert.equal(h.run(), true);
    await settle(h.effects);
    assert.match(h.effects.notices[0], /auto-split a multi-receipt scan/);
    assert.equal(h.effects.fetches, 0);
    assert.deepEqual(h.effects.moves, [h.constant("SPLIT_ORIGINALS_NAME")], "original archived exactly once");
    assert.deepEqual(h.effects.children.map((c) => c.name), ["scan_part1of2.pdf", "scan_part2of2.pdf"]);
    const expected = [[SIZES[0], SIZES[2]], [SIZES[1]]];
    for (let i = 0; i < expected.length; i++) {
        const bytes: number[] = h.effects.children[i].bytes;
        assert.ok(bytes.some((b) => b < 0), "child output carries negative signed bytes");
        const doc = await host.PDFDocument.load(Uint8Array.from(bytes));
        assert.equal(doc.getPageCount(), expected[i].length);
        assert.deepEqual(doc.getPages().map((p: any) => [p.getWidth(), p.getHeight()]), expected[i]);
    }
});

test("invalid PDF fails the split, parks to needs-review, creates no children and no backend writes", async () => {
    const h = harness(toSigned(new TextEncoder().encode("this is not a pdf at all")));
    assert.equal(h.run(), true);
    await settle(h.effects);
    assert.match(h.effects.notices[0], /auto-split failed/);
    assert.equal(h.effects.children.length, 0);
    assert.equal(h.effects.fetches, 0);
    assert.deepEqual(h.effects.moves, [h.constant("NEEDS_REVIEW_NAME")]);
});

test("helper wraps all 256 byte values to signed Apps Script bytes and round-trips", () => {
    const h = harness([]);
    const all = new (h.constant("Uint8Array"))(256).map((_: number, i: number) => i);
    const signed: number[] = h.context.pdfBytesToAppsScriptBytes_(all);
    assert.ok(Array.isArray(signed) && !ArrayBuffer.isView(signed));
    assert.equal(signed.length, 256);
    assert.equal(signed[0], 0); assert.equal(signed[127], 127); assert.equal(signed[128], -128); assert.equal(signed[255], -1);
    assert.deepEqual(Array.from(Uint8Array.from(signed)), Array.from(all));
});
