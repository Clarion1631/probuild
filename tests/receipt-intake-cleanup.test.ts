/**
 * The orphaned-object cleanup queue.
 *
 * This exists for one failure: a row is deleted while its object may still be
 * in the bucket. After that nothing in the database references those bytes, so
 * the queue record IS the last pointer to them — which makes "best effort" the
 * wrong posture for writing it, and makes deleting the wrong path unrecoverable.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const cleanup = readFileSync(path.join(ROOT, "src/lib/receipt-intake/storage-cleanup.ts"), "utf8");
const intake = readFileSync(path.join(ROOT, "src/app/api/receipts/intake/route.ts"), "utf8");
const storage = readFileSync(path.join(ROOT, "src/lib/secure-storage.ts"), "utf8");

/**
 * The body of one top-level function, EOL-agnostic.
 *
 * `indexOf("\n}\n")` returns -1 on a CRLF checkout (the bytes there are
 * "\r\n}\r\n"), and `slice(0, -1)` then quietly hands back the REST OF THE
 * FILE — so an assertion scoped to one function silently starts reading every
 * function after it, and these tests pass or fail for the wrong reason. Git's
 * autocrlf makes that a property of who cloned the repo, not of the code.
 */
function bodyOf(source: string, declaration: string): string {
    const from = source.indexOf(declaration);
    assert.notEqual(from, -1, `not found: ${declaration}`);
    const rest = source.slice(from);
    const end = rest.search(/\r?\n\}\r?\n/);
    assert.notEqual(end, -1, `no closing brace found for ${declaration}`);
    return rest.slice(0, end);
}

test("bodyOf stops at the function it was given, on either line ending", () => {
    // The control. Without it the helper could go back to returning the whole
    // file and every assertion below would still pass.
    const lf = "function a() {\n    inA();\n}\n\nfunction b() {\n    inB();\n}\n";
    for (const text of [lf, lf.replace(/\n/g, "\r\n")]) {
        const body = bodyOf(text, "function a()");
        assert.match(body, /inA\(\)/);
        assert.ok(!body.includes("inB()"), "it did not run on into the next function");
    }
});

test("recording a cleanup is durable, not fire-and-forget", () => {
    // logAutomationEvent never throws by contract, so "it did not throw" is not
    // proof it wrote. The record is read back, and the function throws if it is
    // not there — the caller has to know.
    const body = bodyOf(cleanup, "export async function recordPendingCleanup");
    assert.ok(!/\.catch\(\(\)\s*=>\s*\{/.test(body), "the write is not swallowed");
    assert.match(body, /findFirst/, "it is read back");
    assert.match(body, /throw new Error/, "and a missing record throws");
});

test("an unrecordable cleanup KEEPS the row as the last pointer", () => {
    // If the queue record cannot be written, deleting the row would orphan the
    // bytes with nothing anywhere referencing them. The STAGING row is then the
    // only way to find them, so it stays and the sweeper resolves it.
    assert.match(intake, /cleanup unrecordable; keeping the row as the pointer/);
    assert.match(intake, /retained: true/);
});

test("a failed row deletion is surfaced, not swallowed", () => {
    // Otherwise the caller retries, hits a sourceRef conflict against a row it
    // was just told does not exist, and has no way to interpret that.
    assert.match(intake, /row delete failed after an ambiguous upload/);
});

test("the cleanup worker refuses to delete a path a LIVE row still points at", () => {
    // Reachable through the recovery sequence: an ambiguous upload records a
    // cleanup, the row goes, the caller retries, and the retry's row can point
    // at the same path — or a seal publishes a canonical path an older pending
    // event names. Deleting then destroys a receipt in active use.
    const fn = bodyOf(cleanup, "export async function retryPendingCleanups");
    assert.match(fn, /receiptIntake\.findFirst\(\{\s*\n?\s*where: \{ storagePath \}/, "it checks for a referencing row");
    assert.match(fn, /still referenced by/, "and resolves rather than retrying forever");
    // The reference check must come BEFORE the delete.
    assert.ok(
        fn.indexOf("still referenced by") < fn.indexOf("removeSecureDocStrict"),
        "the check precedes the deletion",
    );
});

test("an event is resolved only AFTER a confirmed deletion", () => {
    const fn = bodyOf(cleanup, "export async function retryPendingCleanups");
    // The delete's catch continues to the next event rather than falling
    // through to the resolve.
    assert.match(fn, /\} catch \{[\s\S]*?continue;/, "a failed delete leaves the event pending");
    assert.ok(
        fn.lastIndexOf("removeSecureDocStrict") < fn.lastIndexOf('status: "resolved" }'),
        "resolve happens after the delete",
    );
});

test("a missing storage client is an ERROR for the cleanup path", () => {
    // removeSecureDoc returns quietly with no client — right for its
    // best-effort callers, catastrophic here: it would mark orphans resolved on
    // a misconfigured deployment and lose them permanently.
    assert.match(storage, /export async function removeSecureDocStrict/);
    const strict = bodyOf(storage, "export async function removeSecureDocStrict");
    assert.match(strict, /throw new Error\("secure storage is not configured"\)/);
    // ...and the cleanup queue uses the strict one, never the quiet one.
    assert.ok(!/\bremoveSecureDoc\(/.test(cleanup), "cleanup never uses the quiet variant");
});
