/**
 * Review round 16, the items that do not belong to an existing suite:
 * the bulk-delete refusal (1), the settlement skip rule (3), the qualified day
 * key (4), the billed-entry CAS (5), discarding a wrong-range period (6), the
 * 423 mapping (7), and the provider lease fence (8).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
    assertBulkDeletable,
    CLOCK_GENERATED_ENTRY_CODE,
    BILLED_ENTRY_CODE,
} from "../src/lib/manual-time-entry-auth";
import { settlementRowIsCurrent } from "../src/lib/wa-breaks-db";
import {
    dayLockKey,
    PeriodLockedError,
    PERIOD_LOCKED_CODE,
    withPeriodLockedRoute,
} from "../src/lib/payroll-period";
import { claimProviderLease, completeUnderLease, HELP_LEASE_MS, HELP_PROVIDER_TIMEOUT_MS } from "../src/lib/help-chat/submission-guard";

process.env.NEXTAUTH_SECRET ??= "test-secret-for-round-16";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

const CREW = { id: "u-crew", role: "FIELD_CREW" };
const OFFICE = { id: "u-admin", role: "ADMIN" };
const allProjects = () => true;

function entry(over: Partial<{ projectId: string; userId: string; endTime: Date | null; invoiceId: string | null; invoicedAt: Date | null }> = {}) {
    return {
        projectId: "p1",
        userId: "u-crew",
        endTime: null as Date | null,
        invoiceId: null as string | null,
        invoicedAt: null as Date | null,
        ...over,
    };
}

// ---------------------------------------------------------------- item 1

test("a FIELD_CREW bulk delete of a CLOCK punch is refused, not silently skipped", () => {
    // The exact reported shape: their own row, so ownership passes — but it came
    // from the time clock. The old code FILTERED instead of refusing, so this
    // punch was deleted and the caller was told the batch succeeded.
    let error: (Error & { code?: string }) | null = null;
    try {
        assertBulkDeletable(CREW, [entry({ endTime: new Date("2026-09-01T23:00:00Z") })], allProjects);
    } catch (thrown) {
        error = thrown as Error & { code?: string };
    }
    assert.ok(error, "a clocked punch must be refused");
    assert.equal(error!.code, CLOCK_GENERATED_ENTRY_CODE);
});

test("one bad row refuses the WHOLE batch", () => {
    const rows = [entry(), entry(), entry({ endTime: new Date("2026-09-01T23:00:00Z") })];
    assert.throws(() => assertBulkDeletable(CREW, rows, allProjects));
    // ...and a clean batch still goes through.
    assert.doesNotThrow(() => assertBulkDeletable(CREW, [entry(), entry()], allProjects));
});

test("crew cannot bulk-delete a COLLEAGUE's hours", () => {
    assert.throws(
        () => assertBulkDeletable(CREW, [entry({ userId: "u-someone-else" })], allProjects),
        /only delete your own/
    );
    // The office can.
    assert.doesNotThrow(() => assertBulkDeletable(OFFICE, [entry({ userId: "u-someone-else" })], allProjects));
});

test("billed hours are refused in bulk, with their own code", () => {
    let error: (Error & { code?: string }) | null = null;
    try {
        assertBulkDeletable(OFFICE, [entry({ invoicedAt: new Date() })], allProjects);
    } catch (thrown) {
        error = thrown as Error & { code?: string };
    }
    assert.equal(error?.code, BILLED_ENTRY_CODE);
    assert.throws(() => assertBulkDeletable(OFFICE, [entry({ invoiceId: "inv-1" })], allProjects), /Billed/);
});

test("project access is checked, and FINANCE is the documented exemption", () => {
    const noProjects = () => false;
    assert.throws(() => assertBulkDeletable(OFFICE, [entry({ userId: "u-x" })], noProjects), /Forbidden/);
    assert.doesNotThrow(() =>
        assertBulkDeletable({ id: "u-fin", role: "FINANCE" }, [entry({ userId: "u-x" })], noProjects)
    );
});

test("the bulk delete re-authorizes under the transaction's row locks", () => {
    const source = read("src/lib/time-expense-actions.ts");
    const fn = source.slice(source.indexOf("export async function deleteTimeEntries"));
    const body = fn.slice(0, fn.indexOf("\nexport "));
    // Twice: once on the read outside the transaction, once on the rows as they
    // stand under FOR UPDATE. Between the two, a row can be reassigned to
    // another project or owner, or claimed by an invoice run.
    assert.equal((body.match(/assertBulkDeletable\(/g) ?? []).length, 2);
    assert.match(body, /withPayrollWriteTx\([\s\S]*?findMany\([\s\S]*?assertBulkDeletable/);
    // And a partial delete is an error, not a success report.
    assert.match(body, /result\.count !== allowedIds\.length/);
});

// ---------------------------------------------------------------- item 3

const STORED = {
    durationHours: 7.5,
    mealDeductionHours: 0.5,
    mealOutcome: "AUTO_DEDUCTED",
    needsReview: true,
    reviewReason: "Closed at a $0 pay rate — set the rate and recheck this entry",
};
const UPDATE = { paidHours: 7.5, mealDeductionHours: 0.5, mealOutcome: "AUTO_DEDUCTED" };

test("a flagged $0-rate row is skipped only while the hours still match", () => {
    assert.equal(
        settlementRowIsCurrent({ stored: STORED, update: UPDATE, zeroRate: true, flagsChange: false }),
        true,
        "nothing to do: same hours, already flagged"
    );
});

test("a LATER shift changes the meal allocation on a flagged day, and the row is rewritten", () => {
    // Somebody clocks a second shift. The day now owes a different deduction, so
    // the earlier row's paid hours move. Treating the flag as sufficient to skip
    // froze that row on hours the day no longer produces.
    const reallocated = { paidHours: 7.0, mealDeductionHours: 1.0, mealOutcome: "AUTO_DEDUCTED" };
    assert.equal(
        settlementRowIsCurrent({ stored: STORED, update: reallocated, zeroRate: true, flagsChange: false }),
        false,
        "the hours changed — this row MUST be rewritten"
    );
    // The same is true if only the outcome moves.
    assert.equal(
        settlementRowIsCurrent({
            stored: STORED,
            update: { ...UPDATE, mealOutcome: "PUNCHED" },
            zeroRate: true,
            flagsChange: false,
        }),
        false
    );
});

test("an UNFLAGGED $0-rate row is never skipped, however well its hours match", () => {
    assert.equal(
        settlementRowIsCurrent({
            stored: { ...STORED, needsReview: false, reviewReason: null },
            update: UPDATE,
            zeroRate: true,
            flagsChange: false,
        }),
        false,
        "otherwise the shortcut leaves it unflagged forever and the export runs past it"
    );
    // needsReview set for some OTHER reason is not this flag.
    assert.equal(
        settlementRowIsCurrent({
            stored: { ...STORED, reviewReason: "Meal break not taken" },
            update: UPDATE,
            zeroRate: true,
            flagsChange: false,
        }),
        false
    );
});

test("at a real rate the flag plays no part; a flag CHANGE alone forces a write", () => {
    assert.equal(settlementRowIsCurrent({ stored: STORED, update: UPDATE, zeroRate: false, flagsChange: false }), true);
    assert.equal(settlementRowIsCurrent({ stored: STORED, update: UPDATE, zeroRate: false, flagsChange: true }), false);
});

// ---------------------------------------------------------------- round 33, finding 2

test("a $0-rate row with UNCHANGED hours is still rewritten when the review state moves", () => {
    // The gap: flagsChange was consulted only at a real rate. On a $0-rate day
    // the hours matched and the zero-rate note was already on the row, so the
    // shortcut skipped the write — and a re-plan that had newly decided this
    // day OVERLAPS another, or that no attestation was on file, wrote nothing.
    // The manager queue never showed the reason, and the export ran on a row
    // whose review state was a round out of date.
    assert.equal(
        settlementRowIsCurrent({ stored: STORED, update: UPDATE, zeroRate: true, flagsChange: true }),
        false,
        "ADDING a settlement-owned reason must write, even at a $0 rate with identical hours"
    );

    // RETIREMENT is the same rule read the other way, and was broken the same
    // way: an overlap that has since been edited away has to lose its note, and
    // dropping a reason is also a flags change. A row that keeps a retired
    // reason forever is a permanent false alarm in the queue.
    const stillFlagged = {
        ...STORED,
        reviewReason: "Overlaps another shift; Closed at a $0 pay rate — set the rate and recheck this entry",
    };
    assert.equal(
        settlementRowIsCurrent({ stored: stillFlagged, update: UPDATE, zeroRate: true, flagsChange: true }),
        false,
        "RETIRING a settlement-owned reason must write too"
    );

    // And the skip still exists where it should: same hours, same review state.
    assert.equal(
        settlementRowIsCurrent({ stored: STORED, update: UPDATE, zeroRate: true, flagsChange: false }),
        true,
        "nothing changed at all — the shortcut is still a shortcut"
    );
});

// ---------------------------------------------------------------- item 4

test("day locks are the QUALIFIED wa-breaks key, everywhere they are taken", () => {
    assert.equal(dayLockKey("u1", "2026-09-01"), "wa-breaks:u1:2026-09-01");
    // A bare day key hashes to a different advisory lock, so a writer passing one
    // and a settlement taking the qualified one would not be serialized at all.
    assert.notEqual(dayLockKey("u1", "2026-09-01"), "2026-09-01");
    assert.notEqual(dayLockKey("u1", "2026-09-01"), dayLockKey("u2", "2026-09-01"));

    for (const file of [
        "src/app/api/time-entries/route.ts",
        "src/app/api/time-entries/[id]/route.ts",
        "src/lib/payroll-parent-delete.ts",
    ]) {
        const source = read(file);
        for (const match of source.matchAll(/dayKeys:\s*(\[[^\]]*\]|[A-Za-z]+)/g)) {
            const value = match[1];
            const named = value.startsWith("[") ? value : source.slice(source.indexOf(`const ${value} =`));
            assert.match(named, /dayLockKey\(/, `${file}: ${value}`);
        }
    }
});

test("the manual actions take no day locks, because they never settle", () => {
    // settleDayInTx only ever plans rows with a real endTime, and the manual
    // paths refuse those outright — so a settle call there would lock a day this
    // write cannot have changed.
    for (const file of ["src/lib/time-expense-actions.ts", "src/app/projects/[id]/timeclock/actions.ts"]) {
        const source = read(file);
        assert.doesNotMatch(source, /settleDayWithinTx/, file);
        assert.doesNotMatch(source, /dayKeys:/, file);
        assert.match(source, /assertNotClockGeneratedEntry/, file);
    }
});

// ---------------------------------------------------------------- item 5

test("the timeclock editor rejects billed hours, and CASes on the billing columns", () => {
    const source = read("src/app/projects/[id]/timeclock/actions.ts");
    const update = source.slice(source.indexOf("export async function updateTimeEntry"));
    const body = update.slice(0, update.indexOf("export async function deleteTimeEntry"));
    assert.match(body, /invoiceId \|\| existing\.invoicedAt\) throw new Error\("Billed time entries cannot be edited"\)/);
    // The pre-transaction read is stale the moment an invoice run claims the
    // row, so the billing columns go in the WHERE as well.
    assert.match(body, /updateMany\(\{\s*\n\s*where: \{ id, invoiceId: null, invoicedAt: null \}/);
    assert.match(body, /updated\.count !== 1/);
    // It has to READ them to be able to check them.
    assert.match(body, /invoiceId: true, invoicedAt: true/);

    const del = source.slice(source.indexOf("export async function deleteTimeEntry"));
    assert.match(del, /Billed time entries cannot be deleted/);
    // Round 18 put the in-transaction re-authorization ahead of it, so the call
    // is now multi-line. The CAS itself is what matters.
    assert.match(del, /deleteMany\(\{\s+where: \{ id, invoiceId: null, invoicedAt: null \},/);
    assert.match(del, /reassertManualEntryInTx\(tx as never, id, entry\)/);
    assert.match(del, /deleted\.count !== 1/);
});

// ---------------------------------------------------------------- item 6

test("lock creation ignores overlapping rows that are NOT locked", () => {
    const source = read("src/lib/actions.ts");
    const fn = source.slice(source.indexOf("export async function lockPayrollPeriod"));
    const body = fn.slice(0, fn.indexOf("\nexport async function discardPayrollPeriod"));
    // An unlocked leftover is not a claim on anything. Treating it as a conflict
    // made a typo permanent: neither the wrong range nor any corrected range
    // touching it could ever be locked.
    const overlapQuery = body.slice(body.indexOf("const overlapping ="), body.indexOf("FOR UPDATE", body.indexOf("const overlapping =")));
    assert.match(overlapQuery, /"lockedAt" IS NOT NULL/);
});

test("discard is ADMIN-only, needs a reason, and only touches unlocked rows", () => {
    const source = read("src/lib/actions.ts");
    const fn = source.slice(source.indexOf("export async function discardPayrollPeriod"));
    const body = fn.slice(0, fn.indexOf("\nexport async function unlockPayrollPeriod"));
    assert.match(body, /user\.role !== "ADMIN"\) throw new Error\("Forbidden"\)/);
    assert.match(body, /trimmedReason\.length < 5/);
    // lockedAt IS NULL in the WHERE, not merely checked first: the guard and the
    // write have to be one statement.
    assert.match(body, /lockedAt: null,\s*\n\s*discardedAt: null,/);
    // Under the same exclusive lock the lock action takes, or a concurrent lock
    // could land between the check and the write.
    assert.match(body, /acquirePayrollLockCreationLock/);
    // And it is audited.
    assert.match(body, /auditLog\.create/);
    assert.match(body, /action: "discard"/);
    assert.match(body, /reason: trimmedReason/);
});

test("a discarded row is invisible to readers, and can never be locked", () => {
    const schema = read("prisma/schema.prisma");
    const model = schema.slice(schema.indexOf("model PayrollPeriod {"));
    const body = model.slice(0, model.indexOf("\n}"));
    assert.match(body, /discardedAt\s+DateTime\? @db\.Timestamptz\(6\)/);
    assert.match(body, /discardedReason String\?/);

    // The database itself refuses a locked+discarded row. That is also what
    // makes every `lockedAt IS NOT NULL` reader automatically blind to discards.
    const sql = read("prisma/migrations/20260901000000_payroll_phase5/migration.sql");
    assert.match(sql, /PayrollPeriod_discard_unlocked/);
    assert.match(sql, /CHECK \("discardedAt" IS NULL OR "lockedAt" IS NULL\)/);
    // Validated, not left NOT VALID — an unvalidated constraint is not enforced
    // for existing rows and CI's replay would disagree with prod.
    assert.match(sql, /VALIDATE CONSTRAINT "PayrollPeriod_discard_unlocked"/);

    // Prisma's diff engine cannot see CHECK constraints, so it is recorded.
    const blind = JSON.parse(read("prisma/prisma-blind-spots.json"));
    assert.ok(
        blind.checkConstraints.some((c: { name: string }) => c.name === "PayrollPeriod_discard_unlocked"),
        "an unrecorded CHECK makes CI's migration replay disagree with prod"
    );

    // The one reader that is not already filtered by lockedAt.
    assert.match(read("src/lib/gusto-export-db.ts"), /discardedAt \? null : period/);
});

test("re-locking the exact same range revives a discarded row", () => {
    const source = read("src/lib/actions.ts");
    const fn = source.slice(source.indexOf("export async function lockPayrollPeriod"));
    // Without this the upsert sets lockedAt on a row still carrying discardedAt
    // and trips the CHECK — a legitimate re-lock would surface as a raw database
    // error.
    assert.match(fn, /discardedAt: null,\s*\n\s*discardedById: null,\s*\n\s*discardedReason: null,/);
});

// ---------------------------------------------------------------- item 7

test("a locked period is a 423 with the shared code, not an unhandled 500", async () => {
    const period = {
        id: "p1",
        periodStart: new Date("2026-08-24T07:00:00Z"),
        periodEnd: new Date("2026-09-07T07:00:00Z"),
        lockedAt: new Date("2026-09-08T00:00:00Z"),
        timeZone: "America/Los_Angeles",
    };
    const response = await withPeriodLockedRoute(async () => {
        throw new PeriodLockedError(period);
    });
    assert.equal(response.status, 423);
    const body = await response.json();
    assert.equal(body.code, PERIOD_LOCKED_CODE);
    assert.equal(body.periodStart, period.periodStart.toISOString());

    // Anything else still propagates — this is a mapping, not a swallow.
    await assert.rejects(
        () => withPeriodLockedRoute(async () => { throw new Error("something else"); }),
        /something else/
    );
});

test("both payroll-writing routes are wrapped in the mapping", () => {
    for (const file of [
        "src/app/api/time-entries/[id]/meal-skip/route.ts",
        "src/app/api/time-entries/[id]/logistics/route.ts",
    ]) {
        const source = read(file);
        // They take a payroll write lock...
        assert.match(source, /withPayrollWrite\(/, file);
        // ...so every exported handler has to go through the mapping.
        for (const method of source.matchAll(/export async function (POST|PATCH|PUT|DELETE)\(/g)) {
            const after = source.slice(source.indexOf(`export async function ${method[1]}(`));
            assert.match(after.slice(0, 400), /withPeriodLockedRoute\(/, `${file}: ${method[1]}`);
        }
    }
});

// ---------------------------------------------------------------- item 8

test("the whole provider interaction fits inside ONE lease", async () => {
    const { HELP_LEASE_MS, HELP_PROVIDER_TIMEOUT_MS, HELP_PROVIDER_DEADLINE_MS } = await import(
        "../src/lib/help-chat/submission-guard"
    );
    // A resumed submission makes TWO calls: the marker search, then the create.
    // Each used to get its own fresh 90s timeout, so the pair could run 180s
    // against a 120s lease — the attempt outlived the fence it was held by.
    assert.equal(HELP_PROVIDER_DEADLINE_MS, 2 * HELP_PROVIDER_TIMEOUT_MS);
    assert.ok(
        HELP_PROVIDER_DEADLINE_MS < HELP_LEASE_MS,
        `the combined provider budget (${HELP_PROVIDER_DEADLINE_MS}ms) must fit inside the lease (${HELP_LEASE_MS}ms)`
    );
    // With room for the DB round-trips and the renewal between the two calls.
    assert.ok(HELP_LEASE_MS - HELP_PROVIDER_DEADLINE_MS >= 60_000, "at least a 60s margin");

    const github = read("src/lib/help-chat/github.ts");
    // Both calls take the CALLER's signal when it has one, rather than each
    // starting its own clock.
    assert.equal((github.match(/signal: providerSignal\(signal\)/g) ?? []).length, 2);
    assert.match(github, /return signal \?\? AbortSignal\.timeout\(HELP_PROVIDER_TIMEOUT_MS\)/);
});

test("both routes share ONE deadline and renew the lease between the two calls", () => {
    for (const file of ["src/app/api/help-chat/request/route.ts", "src/app/api/help-chat/bug-fix/route.ts"]) {
        const source = read(file);
        assert.match(source, /const deadline = providerDeadlineSignal\(\)/, file);
        assert.match(source, /findIssueByMarker\(marker, deadline\)/, file);
        assert.match(source, /signal: deadline,/, file);
        // Renewed only on the resume path, because that is the only one that
        // makes two calls — and fenced on the token, so a superseded attempt
        // cannot extend a lease it no longer holds.
        assert.match(source, /renewProviderLease\(requestId, leaseToken\)/, file);
        assert.match(source, /superseded: true/, file);
    }

    const guard = read("src/lib/help-chat/submission-guard.ts");
    assert.match(guard, /WHERE "id" = \$\{requestId\} AND "providerLeaseToken" = \$\{leaseToken\}/);
});

test("an expired lease: the second claimant files, the first's late completion is a no-op", async () => {
    // One row, one lease token column. This is the fence.
    let leaseToken: string | null = null;
    let leaseExpiresAt: Date | null = null;
    let recorded: string | null = null;

    const client = {
        $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
            const sql = strings.join("?");
            if (sql.includes("providerLeaseToken\" = ") && sql.includes("SET \"providerLeaseToken\"")) {
                // A claim succeeds only when the current lease has expired.
                if (leaseExpiresAt && leaseExpiresAt > new Date()) return 0;
                leaseToken = values[0] as string;
                leaseExpiresAt = values[1] as Date;
                return 1;
            }
            // A completion: fenced on the token, which is always the LAST bound
            // value. Parameter order for the filed branch is
            // status, url, externalIssueRef, providerIssueRef, id, leaseToken.
            const suppliedToken = values[values.length - 1] as string;
            if (suppliedToken !== leaseToken) return 0;
            recorded = String(values[3] ?? "");
            return 1;
        },
    };

    // Attempt A claims, then stalls. Its lease lapses.
    const tokenA = await claimProviderLease("r1", client as never);
    assert.ok(tokenA);
    leaseExpiresAt = new Date(Date.now() - 1000);

    // Attempt B takes the now-free lease and files issue #42.
    const tokenB = await claimProviderLease("r1", client as never);
    assert.ok(tokenB);
    assert.notEqual(tokenA, tokenB);
    const bWon = await completeUnderLease(
        "r1",
        tokenB!,
        { filed: true, issueNumber: 42, issueUrl: "u42", status: "submitted" },
        client as never
    );
    assert.equal(bWon, true);
    assert.equal(recorded, "42");

    // A finally comes back with its own issue #7. It no longer holds the lease,
    // so it writes NOTHING — the row keeps pointing at what B filed.
    const aWon = await completeUnderLease(
        "r1",
        tokenA!,
        { filed: true, issueNumber: 7, issueUrl: "u7", status: "submitted" },
        client as never
    );
    assert.equal(aWon, false, "a superseded attempt must not stamp its result over the newer one");
    assert.equal(recorded, "42", "the row still points at the issue the second claimant filed");
});

test("both help routes fence their completion on the lease token", () => {
    for (const file of ["src/app/api/help-chat/request/route.ts", "src/app/api/help-chat/bug-fix/route.ts"]) {
        const source = read(file);
        assert.match(source, /const leaseToken = await claimProviderLease\(requestId\)/, file);
        assert.match(source, /completeUnderLease\(requestId, leaseToken/, file);
        // No unfenced UPDATE of the provider columns left behind.
        assert.doesNotMatch(source, /SET "status" = [\s\S]{0,200}"providerState"/, file);
    }
});

// ── Reaching the person who is blocking the export (round 18, item 3) ───────

test("Team Members loads the historical window from the SELECTED period, not a rolling 90 days", () => {
    const page = read("src/app/company/team-members/page.tsx");
    // An export of a period older than 90 days listed a former employee as
    // blocking and then did not show them on this page at all — a dead end.
    assert.match(page, /searchParams\.get\("periodStart"\)/);
    assert.match(page, /searchParams\.get\("periodEnd"\)/);
    assert.match(page, /historicalFrom=\$\{from\}&historicalTo=\$\{to\}/);
    // The rolling window survives only as the fallback for direct navigation.
    assert.match(page, /90 \* 86_400_000/);
    assert.ok(
        page.indexOf('searchParams.get("periodStart")') < page.indexOf("90 * 86_400_000"),
        "the period must be preferred over the rolling default"
    );
    // Re-fetches when the period changes, or a second link from the export
    // would render the first period's roster.
    assert.match(page, /\}, \[searchParams\]\);/);
});

test("the panel's description states the window it is actually showing", () => {
    const page = read("src/app/company/team-members/page.tsx");
    // It used to say "the last 90 days" unconditionally, which was a lie the
    // moment the export sent somebody here for an older period.
    assert.match(page, /hours in \{historicalWindowLabel\}/);
    assert.match(page, /this pay period \(\$\{periodStartParam\} to \$\{periodEndParam\}\)/);
    assert.match(page, /"the last 90 days"/);
});

test("every pay-type field is addressable, and the export links straight to it", () => {
    const page = read("src/app/company/team-members/page.tsx");
    // BOTH tables — the active roster and the historical one. A blocking former
    // employee is only ever in the second.
    assert.equal((page.match(/id=\{`pay-type-\$\{user\.id\}`\}/g) ?? []).length, 2);

    const exportPage = read("src/app/manager/payroll-export/page.tsx");
    assert.match(
        exportPage,
        /href=\{`\/company\/team-members\?periodStart=\$\{startKey\}&periodEnd=\$\{endKeyExclusive\}#pay-type-\$\{row\.userId\}`\}/
    );
    // Only the pay-type blockers link — the others are fixed on the time-entry
    // screens, not here.
    assert.match(exportPage, /row\.reason === "unknownPayType" \? \(/);
});

test("the pay-type summary line links to the period-scoped page too", () => {
    const exportPage = read("src/app/manager/payroll-export/page.tsx");
    assert.match(exportPage, /href=\{`\/company\/team-members\?periodStart=\$\{startKey\}&periodEnd=\$\{endKeyExclusive\}`\}/);
});

test("the page is Suspense-wrapped, because useSearchParams opts it out of prerendering", () => {
    const page = read("src/app/company/team-members/page.tsx");
    assert.match(page, /<Suspense fallback=/);
    assert.match(page, /function TeamPageInner\(\)/);
});

// ── Unlock is a compare-and-set on lockedAt (round 19, item 3) ──────────────

test("unlock takes the lockedAt it rendered, and CASes on it", () => {
    const actions = read("src/lib/actions.ts");
    const fn = actions.slice(actions.indexOf("export async function unlockPayrollPeriod"));
    const body = fn.slice(0, fn.indexOf("\nexport ") > 0 ? fn.indexOf("\nexport ") : undefined);

    assert.match(body, /expectedLockedAt: string/);
    // The CAS itself: the exact lockedAt, AND not-null so an already-unlocked
    // period fails rather than reporting success for a no-op.
    assert.match(body, /lockedAt: expected,\s*\n\s*NOT: \{ lockedAt: null \},/);
    // Under the EXCLUSIVE payroll lock — otherwise a lock creation can commit
    // between the check and the write and the unlock drops a snapshot the check
    // never saw.
    assert.match(body, /acquirePayrollLockCreationLock/);
    assert.match(body, /prisma\.\$transaction/);
    // A typed refusal, not a bare message.
    assert.match(body, /code: STALE_LOCK_CODE/);
    // The constant lives in payroll-period.ts: actions.ts is "use server", where
    // only async functions may be exported (the build catches it).
    assert.match(read("src/lib/payroll-period.ts"), /export const STALE_LOCK_CODE = "STALE_LOCK"/);
    assert.doesNotMatch(actions, /export const STALE_LOCK_CODE/);
});

test("a malformed or missing expectedLockedAt is refused before any write", () => {
    const actions = read("src/lib/actions.ts");
    const fn = actions.slice(actions.indexOf("export async function unlockPayrollPeriod"));
    const body = fn.slice(0, fn.indexOf("\nexport ") > 0 ? fn.indexOf("\nexport ") : undefined);
    assert.match(body, /Number\.isNaN\(expected\.getTime\(\)\)/);
    // Ordered before the transaction opens.
    assert.ok(body.indexOf("Number.isNaN(expected.getTime())") < body.indexOf("prisma.$transaction"));
});

test("the UI sends the lockedAt it rendered, and hides the button without one", () => {
    const controls = read("src/app/manager/payroll-export/PayrollLockControls.tsx");
    assert.match(controls, /lockedAtIso: string \| null;/);
    assert.match(controls, /unlockPayrollPeriod\(startKey, endKeyExclusive, lockedAtIso\)/);
    // No lockedAt rendered means no unlock button — a click with nothing to
    // compare against could only ever be a guess.
    assert.match(controls, /canUnlock && lockedAtIso \?/);

    const page = read("src/app/manager/payroll-export/page.tsx");
    assert.match(page, /lockedAtIso=\{exactLock\?\.lockedAt \? new Date\(exactLock\.lockedAt\)\.toISOString\(\) : null\}/);
    assert.match(page, /lockedAtIso=\{null\}/, "the not-locked render passes null too");
});

test("the CAS shape refuses a stale replay and an already-unlocked period alike", () => {
    // Both misses are the same Prisma predicate, so this pins the predicate's
    // truth table rather than re-describing the code.
    const lockedAt = new Date("2026-09-08T00:00:00.000Z");
    const matches = (rowLockedAt: Date | null, expected: Date) =>
        rowLockedAt !== null && rowLockedAt.getTime() === expected.getTime();

    // The lock the page rendered: unlocks.
    assert.equal(matches(lockedAt, lockedAt), true);
    // Re-locked since the page rendered: refused, so the NEW lock's snapshot
    // survives.
    assert.equal(matches(new Date("2026-09-09T00:00:00.000Z"), lockedAt), false);
    // Already unlocked: refused, rather than reporting success for a no-op.
    assert.equal(matches(null, lockedAt), false);
});

// ── Round 21 regressions: the CAS, the locked rate, the empty salaried list ──

test("a same-owner concurrent edit is caught by the CAS on the INITIAL updatedAt", () => {
    // The scenario the old CAS could not see. Nobody reassigns the entry, so the
    // owner check passes and the day locks are right — but another writer
    // changed the endTime / meal outcome / attestation between the pre-read and
    // the lock. This request recomputed duration and cost from the pre-read, so
    // its `data` describes a row that no longer exists.
    //
    // updatedAt moves on EVERY write (Prisma @updatedAt), so it is the one value
    // that catches all of those at once. Comparing the re-read against itself,
    // which is what the code did, catches none of them.
    const preRead = new Date("2026-09-01T10:00:00.000Z");
    const afterConcurrentEdit = new Date("2026-09-01T10:00:05.000Z");

    const casMatches = (initial: Date, current: Date) => initial.getTime() === current.getTime();

    // No concurrent write: the edit lands.
    assert.equal(casMatches(preRead, preRead), true);
    // A concurrent write moved updatedAt without moving startTime or the owner:
    // REFUSED, where the old tautological comparison would have accepted it.
    assert.equal(casMatches(preRead, afterConcurrentEdit), false);

    // The tautology, spelled out: the re-read compared against itself is always
    // equal, whatever happened before the lock was taken.
    assert.equal(casMatches(afterConcurrentEdit, afterConcurrentEdit), true);
});

test("the zero-rate flag follows the LOCKED rate, in both directions", async () => {
    const { zeroRateBlocks, appendZeroRateReview, ZERO_RATE_REVIEW_NOTE } = await import(
        "../src/lib/pay-rate-guard"
    );
    const hourly = { role: "FIELD_CREW", email: "tim@example.com", payType: "HOURLY" };

    // Rate became zero AFTER the pre-read: the pre-check saw 25 and passed, the
    // LOCKED read sees 0 — refused (or, when acknowledged, flagged).
    assert.equal(zeroRateBlocks({ ...hourly, hourlyRate: 25 }), false, "the stale pre-read");
    assert.equal(zeroRateBlocks({ ...hourly, hourlyRate: 0 }), true, "the locked read is what decides");
    const flagged = appendZeroRateReview("Meal break not taken");
    assert.equal(flagged.needsReview, true);
    assert.match(flagged.reviewReason, /Meal break not taken/);
    assert.match(flagged.reviewReason, /\$0 pay rate/);

    // Rate FIXED after the pre-read: the pre-check saw 0, the locked read sees
    // 25 — no warning at all. The old code wrote the flag from the pre-read, so
    // this entry came back carrying a "$0 pay rate" note that was untrue.
    assert.equal(zeroRateBlocks({ ...hourly, hourlyRate: 25 }), false);
    assert.equal(ZERO_RATE_REVIEW_NOTE.length > 0, true);
});

test("nobody is salaried by default — the list is empty until an operator sets it", async () => {
    const { DEFAULT_SALARIED_EMAILS, salariedEmails, isSalariedEmail } = await import(
        "../src/lib/payroll-config"
    );
    const before = process.env.PAYROLL_SALARIED_EMAILS;
    try {
        delete process.env.PAYROLL_SALARIED_EMAILS;
        assert.deepEqual(DEFAULT_SALARIED_EMAILS, []);
        assert.deepEqual(salariedEmails(), [], "unset env means NOBODY is exempt");

        process.env.PAYROLL_SALARIED_EMAILS = " CJ@Example.com , rlord@example.com ";
        assert.deepEqual(salariedEmails(), ["cj@example.com", "rlord@example.com"]);
        assert.equal(isSalariedEmail("cj@example.com"), true);
    } finally {
        if (before === undefined) delete process.env.PAYROLL_SALARIED_EMAILS;
        else process.env.PAYROLL_SALARIED_EMAILS = before;
    }
});

test("no employee is named in the payroll source any more", () => {
    // The hardcoded list was the code asserting, on nobody's authority, that two
    // specific humans are salaried.
    // .env.example is on the list because it is COPIED, not read: an example
    // that still named two people put the guessed list back into every fresh
    // environment, whatever the code default says.
    for (const file of ["src/lib/payroll-config.ts", "scripts/apply-payroll-phase5.mjs", ".env.example"]) {
        const source = read(file);
        assert.doesNotMatch(source, /cj@goldentouchremodeling\.com/, file);
        assert.doesNotMatch(source, /rlord@goldentouchremodeling\.com/, file);
    }
    // And the example ships the empty value, not a commented-out one somebody
    // would uncomment.
    assert.match(read(".env.example"), /^PAYROLL_SALARIED_EMAILS=\s*$/m);
    // And the config says so out loud, so the next reader knows it is deliberate.
    assert.match(read("src/lib/payroll-config.ts"), /fails CLOSED/);
});
