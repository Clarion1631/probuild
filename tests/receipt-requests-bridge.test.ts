/**
 * Pins the two Phase 2 §4 bridge endpoints' proxy bypass, and the "no emailed
 * PDFs anywhere" gate.
 *
 * The bypass matters both ways round: without it the Apps Script mirror gets a
 * 307 to /login instead of a clean 401, and with too MUCH of it a future
 * sibling route under /api/automation/receipt-requests/ would inherit a bypass
 * nobody reviewed.
 *
 * src/proxy.ts imports @/lib/staff-status (prisma) statically, so this file
 * sets the env prisma/next-auth expect before the dynamic import; nothing here
 * hits a database.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

process.env.NEXTAUTH_SECRET ??= "test-secret";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";

const loadProxy = () => import("../src/proxy");
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("the two bridge endpoints bypass the proxy so a machine caller gets a clean 401", async () => {
    const { isPublicProxyBypass } = await loadProxy();
    for (const path of [
        "/api/automation/receipt-requests/threads",
        "/api/automation/receipt-requests/threads/",
        "/api/automation/receipt-requests/answers",
        "/api/automation/receipt-requests/answers/",
    ]) {
        assert.equal(isPublicProxyBypass(path), true, path);
    }
});

test("the bypass is exact-match — nothing else under /api/automation inherits it", async () => {
    const { isPublicProxyBypass } = await loadProxy();
    for (const path of [
        "/api/automation/receipt-requests",
        "/api/automation/receipt-requests/threads/extra",
        "/api/automation/receipt-requests/anything-new",
        "/api/automation/review-issues/mark-reviewed",
        "/api/automation/export",
        "/automation",
    ]) {
        assert.equal(isPublicProxyBypass(path), false, path);
    }
});

test("every machine bypass refuses a Server Action dispatch", async () => {
    const { isMachineOnlyBypass, isPublicProxyBypass } = await loadProxy();
    for (const path of [
        // Phase 2's own.
        "/api/automation/receipt-requests/threads",
        "/api/automation/receipt-requests/answers/",
        // Phase 1's, same hole, same shared fix.
        "/api/receipts/intake",
        "/api/receipts/intake/abc123/archived",
        "/api/office-tasks/ingest",
        // Whole machine prefixes — a cron or an integration endpoint is never
        // an action target, and every one of them is on the bypass.
        "/api/cron/receipt-intake-worker",
        "/api/cron/bank-register-pull",
        "/api/cron/drain-notifications",
        "/api/integrations/bank-ledger/ingest",
        "/api/integrations/bank-ledger/reconcile",
        "/api/integrations/qbo-expenses/sync",
        "/api/webhook/stripe",
        "/api/twilio/inbound",
        "/api/health",
        "/api/version",
    ]) {
        assert.equal(isMachineOnlyBypass(path), true, path);
        // Each must ALSO be on the bypass — a guard over a path the proxy was
        // never waving through would prove nothing.
        assert.equal(isPublicProxyBypass(path), true, `${path} must be a bypass path`);
    }
});

test("machine paths NOT on the bypass are still refused an action dispatch", async () => {
    // Belt and braces. `/api/mcp/mcp` is not matched by the public bypass (the
    // bypass's own `mcp` alternative only reaches `/api/mcp/`), and the plural
    // `/api/webhooks/...` form likewise — but both are unambiguously machine
    // surfaces, so the guard covers them regardless of how the bypass evolves.
    const { isMachineOnlyBypass } = await loadProxy();
    for (const path of ["/api/mcp/mcp", "/api/webhooks/stripe"]) {
        assert.equal(isMachineOnlyBypass(path), true, path);
    }
});

test("surfaces with genuinely anonymous Server Actions keep working", async () => {
    const { isMachineOnlyBypass } = await loadProxy();
    for (const path of [
        // The portal accepts the anonymous-action tradeoff on purpose.
        "/portal/projects/abc",
        "/sub-portal/projects/abc",
        "/share/room/tok",
        "/api/portal/verify",
        "/api/sub-portal/login",
        "/api/selections/item-comments",
        "/api/pdf/invoices/abc",
        "/api/mobile/login",
        "/api/auth/session",
        // Ordinary app routes are untouched.
        "/projects/abc",
        "/automation",
        "/api/automation/review-issues/mark-reviewed",
        // Near-misses on the exact forms.
        "/api/receipts/parse",
        "/api/receipts/intake/abc123",
        "/api/office-tasks",
        "/api/automation/receipt-requests",
    ]) {
        assert.equal(isMachineOnlyBypass(path), false, path);
    }
});

test("the refusal is evaluated BEFORE every bypass, including the development one", async () => {
    // The dev bypass returns next() for everything, so a check placed after it
    // is simply absent in development — where the machine secrets are usually
    // weakest. This asserts the ORDER in the handler, which no unit-level call
    // of isMachineOnlyBypass can show.
    const source = readFileSync(join(repoRoot, "src/proxy.ts"), "utf8");
    const guardAt = source.indexOf("isMachineOnlyBypass(pathname)");
    const devBypassAt = source.indexOf("process.env.NODE_ENV === 'development'");
    const publicBypassAt = source.indexOf("isPublicProxyBypass(pathname)");
    assert.ok(guardAt > 0 && devBypassAt > 0 && publicBypassAt > 0);
    assert.ok(guardAt < devBypassAt, "the guard must precede the development bypass");
    assert.ok(guardAt < publicBypassAt, "the guard must precede the public bypass");
});

test("no Phase 2 module imports a mail helper — nothing here ever emails a PDF", () => {
    const files = [
        "src/lib/receipt-requests.ts",
        "src/lib/receipt-request-cards.ts",
        "src/lib/bank-register-pull.ts",
        "src/app/api/cron/receipt-requests/route.ts",
        "src/app/api/cron/receipt-request-cards/route.ts",
        "src/app/api/cron/bank-register-pull/route.ts",
        "src/app/api/automation/receipt-requests/threads/route.ts",
        "src/app/api/automation/receipt-requests/answers/route.ts",
        "src/app/automation/receipts-data.ts",
        "src/app/automation/receipts-filters.ts",
        "src/app/automation/components/receipts/receipts-tab.tsx",
        "src/app/automation/components/receipts/receipt-row-actions.tsx",
    ];
    // Matches the IMPORT, not the word: a comment saying "never email a PDF" is
    // the documentation this gate exists to keep true, and must not fail it.
    const mailImport = /^\s*import[^\n]*from\s+["'][^"']*(?:lib\/email|\/email|resend|nodemailer|sendNotification)[^"']*["']/m;
    for (const file of files) {
        const source = readFileSync(join(repoRoot, file), "utf8");
        assert.equal(mailImport.test(source), false, `${file} must not import a mail helper`);
        assert.equal(/\bsendNotification\s*\(/.test(source), false, `${file} must not call sendNotification`);
    }
});

test("the answers route never clears an issue whose resolution did not commit", () => {
    // It used to clear regardless of its CAS result, leaving a cleared issue
    // with NO resolution — which the next sweep read as "still unmatched" and
    // reopened. The memo the owner signed changed nothing.
    const source = readFileSync(join(repoRoot, "src/app/api/automation/receipt-requests/answers/route.ts"), "utf8");

    // Retry ONCE from a fresh read, not a reapplied snapshot.
    assert.match(source, /for \(let attempt = 0; attempt < 2/);
    assert.match(source, /const issue = await prisma\.reviewIssue\.findUnique\(/);
    // Round 4 item 3: the write is NOT gated on clearedAt any more — a valid
    // signature is evidence whatever the issue's current state.
    assert.match(source, /where: \{ id: issue\.id, version: issue\.version \}/);

    // The clear is UNREACHABLE unless the write committed.
    const notRecordedAt = source.indexOf("if (!recorded) {");
    const clearAt = source.indexOf("await evaluateReviewIssue(RECEIPT_REQUEST_TARGET_TYPE, bankLineId, [], null);");
    assert.ok(notRecordedAt > 0 && clearAt > notRecordedAt, "the guard must precede the clear");
    assert.match(source, /reason: "resolution-not-recorded"/);
    assert.match(source, /status: 409/);
});

test("the sweep recomputes source truth on an OCC retry instead of reapplying a snapshot", () => {
    const source = readFileSync(join(repoRoot, "src/app/api/cron/receipt-requests/route.ts"), "utf8");
    assert.match(source, /recomputeCodes: \(\) => recomputeCodesFor\(targetKey\)/);
    // The recompute reads the line and the evidence again, and honours a
    // resolution that landed since.
    assert.match(source, /async function recomputeCodesFor\(targetKey: string\)/);
    assert.match(source, /if \(hasResolution\(parseMissingReceiptDetails\(issue\?\.displayDetails \?\? null\)\)\) return \[\];/);
});

test("the missing-receipt loader pages when an owner filter is set", () => {
    // Filtering one 100-row page in memory rendered "nothing for Richard"
    // whenever his oldest item sat outside the newest page — an empty queue
    // that read as good news.
    const source = readFileSync(join(repoRoot, "src/app/automation/receipts-data.ts"), "utf8");
    assert.match(source, /async function scanMissingReceiptIssues\(owner: string \| null\)/);
    assert.match(source, /matched\.length < RECEIPT_GROUP_TAKE/);
    assert.match(source, /cursor: \{ id: cursor \}, skip: 1/);
    // Unfiltered stays a single page — no extra reads for the common case.
    assert.match(source, /if \(owner === null\) \{\s*\n\s*return prisma\.reviewIssue\.findMany\(\{ where, orderBy: \{ firstObservedAt: "desc" \}, take: RECEIPT_GROUP_TAKE, select \}\);/);
});

test("a signed memo is recorded even when the issue was already auto-closed", () => {
    // A memo signed after the matcher auto-closed the line used to be
    // discarded, so when the matching receipt was later deleted the sweep
    // reopened a charge somebody had genuinely answered weeks earlier.
    const source = readFileSync(join(repoRoot, "src/app/api/automation/receipt-requests/answers/route.ts"), "utf8");
    // The write is no longer gated on clearedAt: null.
    assert.match(source, /where: \{ id: issue\.id, version: issue\.version \}/);
    assert.doesNotMatch(source, /where: \{ id: issue\.id, version: issue\.version, clearedAt: null \}/);
    // A cleared issue still gets the record, and is not re-cleared.
    assert.match(source, /alreadyCleared = issue\.clearedAt !== null;/);
    assert.match(source, /alreadyCleared: true, memoRecorded: true/);
});

test("the cards cron writes history through a CAS, never through the lifecycle", () => {
    // Replaying selection-time codes through evaluateReviewIssue could reopen
    // an issue cleared while the card was in flight, and write stale details
    // back over its resolution.
    const source = readFileSync(join(repoRoot, "src/app/api/cron/receipt-request-cards/route.ts"), "utf8");
    // Matches a CALL, not the word — the code comments explain why it is not
    // used, and a comment must not fail the gate it documents.
    assert.doesNotMatch(source, /await evaluateReviewIssue\(/, "card history is not a lifecycle event");
    assert.doesNotMatch(source, /^import .*evaluateReviewIssue/m, "and the lifecycle is not even imported");
    assert.match(source, /where: \{ id: issue\.id, version: issue\.version, clearedAt: null \}/);
    assert.match(source, /if \(!issue \|\| issue\.clearedAt !== null\) continue;/);
});

test("card history is written only AFTER a validated post", () => {
    // Writing it first marked items everCarded for attempts that never reached
    // Chat, deprioritising work nobody had actually been asked about.
    const source = readFileSync(join(repoRoot, "src/app/api/cron/receipt-request-cards/route.ts"), "utf8");
    const postAt = source.indexOf("const result = await postOwnerCard(webhookUrl, card);");
    const recordAt = source.indexOf("await recordCardOnIssues(card, result.threadName, result.messageName, now);");
    assert.ok(postAt > 0 && recordAt > postAt, "history must follow the post");
    assert.doesNotMatch(source, /recordCardOnIssues\(card, null, null, now\)/, "no pre-post history write");
});

test("the bank pull fails loudly: any failure is a 500", () => {
    const source = readFileSync(join(repoRoot, "src/app/api/cron/bank-register-pull/route.ts"), "utf8");
    assert.match(source, /const status = summary\.ok \? 200 : 500;/);
    const lib = readFileSync(join(repoRoot, "src/lib/bank-register-pull.ts"), "utf8");
    assert.match(lib, /summary\.error = summary\.error \?\? "reconcile-failed";/);
    assert.match(lib, /summary\.error = summary\.error \?\? "mint-failed";/);
});

test("ReceiptRequestCard carries RLS in both DDL paths and the blind-spot snapshot", () => {
    const script = readFileSync(join(repoRoot, "scripts/apply-phase2-receipt-queue.mjs"), "utf8");
    const migration = readFileSync(join(repoRoot, "prisma/migrations/20260901120000_phase2_receipt_queue/migration.sql"), "utf8");
    for (const [label, source] of [["apply script", script], ["migration", migration]] as const) {
        assert.match(source, /ALTER TABLE "ReceiptRequestCard" ENABLE ROW LEVEL SECURITY/, label);
        // ENABLE without FORCE: FORCE denies the owner too, which is the app.
        assert.doesNotMatch(source, /ReceiptRequestCard" FORCE ROW LEVEL SECURITY/, label);
    }
    const snapshot = JSON.parse(readFileSync(join(repoRoot, "prisma/prisma-blind-spots.json"), "utf8"));
    assert.ok(
        snapshot.rlsTables.some((t: { name: string; forced: boolean }) => t.name === "ReceiptRequestCard" && t.forced === false),
        "check-migrations-match compares against this snapshot",
    );
});

test("a configured webhook that fails to deliver FAILS the run", () => {
    // A 200 here meant nobody was ever told the crew's card did not go out.
    const source = readFileSync(join(repoRoot, "src/app/api/cron/receipt-request-cards/route.ts"), "utf8");
    assert.match(source, /failures\.push\(card\.owner\);/);
    assert.match(source, /ok: failures\.length === 0/);
    assert.match(source, /status: summary\.ok \? 200 : 500/);
    // The row is left UNPOSTED with its claim released, so the retry pass can
    // take it straight away rather than waiting out a lease.
    assert.match(source, /lastError: "post-failed", claimedAt: null, claimToken: null/);
});

test("the retry pass re-posts unposted rows and never selects new work", () => {
    const source = readFileSync(join(repoRoot, "src/app/api/cron/receipt-request-cards/route.ts"), "utf8");
    assert.match(source, /const retryOnly = new URL\(request\.url\)\.searchParams\.get\("retry"\) === "1";/);
    assert.match(source, /if \(retryOnly\) continue; \/\/ nothing claimed today/);
    // It needs no scan at all — it posts from the claimed snapshot.
    assert.match(source, /retryOnly\s*\n\s*\? \{ candidates: \[\] as CardCandidateIssue\[\]/);
});

test("the retry pass is scheduled two hours after the morning card", () => {
    const vercel = JSON.parse(readFileSync(join(repoRoot, "vercel.json"), "utf8")) as {
        crons: Array<{ path: string; schedule: string }>;
    };
    const first = vercel.crons.find(c => c.path === "/api/cron/receipt-request-cards");
    const retry = vercel.crons.find(c => c.path === "/api/cron/receipt-request-cards?retry=1");
    assert.ok(first && retry, "both passes must be scheduled");
    assert.equal(first.schedule, "30 14 * * 1-5");
    assert.equal(retry.schedule, "30 16 * * 1-5", "two hours later, weekdays only");
});

test("the sweep is time-budgeted, checkpoints per batch, and stops at a failure", () => {
    const source = readFileSync(join(repoRoot, "src/app/api/cron/receipt-requests/route.ts"), "utf8");
    assert.match(source, /const BATCH_SIZE = 200;/);
    assert.match(source, /const RUN_BUDGET_MS = 45_000;/);
    assert.match(source, /while \(Date\.now\(\) - startedAt < RUN_BUDGET_MS\)/);
    // Checkpoint after every batch, so a killed run loses one batch, not all.
    assert.match(source, /await writeCursor\(cursor\);/);
    // The cursor must NOT advance past a target whose write threw.
    assert.match(source, /if \(outcome\.summary\.errors > 0\) break;/);
    const breakAt = source.indexOf("if (outcome.summary.errors > 0) break;");
    const advanceAt = source.indexOf("cursor = batch[batch.length - 1].id;");
    assert.ok(breakAt > 0 && advanceAt > breakAt, "the break must come BEFORE the cursor advances");
    // And errors make the run a 500.
    assert.match(source, /ok: totals\.errors === 0/);
    assert.match(source, /status: result\.ok \? 200 : 500/);
});

test("the sweep runs every 15 minutes so a backlog drains across invocations", () => {
    const vercel = JSON.parse(readFileSync(join(repoRoot, "vercel.json"), "utf8")) as {
        crons: Array<{ path: string; schedule: string }>;
    };
    const sweep = vercel.crons.find(c => c.path === "/api/cron/receipt-requests");
    assert.ok(sweep);
    assert.equal(sweep.schedule, "*/15 * * * *");
});

