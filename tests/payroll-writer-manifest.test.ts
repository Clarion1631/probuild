/**
 * EVERY TimeEntry writer in src/ is accounted for.
 *
 * This replaces the regex allowlist of "approved routes" that used to live in
 * tests/payroll-period-lock.test.ts. That allowlist only ever described the
 * writers somebody had remembered to add — a NEW writer, or one nobody thought
 * of (the logistics re-code, the review reprice, the change-order retag), was
 * invisible to it, which is exactly how four of them stayed unguarded.
 *
 * The manifest is the inversion: it enumerates the call sites that EXIST, and
 * the test fails when the set changes. A new writer cannot be added silently —
 * it has to be classified here, as guarded or as a documented exemption.
 *
 * What this proves: no TimeEntry write escapes review. Two things it does NOT
 * prove, stated plainly rather than implied:
 *
 *  - that a "guarded" entry really holds the locks at runtime. The behavioural
 *    tests in tests/payroll-period-lock.test.ts are what show that.
 *  - that each individual call site is guarded. Keys are file + method, so a
 *    file with two `updateMany` writers collapses to one entry and the reason
 *    has to cover both. Adding a THIRD `updateMany` to such a file would not
 *    trip this test — only a new file, or a new method in an existing one,
 *    does. Closing that would need real AST work; the gap is recorded here
 *    instead of being papered over.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const SRC = path.join(__dirname, "..", "src");

/** `file::matched-call` for every TimeEntry mutation in src/. */
function findWriters(): string[] {
    const found: string[] = [];
    // ANY receiver. A wrapped writer reads
    // `(tx as unknown as typeof prisma).timeEntry.updateMany`, so a
    // receiver-anchored pattern silently stopped seeing exactly the call sites
    // that had just been guarded — the scanner would have gone quiet as the
    // code got safer, which is the worst possible failure mode for a tripwire.
    const pattern = /\.timeEntry\.(create|createMany|update|updateMany|delete|deleteMany|upsert)\b/g;

    const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
            const full = path.join(dir, name);
            if (statSync(full).isDirectory()) {
                walk(full);
                continue;
            }
            if (!/\.(ts|tsx)$/.test(name)) continue;
            const source = readFileSync(full, "utf8");
            const rel = path.relative(SRC, full).split(path.sep).join("/");
            for (const match of source.matchAll(pattern)) {
                found.push(`${rel}::${match[1]}`);
            }
        }
    };
    walk(SRC);
    return found.sort();
}

/**
 * Every writer, and why it is safe.
 *
 * "guarded"  — runs inside withPayrollWrite / withPayrollWriteTx, or inside the
 *              settlement + delete protocol, which takes the same locks in the
 *              same order (src/lib/payroll-period.ts).
 * "exempt"   — cannot move payroll hours, with the reason stated. Exemptions are
 *              deliberately few and each one is an argument, not a shrug.
 */
