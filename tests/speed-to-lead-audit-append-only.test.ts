/**
 * The migration comment on #557's precursor claimed a static append-only
 * test that never actually existed. This is the real one: a grep-based
 * proof that no caller anywhere in `src/` mutates `speedToLeadEvent` once
 * written — `audit.ts:logLeadEvent` only ever `.create()`s.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function collectFiles(entryPath: string): string[] {
    const full = path.join(root, entryPath);
    const out: string[] = [];
    for (const entry of readdirSync(full, { withFileTypes: true })) {
        const childRel = path.join(entryPath, entry.name);
        const childFull = path.join(root, childRel);
        if (entry.isDirectory()) out.push(...collectFiles(childRel));
        else if (/\.(ts|tsx)$/.test(entry.name)) out.push(childFull);
    }
    return out;
}

test("no .update/.delete/.upsert on speedToLeadEvent anywhere in src/", () => {
    const offenders: string[] = [];
    const mutators = [/speedToLeadEvent\.update\(/, /speedToLeadEvent\.delete\(/, /speedToLeadEvent\.upsert\(/, /speedToLeadEvent\.updateMany\(/, /speedToLeadEvent\.deleteMany\(/];
    for (const file of collectFiles("src")) {
        const text = readFileSync(file, "utf8");
        for (const pattern of mutators) {
            if (pattern.test(text)) offenders.push(`${path.relative(root, file)} matches ${pattern}`);
        }
    }
    assert.deepEqual(offenders, []);
});

test("logLeadEvent itself only ever calls .create()", () => {
    const text = readFileSync(path.join(root, "src/lib/speed-to-lead/audit.ts"), "utf8");
    assert.match(text, /speedToLeadEvent\.create\(/);
    assert.doesNotMatch(text, /speedToLeadEvent\.(update|delete|upsert)/);
});
