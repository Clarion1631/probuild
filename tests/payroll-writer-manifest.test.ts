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
 * KEYED BY FILE + LINE + METHOD, not file + method. A file+method key
 * collapses every call to e.g. `updateMany` in one file into ONE entry, whose
 * "guarded" claim then has to be true of ALL of them or it is a lie about at
 * least one. That is exactly how the geofence-telemetry PATCH branch in
 * `app/api/time-entries/[id]/route.ts` stayed unguarded: its raw
 * `prisma.timeEntry.updateMany` shared a method name with the properly-guarded
 * edit-claim `updateMany` a few hundred lines below it, the file+method key
 * collapsed them into one "guarded" entry, and the reason text for a
 * DIFFERENT key (`::update`) even described the telemetry branch by name —
 * misattributing it to a method it does not call. Line numbers make that
 * collapse impossible: each call site gets its own entry, and a description
 * can only be true of the one line it is written against.
 *
 * What this proves: no TimeEntry write escapes review. Two things it does NOT
 * prove, stated plainly rather than implied:
 *
 *  - that a "guarded" entry really holds the locks at runtime. The behavioural
 *    tests in tests/payroll-period-lock.test.ts are what show that.
 *  - that line numbers are stable. Any edit above a call site shifts every
 *    line number below it, so this file WILL need updating on unrelated
 *    changes — that churn is the deliberate cost of a key that cannot lie by
 *    collapsing two call sites into one.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const SRC = path.join(__dirname, "..", "src");

