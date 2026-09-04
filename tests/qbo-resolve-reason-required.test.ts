/**
 * The operator's own words reach the audit row.
 *
 * Round 39 made the resolve reason REQUIRED and bounded, and the server has
 * refused an empty one ever since. That was only half of it: the invoice editor
 * kept sending a constant — "Resolved from the invoice editor" — so the check
 * passed, the audit row filled in, and every human override in the log read
 * identically. A record that says the same thing about every decision answers
 * WHO and WHEN and nothing about WHY, which is the part a reviewer needs: it
 * cannot tell "I opened QuickBooks and saw invoice 1042" from a mis-click.
 *
 * Round 45 made the UI ask. This keeps it asking. A future call site that goes
 * back to a canned string fails here rather than passing review.
 *
 * Source-level on purpose, and narrow: the behaviour of the server-side guard
 * (empty refused, over-long refused, the reason landing on the audit row) is
 * covered by real calls in tests/qbo-ambiguous-create.test.ts. What cannot be
 * asserted from there is what the CALLER decided to send.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

// Relative to the repo root, like the other source-level guards: the test
// runner is invoked from there.
const ROOT = process.cwd();

function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        if (entry === "node_modules" || entry === ".next") continue;
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) walk(full, out);
        else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
    }
    return out;
}

/**
 * Every `reason:` property inside a `resolveAmbiguousInvoiceCreate({ ... })`
 * call, as written in the source.
 *
 * Deliberately crude: it reads the call's argument text up to the matching
 * close, which is enough because these call sites are object literals written
 * by hand. A cleverer parse would not catch anything this misses — the failure
 * mode being guarded against is somebody typing a string, not somebody hiding
 * one.
 */
function reasonArguments(source: string): string[] {
    const found: string[] = [];
    const CALL = "resolveAmbiguousInvoiceCreate({";
    let at = source.indexOf(CALL);
    while (at !== -1) {
        let depth = 0;
        let end = at + CALL.length - 1;
        for (let i = at + CALL.length - 1; i < source.length; i++) {
            if (source[i] === "{") depth++;
            else if (source[i] === "}") {
                depth--;
                if (depth === 0) {
                    end = i;
                    break;
                }
            }
        }
        const body = source.slice(at, end);
        for (const m of body.matchAll(/(^|[\s,{])reason\s*:\s*([^\n]*)/g)) {
            found.push(m[2].trim().replace(/,$/, ""));
        }
        at = source.indexOf(CALL, end);
    }
    return found;
}

test("no caller sends a canned resolve reason", () => {
    const files = walk(path.join(ROOT, "src"));
    const callers = files.filter((f) => readFileSync(f, "utf8").includes("resolveAmbiguousInvoiceCreate({"));
    assert.ok(callers.length > 0, "the guard has to be pointed at something that exists");

    for (const file of callers) {
        const rel = path.relative(ROOT, file).replace(/\\/g, "/");
        const reasons = reasonArguments(readFileSync(file, "utf8"));
        assert.ok(reasons.length > 0, `${rel}: a resolve call with no reason at all`);
        for (const reason of reasons) {
            assert.ok(
                !/^["'`]/.test(reason),
                `${rel}: reason is a literal (${reason}). It must be what the operator typed — the audit row is the only record of why a parked money row was overridden.`,
            );
        }
    }
});

test("the UI bound and the server bound are the same constant", () => {
    // Two copies of this number is how a note the form accepts becomes one the
    // action rejects. The constant lives in the client-safe marker module for
    // exactly this reason.
    const markers = readFileSync(path.join(ROOT, "src/lib/qbo-create-markers.ts"), "utf8");
    assert.match(markers, /export const RESOLVE_REASON_MAX_LEN = \d+;/, "the bound is declared client-side");

    const resolver = readFileSync(path.join(ROOT, "src/lib/qbo-ambiguous-create.ts"), "utf8");
    assert.ok(
        !/const RESOLVE_REASON_MAX_LEN\s*=/.test(resolver),
        "the server must not declare a second copy of the bound",
    );

    const editor = readFileSync(
        path.join(ROOT, "src/app/projects/[id]/invoices/[invoiceId]/InvoiceEditor.tsx"),
        "utf8",
    );
    assert.ok(
        editor.includes("RESOLVE_REASON_MAX_LEN"),
        "the form checks the same bound it will be judged against",
    );
});