test("worker OWNERSHIP is a claim token, not the retry schedule", () => {
    const worker = readFileSync(join(repoRoot, "src/app/api/cron/receipt-intake-worker/route.ts"), "utf8");
    // The claim writes ownership and leaves scheduling alone.
    assert.match(worker, /data: \{ claimToken, claimedAt: now \}/);
    assert.doesNotMatch(worker, /data: \{ nextRetryAt: new Date\(now\.getTime\(\) \+ LEASE_MS\) \}/);
    // Due AND unowned are two separate questions.
    assert.match(worker, /claimedAt: null \}, \{ claimedAt: \{ lt: claimCutoff \} \}/);
    // And the claim is released when the worker is done with the row.
    assert.match(worker, /claimToken: null, claimedAt: null/);

    const actions = readFileSync(join(repoRoot, "src/lib/actions.ts"), "utf8");
    // The queue actions fence on the CLAIM, never on nextRetryAt.
    assert.match(actions, /function notClaimedByWorker\(now: Date\)[\s\S]{0,220}claimedAt: null/);
    assert.doesNotMatch(actions, /function notClaimedByWorker\(now: Date\)[\s\S]{0,220}nextRetryAt/);
    // "Retry now" is scheduling.
    assert.match(actions, /\/\/ Scheduling only\. Ownership is claimToken\/claimedAt/);
});

