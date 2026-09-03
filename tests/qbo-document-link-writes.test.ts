/**
 * NOTHING writes a document link outside the identity decision.
 *
 * Rounds 39, 40, 41 and 42 all found the same bug in a different place: some
 * path deciding to link, adopt or claim a QuickBooks document while comparing
 * only a SUBSET of the record's state. Each round the fix was to route one more
 * caller through `decideUnderIdentity` — and each round the next reviewer found
 * a caller that had been missed.
 *
 * So this stops relying on review. Every write to `qbEstimateId`,
 * `qbInvoiceId` or `qbSyncMarker` anywhere in `src/` must sit inside one of the
 * two functions that take the money locks and compare the whole payload
 * identity against the marker, or be listed below with a reason. A new code
 * path that writes one of those columns fails this test until it is either
 * routed through the decision or deliberately excepted.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * The columns that say "this record is linked to that QuickBooks document".
 *
 * `qbEstimateId` and `qbSyncMarker` belong to the DOCUMENT rail alone, so they
 * are guarded wherever they appear. `qbInvoiceId` is a shared name: the
 * milestone rail (PaymentSchedule) and the progress-billing rail carry one too,
 * and each has its OWN guarded finalizer — finalizeMilestoneLinkUnderLock,
 * finalizeProgressBillingLinkUnderLock, compensateAndUnlink, claimQBInvoiceUnlink
 * — with its own tests. So that column is only guarded inside the document
 * rail files; requiring the other two rails to call `decideUnderIdentity` would
 * be wrong, not stricter.
 */
const LINK_COLUMNS = ["qbEstimateId", "qbInvoiceId", "qbSyncMarker"] as const;

/** Where `qbInvoiceId` means "the document rail linked something". */
const DOCUMENT_RAIL_FILES = [
    "src/app/api/quickbooks/sync/route.ts",
    "src/app/api/integrations/qbo-maintenance/route.ts",
    "src/lib/qbo-document-sync.ts",
];

/** Is this write one the document-rail decision is responsible for? */
function inScope(rel: string, column: string): boolean {
    if (column !== "qbInvoiceId") return true;
    return DOCUMENT_RAIL_FILES.includes(rel);
}

/**
 * Calls whose bodies are allowed to contain such a write.
 *
 * `decideUnderIdentity` IS the decision. `recoverClaimedRecord` takes its
 * `adopt`/`reclaim` callbacks and runs BOTH of them through it — asserted
 * separately below, so listing it here does not create a second unguarded door.
 */
const GUARDED_CALLS = ["decideUnderIdentity(", "recoverClaimedRecord("] as const;

/**
 * Deliberate exceptions, each with the reason it is not an identity decision.
 * Adding one is a visible choice rather than an omission.
 */
const ALLOWED: Array<{ file: string; contains: string; why: string }> = [
    {
        file: "src/app/api/quickbooks/sync/route.ts",
        contains: "settleSyncMarker",
        why:
            "Releases or promotes the CLAIM after a failed create (create-in-flight -> " +
            "ambiguous-create, or cleared). It links nothing, and it must run precisely " +
            "when the record may have moved, so gating it on the identity matching would " +
            "leave a claim stranded exactly when the marker matters most.",
    },
];

function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
        else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(full);
    }
    return out;
}

/** The [start, end) offsets of every `name(...)` call body in `src`. */
function callSpans(src: string, name: string): Array<[number, number]> {
    const spans: Array<[number, number]> = [];
    let from = 0;
    for (;;) {
        const at = src.indexOf(name, from);
        if (at === -1) break;
        from = at + name.length;
        let depth = 0;
        let i = at + name.length - 1; // the opening paren
        for (; i < src.length; i++) {
            if (src[i] === "(") depth++;
            else if (src[i] === ")") {
                depth--;
                if (depth === 0) break;
            }
        }
        // An unbalanced call means this scanner has lost the plot; fail loudly
        // rather than silently reporting "no writes found".
        assert.ok(i < src.length, `unbalanced ${name} call at offset ${at}`);
        spans.push([at, i]);
    }
    return spans;
}

test("every document-link write goes through the identity decision", () => {
    const files = sourceFiles("src");
    assert.ok(files.length > 100, `only ${files.length} source files scanned — glob or cwd is wrong`);

    const columns = LINK_COLUMNS.join("|");
    // A Prisma `data: { ... }` payload mentioning one of the link columns. The
    // inner class excludes braces so this matches one object literal, not a
    // greedy run across the whole file.
    const writeRe = new RegExp(String.raw`data:\s*\{[^{}]*\b(${columns})\b`, "g");

    const offenders: string[] = [];
    let found = 0;
    for (const file of files) {
        const src = readFileSync(file, "utf8");
        if (!LINK_COLUMNS.some((c) => src.includes(c))) continue;
        const guarded = GUARDED_CALLS.flatMap((name) => callSpans(src, name));
        const rel = file.split(path.sep).join("/");

        for (const m of src.matchAll(writeRe)) {
            if (inScope(rel, m[1])) found++;
            const at = m.index ?? 0;
            if (!inScope(rel, m[1])) continue;
            if (guarded.some(([s, e]) => at > s && at < e)) continue;
            const allowed = ALLOWED.some(
                (a) => a.file === rel && src.slice(Math.max(0, at - 2000), at).includes(a.contains),
            );
            if (allowed) continue;
            const line = src.slice(0, at).split(String.fromCharCode(10)).length;
            offenders.push(`${rel}:${line} writes ${m[1]} outside decideUnderIdentity`);
        }
    }

    // The scanner must actually be finding the known writes, or an empty result
    // would read as a clean pass forever.
    assert.ok(found >= 6, `only ${found} link writes found — the scanner has stopped matching`);
    assert.deepEqual(offenders, [], offenders.join("\n"));
});

test("recoverClaimedRecord routes BOTH of its writes through the identity decision", () => {
    // The allowlist above trusts this. If adopt or reclaim ever stopped going
    // through `decideUnderIdentity`, the scanner would still call their call
    // sites guarded — so the trust is asserted here rather than assumed.
    const src = readFileSync("src/app/api/quickbooks/sync/route.ts", "utf8");
    const at = src.indexOf("async function recoverClaimedRecord(");
    assert.ok(at > -1, "recoverClaimedRecord not found — has it been renamed?");
    // To the NEXT top-level declaration, not to the first column-0 "}": the
    // parameter object literal closes at column 0 too, which cut the slice off
    // before the body and made this assert on an empty function.
    const nl = String.fromCharCode(10);
    const after = [nl + "function ", nl + "async function ", nl + "export "]
        .map((k) => src.indexOf(k, at + 10))
        .filter((i) => i > -1);
    const fn = src.slice(at, after.length ? Math.min(...after) : src.length);

    for (const [label, callback] of [["adopt", "args.adopt("], ["reclaim", "args.reclaim("]] as const) {
        const call = fn.indexOf(callback);
        assert.ok(call > -1, `recoverClaimedRecord no longer invokes ${label}`);
        const decisions = fn.split("decideUnderIdentity(").length - 1;
        assert.ok(decisions >= 2, `${label}: both paths must run under decideUnderIdentity`);
    }
});