/** `file:line::matched-call` for every TimeEntry mutation in src/. */
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
                const line = source.slice(0, match.index).split("\n").length;
                found.push(`${rel}:${line}::${match[1]}`);
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
    "app/api/time-entries/route.ts:320::create": {
        kind: "guarded",
        why: "clock-in create, wrapped in withPayrollWriteTx (startTime is client-supplied, so it can aim at a locked period)",
    },
    "app/api/time-entries/route.ts:150::updateMany": {
        kind: "guarded",
        why: "the stale-DEFERRED review flag, wrapped in withPayrollWrite — it sets needsReview, which gates the export",
    },
    "app/api/time-entries/route.ts:1052::updateMany": {
        kind: "guarded",
        why: "the clock-out claim, inside closeTimeEntry's locked transaction with a compare-and-set on startTime AND on updatedAt, so any concurrent write to the row the close was decided from fails it closed",
    },
    "app/api/time-entries/route.ts:1077::update": {
        kind: "guarded",
        why: "settlement-failure flag, written inside the same locked transaction as the close it belongs to",
    },
    "app/api/time-entries/[id]/route.ts:176::updateMany": {
        kind: "guarded",
        why: "the geofence telemetry branch — offsiteMs/isOffsite/lastLocationCheck touch no hours, cost or readiness flag, but it is still routed through withPayrollWriteTx (entryIds: [id]) so it cannot become a hole later without someone deliberately removing the wrapper",
    },
    "app/api/time-entries/[id]/route.ts:599::updateMany": {
        kind: "guarded",
        why: "the PATCH edit claim, inside withPayrollWriteTx with a compare-and-set on updatedAt",
    },
    "app/api/time-entries/[id]/route.ts:619::update": {
        kind: "guarded",
        why: "the settlement-failure flag, written inside the same locked edit transaction",
    },
    "app/api/time-entries/[id]/meal-skip/route.ts:86::updateMany": {
        kind: "guarded",
        why: "the skip REQUEST, wrapped in withPayrollWrite — it sets mealSkipStatus, which changes what the day's settlement owes",
    },
    "app/api/time-entries/[id]/meal-skip/route.ts:157::updateMany": {
        kind: "guarded",
        why: "the skip DECISION (approve/deny), wrapped in withPayrollWrite for the same reason as the request above",
    },
    "app/api/time-entries/[id]/logistics/route.ts:159::updateMany": {
        kind: "guarded",
        why: "voice-dump formalize and re-code, wrapped in withPayrollWrite — project and cost code are DETAIL csv inputs. Routing refuses a change-order-tagged entry and pins changeOrderId: null in the WHERE, so the tag cannot be left pointing at a job the entry has left",
    },

    // ---- server actions -----------------------------------------------------
    "lib/actions.ts:3634::updateMany": {
        kind: "exempt",
        why: "createInvoiceFromTimeEntries's claim: stamps invoiceId/invoicedAt only inside the invoice-creation transaction. Same reasoning as lib/billing-core.ts's exemption below — it changes no hours, no cost and no readiness flag, and every payroll writer already refuses an entry once it is billed",
    },
    "lib/actions.ts:15012::updateMany": {
        kind: "guarded",
        why: "markTimeEntryReviewed's reprice-and-stamp claim, wrapped in withPayrollWrite with a compare-and-set on updatedAt",
    },
    "lib/actions.ts:15200::updateMany": {
        kind: "guarded",
        why: "the meal-skip decision, wrapped in withPayrollWrite — it changes what the day's settlement owes",
    },
    "lib/actions.ts:15274::updateMany": {
        kind: "guarded",
        why: "logistics routing: restoring an entry to its prior project, wrapped in withPayrollWrite — project and cost code are DETAIL csv inputs",
    },
    "lib/actions.ts:15287::updateMany": {
        kind: "guarded",
        why: "logistics routing: routing an entry to a new project, wrapped in withPayrollWrite for the same reason as the restore above",
    },
    "lib/time-expense-core.ts:186::create": {
        kind: "guarded",
        why: "createTimeEntryCore, wrapped in withPayrollWriteTx — the canonical manual create every server action funnels through",
    },
    "lib/time-expense-core.ts:350::updateMany": {
        kind: "guarded",
        why: "tagTimeEntriesToChangeOrder, wrapped in withPayrollWrite — retagging changes which change order the hours bill against. The change order and the rows are re-read INSIDE the lock and projectId is pinned in the WHERE, so an entry rerouted to another job between the pre-check and the write cannot pick up this project's change order",
    },
    "lib/time-expense-actions.ts:180::updateMany": {
        kind: "guarded",
        why: "the manual edit, wrapped in withPayrollWriteTx with the row re-read under FOR UPDATE",
    },
    "lib/time-expense-actions.ts:225::deleteMany": {
        kind: "guarded",
        why: "deleteTimeEntry (single delete), wrapped in withPayrollWriteTx over the one affected row id",
    },
    "lib/time-expense-actions.ts:278::deleteMany": {
        kind: "guarded",
        why: "deleteTimeEntries (bulk delete), wrapped in withPayrollWriteTx over every affected row id",
    },
    "app/projects/[id]/timeclock/actions.ts:110::create": {
        kind: "guarded",
        why: "project manual create, wrapped in withPayrollWriteTx, priced from stored rates",
    },
    "app/projects/[id]/timeclock/actions.ts:190::updateMany": {
        kind: "guarded",
        why: "project manual edit, wrapped in withPayrollWriteTx; updateMany rather than update so the billing columns are part of the compare-and-set",
    },
    "app/projects/[id]/timeclock/actions.ts:222::deleteMany": {
        kind: "guarded",
        why: "project manual delete, wrapped in withPayrollWriteTx; deleteMany so invoiceId/invoicedAt are in the WHERE and a row billed mid-delete is detected",
    },
    // lib/payroll-parent-delete.ts is deliberately absent here: it no longer
    // performs a .timeEntry write at all. It counts entries for a parent and
    // REFUSES the delete if the count is nonzero (locked or not) — see that
    // file's header. A stale entry here would be a claim about code that no
    // longer runs.

    // ---- the settlement protocol -------------------------------------------
    "lib/wa-breaks-db.ts:320::update": {
        kind: "guarded",
        why: "settleDayInTx's re-plan of one entry's shift/meal/cost fields, run inside the caller's already-locked payroll transaction (every caller takes the payroll lock before the day lock)",
    },
    "lib/wa-breaks-db.ts:393::delete": {
        kind: "guarded",
        why: "deleteEntryAndSettle, whose guard hook runs the payroll assertion before anything is removed",
    },
    "lib/wa-breaks-db.ts:426::update": {
        kind: "exempt",
        why: "flagSettlementFailed's already-flagged branch: only ADDS needsReview, which blocks the export rather than letting bad numbers through. Deliberately outside the payroll lock — it must still run when the surrounding settlement transaction has rolled back, which is precisely the failure it exists to flag",
    },
    "lib/wa-breaks-db.ts:429::update": {
        kind: "exempt",
        why: "flagSettlementFailed's first-flag branch — same reasoning as the already-flagged branch above: best-effort, ADDS-only, and must survive the surrounding transaction rolling back",
    },

    // ---- billing ------------------------------------------------------------
    "lib/billing-core.ts:1370::updateMany": {
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
    // exists (or whose line number moved because of an edit above it) is a
    // claim about code that isn't there.
    const stale = [...known].filter((entry) => !actual.includes(entry));
    assert.deepEqual(
        stale,
        [],
        "MANIFEST lists writers that no longer exist at that file:line — delete them, or " +
            "update the line number if the call site just moved."
    );
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
            .map(([site]) => {
                // "file/path.ts:123::method" -> "file/path.ts". Split on "::"
                // first (method), then drop the trailing ":<line>" — paths
                // never contain a colon themselves, so the LAST one is it.
                const [relLine] = site.split("::");
                return relLine.slice(0, relLine.lastIndexOf(":"));
            })
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