test("resolveOrphanedQbPurchase CASes and APPENDS rather than overwriting", () => {
    const source = readFileSync(join(repoRoot, "src/lib/actions.ts"), "utf8");
    assert.match(source, /where: \{ id, state: row\.state, postVoidQbPurchaseId: row\.postVoidQbPurchaseId \}/);
    assert.match(source, /`\$\{row\.stateReason\}; \$\{note\}`/, "the existing reason must survive");
    assert.match(source, /stale: true as const/, "a lost race is a stale verdict, not a retryable error");
});

test("minting and adoption run in bounded transactions with explicit timeouts", () => {
    const pull = readFileSync(join(repoRoot, "src/app/api/cron/bank-register-pull/route.ts"), "utf8");
    assert.match(pull, /const MINT_BATCH_SIZE = 200;/);
    assert.match(pull, /const MINT_TX_TIMEOUT_MS = 20_000;/);
    assert.match(pull, /\}, \{ timeout: MINT_TX_TIMEOUT_MS \}\);/);
    // The identity lock is taken PER BATCH, inside the loop.
    const loopAt = pull.indexOf("for (let batch = 0; batch < MINT_MAX_BATCHES; batch++)");
    const lockAt = pull.indexOf("pg_advisory_xact_lock", loopAt);
    assert.ok(loopAt > 0 && lockAt > loopAt, "the lock belongs inside the batch loop");

    const ingest = readFileSync(join(repoRoot, "src/app/api/integrations/bank-ledger/ingest/route.ts"), "utf8");
    assert.match(ingest, /timeout: STATEMENT_TX_TIMEOUT_MS/);
});

