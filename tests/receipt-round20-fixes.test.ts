import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { componentVersionOf, componentVersionsMatch, planReceiptRequests } from "../src/lib/receipt-requests";

/**
 * Round-20 review findings. Each of these is a way the sweep or the cards cron
 * could look correct while quietly losing a receipt, a day, or an issue.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const sweepSource = readFileSync(join(repoRoot, "src/app/api/cron/receipt-requests/route.ts"), "utf8");
const cardsSource = readFileSync(join(repoRoot, "src/app/api/cron/receipt-request-cards/route.ts"), "utf8");

// ── 1. a replan reloads the state that caused it ───────────────────────────

test("a replan reloads the issue snapshot instead of replaying the stale one", () => {
    // A replan happens BECAUSE something moved, and the usual something is a
    // memo signed on a sibling — which lands in exactly these three inputs.
    // Retrying with the run-start snapshot replans against the state that was
    // already stale, so attempt two reaches attempt one's wrong verdict and
    // opens a chase for a charge somebody just answered.
    assert.match(sweepSource, /const reloaded = await loadIssueSnapshot\(\);/);
    assert.match(sweepSource, /issues = reloaded\.openIssues;/);
    assert.match(sweepSource, /resolved = reloaded\.resolvedIssueKeys;/);
    assert.match(sweepSource, /details = reloaded\.detailsByKey;/);
    // The retry passes the RELOADED values, not the parameters.
    assert.match(sweepSource, /await processBatch\(batch, issues, resolved, details, now, cohortMode\)/);
    // ONE loader, shared with the run's opening snapshot — two would drift, and
    // a replan reading a subtly different set is the bug it exists to fix.
    assert.match(sweepSource, /const \{ openIssues, resolvedIssueKeys, detailsByKey \} = await loadIssueSnapshot\(\);/);
    assert.equal((sweepSource.match(/async function loadIssueSnapshot\(/g) ?? []).length, 1);
});

test("the reloaded state is what changes the verdict — sibling resolution", () => {
    // The behaviour the reload buys, stated as data: with A answered, the one
    // receipt goes to B and B is not opened. If a replan replayed the old
    // snapshot (A unresolved) it would open B instead.
    const base = {
        bankLines: [
            { id: "bl-a", postedDate: "2026-08-16", amountCents: -12_345, rawDescriptor: "LOWES #02516 POS DEB C#8516", checkNumber: null },
            { id: "bl-b", postedDate: "2026-08-16", amountCents: -12_345, rawDescriptor: "LOWES #02516 POS DEB C#8516", checkNumber: null },
        ],
        expenses: [{ id: "exp-1", qbPurchaseId: null, hasReceipt: true, amountCents: 12_345, date: "2026-08-16", vendor: "Lowes" }],
        intakes: [],
        openIssueKeys: ["bl-a", "bl-b"],
        now: new Date("2026-08-20T12:00:00Z"),
    };
    const stale = planReceiptRequests(base);
    assert.deepEqual(stale.open.map(o => o.targetKey), ["bl-b"], "the snapshot that is already wrong");

    const reloaded = planReceiptRequests({ ...base, resolvedIssueKeys: ["bl-a"] });
    assert.deepEqual(reloaded.open, [], "and the state a reload would have seen");
});

// ── 2. the evidence fence covers every decision-driving field ──────────────

test("an expense whose amount, date or vendor changed forces a replan", () => {
    // Identity and receipt-presence are not the whole input: all three of these
    // decide WHICH line an expense can answer, and none of them moves a
    // timestamp on a table that has no updatedAt column.
    const issues = [{ targetKey: "bl-1", updatedAt: new Date("2026-09-02T10:00:00Z") }];
    const intakes: Array<{ updatedAt: Date }> = [];
    const lines = [{ id: "bl-1", rawDescriptor: "LOWES #02516" }];
    const at = (over: Partial<{ amountCents: number; date: string; vendor: string }>) => componentVersionOf({
        issues,
        intakes,
        lines,
        expenses: [{ id: "exp-1", hasReceipt: true, amountCents: 12_345, date: "2026-08-16", vendor: "Lowes", ...over }],
    });
    const planned = at({});
    assert.equal(componentVersionsMatch(planned, at({})), true, "an untouched expense replans nothing");
    for (const [label, change] of [
        ["a corrected amount", { amountCents: 12_346 }],
        ["a corrected date", { date: "2026-08-17" }],
        ["a corrected vendor", { vendor: "Home Depot" }],
    ] as const) {
        assert.equal(componentVersionsMatch(planned, at(change)), false, label);
    }
});

test("an intake edited in place forces a replan too", () => {
    const issues = [{ targetKey: "bl-1", updatedAt: new Date("2026-09-02T10:00:00Z") }];
    const intake = (over: Record<string, unknown>) => componentVersionOf({
        issues,
        intakes: [{
            id: "int-1",
            updatedAt: new Date("2026-09-02T09:00:00Z"),
            state: "BOOKED",
            stateReason: null,
            totalCents: 12_345,
            txnDate: "2026-08-16",
            vendor: "Lowes",
            ...over,
        }],
    });
    const planned = intake({});
    for (const [label, change] of [
        ["parked as bytes-missing", { stateReason: "receipt-bytes-missing" }],
        ["voided", { state: "VOID" }],
        ["a corrected total", { totalCents: 9_999 }],
        ["a corrected date", { txnDate: "2026-08-18" }],
        ["a corrected vendor", { vendor: "Ace" }],
    ] as const) {
        assert.equal(componentVersionsMatch(planned, intake(change)), false, label);
    }
});

test("concurrent sweeps serialize on a per-component advisory lock", () => {
    // Row locks cover rows that EXIST. They cannot exclude a second sweep about
    // to read the same Expense rows (ordinary reads take no lock) or insert a
    // new competitor into the window — so without this both pass their
    // fingerprint checks and both write.
    assert.match(sweepSource, /const COMPONENT_LOCK_PREFIX = "receipt-component:";/);
    assert.match(sweepSource, /await tx\.\$executeRaw`SELECT pg_advisory_xact_lock\(hashtext\(\$\{`\$\{COMPONENT_LOCK_PREFIX\}\$\{component\.key\}`\}\)\)`;/);
    // Taken FIRST, before the row locks and the re-read.
    const lockAt = sweepSource.indexOf("pg_advisory_xact_lock");
    const rowLockAt = sweepSource.indexOf('SELECT "id" FROM "ReviewIssue"');
    const readAt = sweepSource.indexOf("const current = componentVersionOf({");
    assert.ok(lockAt > 0 && rowLockAt > lockAt && readAt > rowLockAt);
});

// ── 3. the open-issue cursor stops at any page-local failure ───────────────

test("an orphan-close failure stops the open-issue checkpoint", () => {
    // It used to be counted and then stepped over: a later `?continue=1` could
    // finish the pass and clear the cursor, stranding that issue permanently —
    // nagging forever with a target nothing can answer.
    assert.match(sweepSource, /let pageErrors = 0;/);
    assert.match(sweepSource, /openPass\.errors\+\+;\s*\n\s*pageErrors\+\+;/);
    assert.match(sweepSource, /pageErrors \+= outcome\.summary\.errors;/);
    // The break covers BOTH halves of the page, and comes before the advance.
    // It also covers CONTENDED components (round-22 finding): a component that
    // ran out of replans got no verdict, and advancing past its page would
    // strand it just as surely as an error would.
    const breakAt = sweepSource.indexOf("if (pageErrors > 0 || pageContended > 0) break;");
    const advanceAt = sweepSource.indexOf("openCursor = page[page.length - 1].id;");
    assert.ok(breakAt > 0 && advanceAt > breakAt, "no checkpoint past a failure or contention");
    // And the old shape — breaking only on the batch's errors — is gone.
    assert.doesNotMatch(sweepSource, /if \(outcome\.summary\.errors > 0\) break;\s*\n\s*\}\s*\n\s*openCursor =/);
});

// ── 4. the retry pass can still save the day ───────────────────────────────

test("the retry pass selects when the chase finished after the morning run", () => {
    // The ordinary sequence that used to lose a whole day: 14:30 finds the
    // chase unfinished and claims nothing, the chase completes at 15:00, and
    // the 16:30 retry — the last run of the day — refused to select because
    // there was no row to re-post.
    assert.match(cardsSource, /const selectionAllowed = chaserCompletedFor\(marker, date\);/);
    assert.match(cardsSource, /if \(!selectionAllowed\) continue;/);
    assert.doesNotMatch(cardsSource, /if \(retryOnly\) continue; \/\/ nothing claimed today/);
    // It also has to SCAN, or selection finds an empty list — the same lost day
    // wearing a different hat.
    assert.match(cardsSource, /const scan = selectionAllowed\s*\n\s*\? await scanCandidates\(\)/);
    // A retry that may not select still re-posts what an earlier run claimed.
    assert.match(cardsSource, /if \(!retryOnly\) \{\s*\n\s*if \(!selectionAllowed\) \{/);
});

// ── 7. the owner assignment CASes on the RENDERED version ──────────────────

test("owner assignment is refused when the page was showing an older version", () => {
    const actions = readFileSync(join(repoRoot, "src/lib/actions.ts"), "utf8");
    assert.match(actions, /setMissingReceiptOwner\(issueId: string, owner: string, expectedVersion: number\)/);
    // Rejected before the read, atomically at the write, and never against a
    // version this call discovered for itself.
    assert.match(actions, /if \(!Number\.isInteger\(expectedVersion\) \|\| expectedVersion < 1\)/);
    assert.match(actions, /if \(issue\.version !== expectedVersion\) \{/);
    assert.match(actions, /where: \{ id: issue\.id, version: expectedVersion, clearedAt: null \}/);
    assert.doesNotMatch(actions, /where: \{ id: issue\.id, version: issue\.version, clearedAt: null \}/);
    // And the page hands its rendered version over.
    const tab = readFileSync(join(repoRoot, "src/app/automation/components/receipts/receipts-tab.tsx"), "utf8");
    assert.match(tab, /<AssignOwnerControl issueId=\{row\.id\} currentOwner=\{row\.owner\} expectedVersion=\{row\.version\} \/>/);
});