const MANIFEST: Record<string, { kind: "guarded" | "exempt"; why: string }> = {
    // ---- the payroll write paths -------------------------------------------
    "app/api/time-entries/route.ts::create": {
        kind: "guarded",
        why: "clock-in create, wrapped in withPayrollWriteTx (startTime is client-supplied, so it can aim at a locked period)",
    },
    "app/api/time-entries/route.ts::updateMany": {
        kind: "guarded",
        why: "the stale-DEFERRED review flag (withPayrollWrite) and the clock-out claim (inside closeTimeEntry's locked transaction)",
    },
    "app/api/time-entries/route.ts::update": {
        kind: "guarded",
        why: "settlement-failure flag, written inside the same locked transaction as the close it belongs to",
    },
    "app/api/time-entries/[id]/route.ts::updateMany": {
        kind: "guarded",
        why: "the PATCH edit claim, inside withPayrollWriteTx with a compare-and-set on updatedAt",
    },
    "app/api/time-entries/[id]/route.ts::update": {
        kind: "guarded",
        why: "two call sites: the settlement-failure flag inside the edit transaction, and the geofence telemetry branch, which refuses to run in the same request as an edit and touches no hours, cost or readiness flag",
    },
    "app/api/time-entries/[id]/meal-skip/route.ts::updateMany": {
        kind: "guarded",
        why: "skip request and decision, both wrapped in withPayrollWrite — each changes what the day's settlement owes",
    },
    "app/api/time-entries/[id]/logistics/route.ts::updateMany": {
        kind: "guarded",
        why: "voice-dump formalize and re-code, wrapped in withPayrollWrite — project and cost code are DETAIL csv inputs",
    },

    // ---- server actions -----------------------------------------------------
    "lib/actions.ts::updateMany": {
        kind: "guarded",
        why: "the meal-skip decision and logistics routing are both wrapped in withPayrollWrite; the third site is the billing invoice claim, which stamps invoiceId/invoicedAt only and is covered by lib/billing-core.ts's reasoning",
    },
    "lib/time-expense-core.ts::create": {
        kind: "guarded",
        why: "createTimeEntryCore, wrapped in withPayrollWriteTx — the canonical manual create every server action funnels through",
    },
    "lib/time-expense-core.ts::updateMany": {
        kind: "guarded",
        why: "tagTimeEntriesToChangeOrder, wrapped in withPayrollWrite — retagging changes which change order the hours bill against",
    },
    "lib/time-expense-actions.ts::updateMany": {
        kind: "guarded",
        why: "the manual edit, wrapped in withPayrollWriteTx with the row re-read under FOR UPDATE",
    },
    "lib/time-expense-actions.ts::deleteMany": {
        kind: "guarded",
        why: "single and bulk delete, both wrapped in withPayrollWriteTx over every affected row id",
    },
    "app/projects/[id]/timeclock/actions.ts::create": {
        kind: "guarded",
        why: "project manual create, wrapped in withPayrollWriteTx, priced from stored rates",
    },
    "app/projects/[id]/timeclock/actions.ts::updateMany": {
        kind: "guarded",
        why: "project manual edit, wrapped in withPayrollWriteTx; updateMany rather than update so the billing columns are part of the compare-and-set",
    },
    "app/projects/[id]/timeclock/actions.ts::deleteMany": {
        kind: "guarded",
        why: "project manual delete, wrapped in withPayrollWriteTx; deleteMany so invoiceId/invoicedAt are in the WHERE and a row billed mid-delete is detected",
    },
    "lib/payroll-parent-delete.ts::deleteMany": {
        kind: "guarded",
        why: "deleting a User's or Project's hours before the parent row, wrapped in withPayrollWriteTx over every affected entry id and qualified day key — the FK used to CASCADE and destroy locked payroll history silently",
    },

    // ---- the settlement protocol -------------------------------------------
    "lib/wa-breaks-db.ts::update": {
        kind: "guarded",
        why: "settleDayInTx's re-plan (payroll lock taken before the day lock by every caller) plus flagSettlementFailed, which only ever ADDS a review flag — that blocks the export rather than letting bad numbers through, and it must still run when the surrounding transaction has rolled back",
    },
    "lib/wa-breaks-db.ts::delete": {
        kind: "guarded",
        why: "deleteEntryAndSettle, whose guard hook runs the payroll assertion before anything is removed",
    },

    // ---- billing ------------------------------------------------------------
    "lib/billing-core.ts::updateMany": {
        kind: "exempt",
        why: "the invoice claim: stamps invoiceId/invoicedAt inside the billing transaction. It changes no hours, no cost and no readiness flag, and every payroll writer already refuses an entry once it is billed",
    },
};

test("every TimeEntry writer in src/ is classified", () => {
    const actual = [...new Set(findWriters())];
    const known = new Set(Object.keys(MANIFEST));

    const unclassified = actual.filter((entry) => !known.has(entry));
    assert.deepEqual(
        unclassified,
        [],
        "A TimeEntry writer exists that nobody has classified. Route it through " +
            "withPayrollWrite(), or add it to MANIFEST as an exemption WITH A REASON. " +
            "This is the check that catches a writer nobody thought of."
    );

    // The manifest must not rot either: an entry for a call site that no longer
    // exists is a claim about code that is gone.
    const stale = [...known].filter((entry) => !actual.includes(entry));
    assert.deepEqual(stale, [], "MANIFEST lists writers that no longer exist — delete them.");
});

test("every exemption states a reason, and guarded files import the helper", () => {
    for (const [site, entry] of Object.entries(MANIFEST)) {
        assert.ok(entry.why.length > 30, `${site}: an exemption needs a real reason, not a shrug`);
    }

    // A file claiming "guarded" has to actually reference the protocol. Weak on
    // its own — the behavioural tests are the real proof — but it catches a
    // wrapper being deleted while the manifest still claims it is there.
    const guardedFiles = new Set(
        Object.entries(MANIFEST)
            .filter(([, entry]) => entry.kind === "guarded")
            .map(([site]) => site.split("::")[0])
    );
    for (const file of guardedFiles) {
        const source = readFileSync(path.join(SRC, ...file.split("/")), "utf8");
        assert.match(
            source,
            /withPayrollWrite|assertEntriesUnlockedInTx|assertDayUnlockedInTx|settleDayInTx|deleteEntryAndSettle/,
            `${file} claims a guarded writer but never references the payroll write protocol`
        );
    }
});