test("the bank pull fails on a stale fetch, chunk errors, or unattempted links", () => {
    const lib = readFileSync(join(repoRoot, "src/lib/bank-register-pull.ts"), "utf8");
    assert.match(lib, /ok: !fetched\.stale/);
    assert.match(lib, /summary\.error = summary\.error \?\? "reconcile-chunk-errors";/);
    assert.match(lib, /summary\.error = summary\.error \?\? "reconcile-incomplete";/);
    // The last-success stamp is only written for a fully successful run.
    const route = readFileSync(join(repoRoot, "src/app/api/cron/bank-register-pull/route.ts"), "utf8");
    assert.match(route, /if \(summary\.ok\) \{[\s\S]{0,400}BANK_PULL_LAST_SUCCESS_KEY/);
});

test("health enablement is the cron's existence, not an undocumented env var", () => {
    const health = readFileSync(join(repoRoot, "src/lib/pipeline-health.ts"), "utf8");
    // Matches a READ of the env, not the word — the comment explaining why the
    // flag is not used must not fail the gate it documents.
    assert.doesNotMatch(health, /process\.env\.BANK_LINE_MINT_FROM_QBO/, "that flag controls MINTING, not the pull");
    assert.doesNotMatch(health, /process\.env\.BANK_REGISTER_PULL_ENABLED/);
    assert.match(health, /return \{ enabled: true, lastSuccessAt: row\?\.value \|\| null \};/);
    const vercel = JSON.parse(readFileSync(join(repoRoot, "vercel.json"), "utf8")) as {
        crons: Array<{ path: string }>;
    };
    assert.ok(vercel.crons.some(c => c.path === "/api/cron/bank-register-pull"), "which is true because the cron is scheduled");
});
