import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Codex PR #443, adversarial gate round 48.
 *
 * All three are the same shape: a guard that FAILED OPEN. An unreadable
 * manifest read as "nothing known"; an unreadable quarantine store read as
 * "nothing held"; a lost CAS still left a reservation behind. In each case the
 * absence of information was treated as the absence of a problem, which is the
 * one reading that lets a broken run certify itself.
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(repoRoot, rel), "utf8");

// ═══ 1. An unreadable split manifest stops the run ═════════════════════════

test("the manifest fails closed: unreadable or malformed throws, never {}", () => {
    const route = read("src/app/api/cron/bank-register-pull/route.ts");

    // The bug: every failure became `{}`, which is not "no manifest" — it is
    // "every transaction looks new", and `convertRegisterRows` can only detect
    // a 1-to-N cardinality change by comparing against prior state. A transient
    // read failure therefore emitted fresh T#0/T#1 observations while the old
    // bare T observation and its minted BankLine stayed, and the next
    // successful write hid the transition for ever.
    assert.match(route, /class SplitManifestUnreadableError extends Error/);
    assert.match(route, /throw new SplitManifestUnreadableError\("the stored split manifest is not valid JSON"\)/);
    assert.match(route, /throw new SplitManifestUnreadableError\("the stored split manifest is not an object"\)/);
    // SCHEMA-checked, not merely parsed — and the CONDITION, not just the
    // message: a message survives having its `if` neutered, which is exactly
    // how a "checked" manifest stops being checked.
    assert.match(route, /if \(!Array\.isArray\(hashes\) \|\| !hashes\.every\(hash => typeof hash === "string"\)\) \{/);
    assert.match(route, /is not a list of hashes/);

    // An ABSENT row is still a real answer: no pull has written one yet.
    assert.match(route, /if \(!row\) return \{\};/);

    // And nothing swallows it back into an empty object.
    assert.doesNotMatch(route, /catch \{\s*\n\s*\/\/ An unreadable manifest reads as EMPTY/);
});

test("an unreadable manifest is a 503 with a continuation obligation", () => {
    const route = read("src/app/api/cron/bank-register-pull/route.ts");

    assert.match(route, /if \(error instanceof SplitManifestUnreadableError\)/);
    assert.match(route, /status: 503/);
    assert.match(route, /continuationPending: true,\s*\n\s*continuationReason: MANIFEST_UNREADABLE_REASON,/);
    assert.match(route, /await recordBlockedReason\(MANIFEST_UNREADABLE_REASON\);/);
    assert.match(route, /export const MANIFEST_UNREADABLE_REASON = "bank-manifest-unreadable";/);

    // It is thrown BEFORE any ingest and before any state save, so a failed run
    // leaves nothing behind to be confused by.
    const lib = read("src/lib/bank-register-pull.ts");
    const loadAt = lib.indexOf("const priorManifest = dependencies.loadSplitManifest");
    const ingestAt = lib.indexOf("convertRegisterRows(fetched.rows, priorManifest)");
    const saveAt = lib.indexOf("await dependencies.saveWindowState({");
    assert.ok(loadAt > 0 && ingestAt > loadAt && saveAt > ingestAt,
        "manifest, then convert, then save — a throw at the first step reaches neither");
});

// ═══ 2. Quarantine state fails closed ═════════════════════════════════════

test("an unreadable quarantine store blocks the stamp, and is not overwritten", () => {
    const route = read("src/app/api/cron/bank-register-pull/route.ts");

    // Read failure, malformed entries and malformed acceptances are all
    // blockers — `[]` was the reading that let a run certify a short ledger.
    // THREE failure paths, all blockers, counted rather than sampled: asserting
    // one `blocker(...)` call exists stayed green when another was replaced by
    // a success (measured).
    assert.equal((route.match(/return blocker\(QUARANTINE_UNREADABLE_REASON, found\.map/g) ?? []).length, 3,
        "read failure, malformed entries and malformed acceptances all block");
    // And the CONDITIONS, not just their messages.
    assert.match(route, /if \(existingRow\?\.value && parseQuarantine\(existingRow\.value\) === null\) \{/);
    assert.match(route, /if \(acceptedRow\?\.value && parseAcceptedQuarantine\(acceptedRow\.value\) === null\) \{/);
    assert.match(route, /refusing to overwrite it/);
    assert.match(route, /refusing to read them as none/);
    // No path returns a clean result from a failure.
    assert.doesNotMatch(route, /catch \(error\) \{[\s\S]{0,200}?return \{ ok: true/);
    // A write failure preserves the KNOWN entries, not just this fetch's.
    assert.match(route, /return blocker\(QUARANTINE_UNWRITABLE_REASON, merged\);/);
    // And the blocker actually blocks.
    assert.match(route, /const quarantineBlocked = !quarantine\.ok;/);
    assert.match(route, /quarantineHeld\.length === 0 && !quarantineBlocked/);
});

test("health reports an unreadable quarantine store rather than a count of zero", () => {
    /**
     * The reason branch, read from the source and exercised through the count
     * contract. `-1` is the signal for "the store did not parse" — a count of
     * zero would say "nothing is held", which is the reading that let a run
     * certify a ledger with rows missing.
     */
    const health = read("src/lib/pipeline-health.ts");

    assert.match(health, /if \(\(input\.bankPull\.quarantinedCount \?\? 0\) < 0\) \{[\s\S]{0,300}?reasons\.push\("bank-quarantine-unreadable"\);/);
    assert.match(health, /\} else if \(\(input\.bankPull\.quarantinedCount \?\? 0\) > 0\) \{/,
        "and a real count is still reported, as a count");

    // The probe produces that -1 rather than swallowing the parse failure.
    assert.match(health, /if \(entries === null \|\| accepted === null\) return -1;/);
    // PRE-FIX CONTROL: the old parsers returned [] for malformed input, so the
    // probe could not tell "none" from "unreadable" at all.
    assert.doesNotMatch(health, /export function parseQuarantine\(value: string \| null \| undefined\): BankPullQuarantineEntry\[\] \{/);
});

test("the durable entry is typed, and an acceptance is bound to its version", () => {
    const route = read("src/app/api/cron/bank-register-pull/route.ts");
    // The real reason and count, not a hard-coded pair.
    assert.match(route, /reason: entry\.reason,/);
    assert.match(route, /count: entry\.count,/);
    assert.match(route, /firstSeenAt: prior\?\.firstSeenAt \?\? now,/);
    assert.match(route, /lastSeenAt: now,/);
    // The version moves when the CONDITION does, which is what lapses an
    // acceptance granted against the old one.
    assert.match(route, /const conditionChanged = !prior \|\| prior\.reason !== entry\.reason \|\| prior\.count !== entry\.count;/);
    assert.match(route, /version: conditionChanged \? \(prior\?\.version \?\? 0\) \+ 1 : \(prior\?\.version \?\? 1\),/);
});

// ═══ 3. A lost CAS leaves nothing behind ══════════════════════════════════

test("the CAS runs FIRST, and the reservation only if it won", () => {
    const cards = read("src/app/api/cron/receipt-request-cards/route.ts");

    const casAt = cards.indexOf("const claimed = await tx.receiptRequestCard.updateMany({");
    const guardAt = cards.indexOf("if (claimed.count === 0) return claimed;", casAt);
    const reserveAt = cards.indexOf("await tx.receiptRequestCardDelivery.create({", casAt);
    assert.ok(casAt > 0 && guardAt > casAt && reserveAt > guardAt,
        "claim, check, then reserve — a loser must leave nothing behind");

    // PRE-FIX CONTROL: the reservation used to be inserted before the CAS, so a
    // run that had lost the claim token returned normally, sent nothing, and
    // still committed a delivery row — burning that owner's only slot for the
    // day on a card nobody received.
    const insertBeforeClaim = reserveAt < casAt;
    assert.equal(insertBeforeClaim, false);

    // The reservation is still taken BEFORE the webhook (round-43, finding 1):
    // a Chat message cannot be recalled, so the claim is made while losing it
    // is free.
    const postAt = cards.indexOf("const result = await postOwnerCard(webhookUrl, card, { timeoutMs: sendTimeoutMs });");
    assert.ok(postAt > reserveAt, "reserve, then send");
});
