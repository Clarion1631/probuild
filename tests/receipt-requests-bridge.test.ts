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
import { computeQboLineContentHash, isDescriptorOnlyChange } from "../src/lib/bank-ledger";
import { resolveReceiptOwner } from "../src/lib/receipt-policy";
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

test("machine paths NOT on the bypass are refused by the proxy itself", async () => {
    // These two are not matched by the public bypass at all (`/api/mcp/mcp`
    // goes past the bypass's own `mcp` alternative, and the plural
    // `/api/webhooks/...` form likewise), so they take the ORDINARY path: the
    // proxy's session check. `isMachineOnlyBypass` is about the bypassed set,
    // so it is false for them — and that is not a hole, it is a stricter route.
    const { isMachineOnlyBypass, isPublicProxyBypass } = await loadProxy();
    for (const path of ["/api/mcp/mcp", "/api/webhooks/stripe"]) {
        assert.equal(isPublicProxyBypass(path), false, `${path} is not bypassed`);
        assert.equal(isMachineOnlyBypass(path), false, `${path} never skips the proxy`);
    }
});

test("only the portal surfaces may dispatch a Server Action anonymously", async () => {
    // INVERTED with Phase 1's allowlist. It used to be "everything except a
    // listed set of machine endpoints", which is the wrong shape for a global
    // action namespace: every bypassed path nobody thought to list — /share,
    // /api/pdf/*, /api/auth — was a live anonymous dispatcher. Now only the two
    // surfaces that genuinely define anonymous actions are open.
    const { isMachineOnlyBypass, isPublicProxyBypass } = await loadProxy();
    for (const path of ["/portal/projects/abc", "/sub-portal/projects/abc"]) {
        assert.equal(isPublicProxyBypass(path), true, path);
        assert.equal(isMachineOnlyBypass(path), false, `${path} accepts the tradeoff on purpose`);
    }
    // Everything else that skips the proxy is refused one, INCLUDING the paths
    // the old denylist quietly left open.
    for (const path of [
        "/share/room/tok",
        "/api/portal/verify",
        "/api/sub-portal/login",
        "/api/selections/item-comments",
        "/api/pdf/invoices/abc",
        "/api/mobile/login",
        "/api/auth/session",
        "/login",
    ]) {
        assert.equal(isPublicProxyBypass(path), true, `${path} is bypassed`);
        assert.equal(isMachineOnlyBypass(path), true, `${path} defines no anonymous action`);
    }
    // Ordinary app routes never reach the bypass at all — the session check is
    // what refuses them.
    for (const path of ["/projects/abc", "/automation", "/api/automation/review-issues/mark-reviewed"]) {
        assert.equal(isPublicProxyBypass(path), false, path);
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
    // The writer moved to one shared module — the cron and the operator's
    // "mark delivered" have to leave the SAME trace — and the CAS moved with it.
    const writer = readFileSync(join(repoRoot, "src/lib/receipt-card-history.ts"), "utf8");
    // A CALL, not the word: the module comment explains why it is not used.
    assert.doesNotMatch(writer, /await evaluateReviewIssue\(/);
    assert.match(writer, /where: \{ id: issue\.id, version: issue\.version, clearedAt: null \}/);
    assert.match(writer, /if \(!issue \|\| issue\.clearedAt !== null\) \{ skipped\+\+; continue; \}/);
});

test("card history is written only AFTER a validated post", () => {
    // Writing it first marked items everCarded for attempts that never reached
    // Chat, deprioritising work nobody had actually been asked about.
    const source = readFileSync(join(repoRoot, "src/app/api/cron/receipt-request-cards/route.ts"), "utf8");
    const postAt = source.indexOf("const result = await postOwnerCard(webhookUrl, card);");
    // It rides INSIDE the completion transaction now — same ordering, and the
    // pair commits together (tests/receipt-request-cards.test.ts).
    const recordAt = source.indexOf("await recordCardOnIssues(card, result.threadName, result.messageName, now, tx);");
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
    assert.match(source, /ok: failures\.length === 0 && uncertainTransitions\.length === 0,/);
    // A REFUSED delivery is a 500 — it is worth retrying. An UNCONFIRMED one is
    // partial: ok:false, HTTP 200, because it needs a human and not another
    // attempt (see tests/receipt-request-cards.test.ts).
    assert.match(source, /status: failures\.length > 0 \? 500 : 200/);
    // The row is left UNPOSTED with its claim released, so the retry pass can
    // take it straight away rather than waiting out a lease.
    assert.match(source, /status: "PENDING",[\s\S]{0,200}lastError: `rejected:\$\{result\.reason\}`/);
});

test("the retry pass re-posts unposted rows, and selects only when it may", () => {
    const source = readFileSync(join(repoRoot, "src/app/api/cron/receipt-request-cards/route.ts"), "utf8");
    assert.match(source, /const retryOnly = new URL\(request\.url\)\.searchParams\.get\("retry"\) === "1";/);
    // It re-posts what an earlier run claimed, and — since round 20 — MAY also
    // select when the chase finished after the morning run bailed, which is
    // the only way that day gets a card at all.
    assert.match(source, /if \(!selectionAllowed\) continue;/);
    assert.match(source, /const selectionAllowed = chaserCompletedFor\(marker, date\);/);
    // The scan follows the same verdict: needed when it may select, skipped
    // when it may not (then it posts purely from the claimed snapshot).
    assert.match(source, /const scan = selectionAllowed\s*\n\s*\? await scanCandidates\(\)\s*\n\s*: \{ candidates: \[\] as CardCandidateIssue\[\]/);
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
    assert.match(source, /while \([^)]*Date\.now\(\) - startedAt < RUN_BUDGET_MS\)/);
    // Checkpoint after every page, so a killed run loses one page, not all.
    assert.match(source, /await writeCursor\(cursor\);/);
    // The cursor must NOT advance past a target whose write threw — from
    // either half of the page (round-20 finding 3) — or past an unresolved
    // contended component (round-22 finding: no replan ever reached a verdict).
    assert.match(source, /if \(pageErrors > 0 \|\| pageContended > 0\) break;/);
    const breakAt = source.lastIndexOf("if (pageErrors > 0 || pageContended > 0) break;");
    const advanceAt = source.lastIndexOf("cursor = page[page.length - 1].key;");
    assert.ok(breakAt > 0 && advanceAt > breakAt, "the break must come BEFORE the cursor advances");
    // And errors make the run a 500.
    assert.match(source, /ok: totals\.errors === 0/);
    assert.match(source, /status: result\.ok \? 200 : 500/);
});

test("worker ownership is a claim TOKEN, and the queue fences on it", () => {
    // Phase 1 owns the claim itself and keeps `nextRetryAt` as part of the
    // lease; Phase 2's contribution is that the QUEUE ACTIONS stop reading
    // nextRetryAt as a lock. Fencing on the schedule conflated "in retry
    // backoff" with "being processed", so a human could not void a row that was
    // merely waiting.
    const worker = readFileSync(join(repoRoot, "src/app/api/cron/receipt-intake-worker/route.ts"), "utf8");
    assert.match(worker, /const claimToken = randomUUID\(\);/);
    assert.match(worker, /claimToken, claimedAt: now/);

    const actions = readFileSync(join(repoRoot, "src/lib/actions.ts"), "utf8");
    assert.match(actions, /function notClaimedByWorker\(now: Date\)[\s\S]{0,260}claimedAt: null/);
    assert.doesNotMatch(actions, /function notClaimedByWorker\(now: Date\)[\s\S]{0,260}nextRetryAt/);
    assert.match(actions, /\/\/ Scheduling only\. Ownership is claimToken\/claimedAt/);
});

test("finished worker transitions hand ownership back", () => {
    const source = readFileSync(join(repoRoot, "src/app/api/cron/receipt-intake-worker/route.ts"), "utf8");
    // Phase 1 named the pair; the invariant is unchanged — every finished or
    // deferred transition hands the row back, or a crashed claim blocks a human
    // for the whole lease.
    assert.match(source, /const RELEASE_CLAIM = \{ claimToken: null, claimedAt: null \} as const;/);
    const releases = source.match(/\.\.\.RELEASE_CLAIM/g) ?? [];
    assert.ok(releases.length >= 4, `expected terminal/deferred branches to release, saw ${releases.length}`);
});

test("resolveOrphanedQbPurchase CASes and APPENDS rather than overwriting", () => {
    const source = readFileSync(join(repoRoot, "src/lib/actions.ts"), "utf8");
    assert.match(source, /where: \{ id, state: row\.state, updatedAt: seenAt, postVoidQbPurchaseId: row\.postVoidQbPurchaseId \}/);
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

test("the bank pull fails on a stale fetch and on chunk errors; truncation is not a failure", () => {
    const lib = readFileSync(join(repoRoot, "src/lib/bank-register-pull.ts"), "utf8");
    assert.match(lib, /ok: !fetched\.stale/);
    assert.match(lib, /summary\.error = summary\.error \?\? "reconcile-chunk-errors";/);
    assert.match(lib, /summary\.error = summary\.error \?\? "reconcile-incomplete";/);
    // The last-success stamp needs a run that was BOTH clean and whole: a
    // budget-truncated run read part of one window, which is not proof the
    // register is current. Behaviour lives in tests/bank-pull-window.test.ts.
    const route = readFileSync(join(repoRoot, "src/app/api/cron/bank-register-pull/route.ts"), "utf8");
    assert.match(route, /if \(summary\.ok && summary\.complete && ambiguousCount === 0\) \{[\s\S]{0,400}BANK_PULL_LAST_SUCCESS_KEY/);
});

test("health enablement is the cron's existence, not an undocumented env var", () => {
    const health = readFileSync(join(repoRoot, "src/lib/pipeline-health.ts"), "utf8");
    // Matches a READ of the env, not the word — the comment explaining why the
    // flag is not used must not fail the gate it documents.
    assert.doesNotMatch(health, /process\.env\.BANK_LINE_MINT_FROM_QBO/, "that flag controls MINTING, not the pull");
    assert.doesNotMatch(health, /process\.env\.BANK_REGISTER_PULL_ENABLED/);
    assert.match(health, /enabled: true,\s*\n\s*lastSuccessAt: successRow\?\.value \|\| null,/);
    const vercel = JSON.parse(readFileSync(join(repoRoot, "vercel.json"), "utf8")) as {
        crons: Array<{ path: string }>;
    };
    assert.ok(vercel.crons.some(c => c.path === "/api/cron/bank-register-pull"), "which is true because the cron is scheduled");
});

test("the evidence upper bound is EXCLUSIVE and in the company timezone", () => {
    // `lte: <UTC midnight>` silently excluded most of the last allowed day: a
    // receipt filed at 2pm on the 18th sat after 2026-08-18T00:00:00Z and was
    // invisible, so its charge got chased.
    const source = readFileSync(join(repoRoot, "src/app/api/cron/receipt-requests/route.ts"), "utf8");
    assert.match(source, /export function evidenceBoundsFor\(fromYmd: string, toYmd: string, zone: string\)/);
    assert.match(source, /return evidenceBoundsFor\(fromYmd, toYmd, await resolveCompanyTimeZone\(\)\);/);
    assert.match(source, /lt: startOfDateInTimeZone\(dayAfter, zone\)/);
    // No caller may still use an inclusive upper bound on evidence.
    assert.doesNotMatch(source, /date: \{ gte: from, lte: to \}/);
    assert.doesNotMatch(source, /txnDate: \{ gte: from, lte: to \}/);
    // Each column gets the bound for ITS type — see the DB-level boundary test
    // in receipt-requests-idempotency.test.ts.
    assert.match(source, /where: \{ date: range\.timestamp \}/);
    assert.match(source, /where: \{ txnDate: range\.calendar, state:/);
});

test("open issues get their OWN pass, independent of the cursor", () => {
    const source = readFileSync(join(repoRoot, "src/app/api/cron/receipt-requests/route.ts"), "utf8");
    // The pass runs BEFORE the cursor is even read.
    const passAt = source.indexOf("const openPass:");
    const cursorAt = source.indexOf("let cursor = await readCursor();");
    assert.ok(passAt > 0 && cursorAt > passAt, "closing must not wait for the cursor to lap round");
    // And they are no longer bolted onto every batch.
    assert.doesNotMatch(source, /const openIssueLineRows =/);
});

test("?continue=1 only resumes; with no cursor it exits immediately", () => {
    const source = readFileSync(join(repoRoot, "src/app/api/cron/receipt-requests/route.ts"), "utf8");
    assert.match(source, /const continueOnly = new URL\(request\.url\)\.searchParams\.get\("continue"\) === "1";/);
    assert.match(source, /skipped: "nothing-in-progress"/);
    // Checked BEFORE the lease, so a no-op resume cannot block the real run.
    const gateAt = source.indexOf('skipped: "nothing-in-progress"');
    const leaseAt = source.indexOf("await takeLease(LEASE_KEY");
    assert.ok(gateAt > 0 && leaseAt > gateAt);

    const vercel = JSON.parse(readFileSync(join(repoRoot, "vercel.json"), "utf8")) as {
        crons: Array<{ path: string; schedule: string }>;
    };
    assert.equal(vercel.crons.find(c => c.path === "/api/cron/receipt-requests")?.schedule, "0 13 * * *");
    assert.equal(vercel.crons.find(c => c.path === "/api/cron/receipt-requests?continue=1")?.schedule, "*/15 * * * *");
});

test("reconciliation always runs; minting needs a fresh, conflict-free pull", () => {
    const lib = readFileSync(join(repoRoot, "src/lib/bank-register-pull.ts"), "utf8");
    // No early return that would skip the backlog on an empty fetch.
    assert.doesNotMatch(lib, /if \(lines\.length === 0\) return summary;/);
    assert.match(lib, /const mintIsSafe = summary\.ok && summary\.complete && !fetched\.stale && conflicts\.length === 0;/);
    assert.match(lib, /summary\.mintSkipped = fetched\.stale\s*\n\s*\? "stale-fetch"/);
    // A truncated window has its own reason, distinct from a failed ingest.
    assert.match(lib, /\? "incomplete-window"/);
});

test("the lease release is a single fenced statement", () => {
    // A read-then-write release can clear a lease someone else has since taken.
    const source = readFileSync(join(repoRoot, "src/lib/cron-lease.ts"), "utf8");
    assert.match(source, /updateMany\(\{\s*\n\s*where: \{ key, value: \{ contains: `"token":"\$\{token\}"` \} \}/);
    assert.doesNotMatch(source, /const held = parse\(existing\.value\);\s*\n\s*if \(held\?\.token !== token\) return;/);
});

test("cards write POSTING before the webhook and never repost an uncertain row", () => {
    const source = readFileSync(join(repoRoot, "src/app/api/cron/receipt-request-cards/route.ts"), "utf8");
    const markAt = source.indexOf('data: { status: "POSTING", itemsJson: JSON.stringify(card.items) }');
    const postAt = source.indexOf("const result = await postOwnerCard(webhookUrl, card);");
    assert.ok(markAt > 0 && postAt > markAt, "POSTING must be written BEFORE the call");
    // A post that succeeded but whose completion write lost is UNCERTAIN.
    assert.match(source, /if \(completed\.count === 0\) \{[\s\S]{0,200}status: "UNCERTAIN"/);
    // A row found in POSTING is reconciled, not resent.
    assert.match(source, /if \(existing\.status === "POSTING"\)/);
    assert.match(source, /if \(existing\.status === "UNCERTAIN"\) \{ uncertain\.push\(owner\); continue; \}/);
    // A REFUSED send is a known failure and goes back to PENDING for the retry.
    assert.match(source, /status: "PENDING",\s*\n\s*attempts: \{ increment: 1 \}/);
});

test("cost codes must be a phase of the job, in all three write paths", () => {
    for (const [label, file, needle] of [
        ["intake route", "src/app/api/receipts/intake/route.ts", /isCostCodeAllowedForProject\(/],
        ["setReceiptIntakeJob", "src/lib/actions.ts", /isCostCodeAllowedForProject\(prismaPhaseDataSource, projectId, costCodeId\)/],
        ["worker suggestions", "src/app/api/cron/receipt-intake-worker/route.ts", /resolveProjectPhaseCodes\(prismaPhaseDataSource, projectId\)/],
    ] as const) {
        assert.match(readFileSync(join(repoRoot, file), "utf8"), needle, label);
    }
    // Moving the job clears a code that is not valid for the new one.
    const actions = readFileSync(join(repoRoot, "src/lib/actions.ts"), "utf8");
    assert.match(actions, /costCodeId: costCodeId \?\? \(keepExisting \? existing!\.costCodeId : null\)/);
    assert.match(actions, /suggestedCostCodeId: null/);
});

test("an ACTIVE claim on a POSTING row is honoured; only an EXPIRED one goes UNCERTAIN", () => {
    // Converting an in-flight row would pull it out from under a healthy run
    // and lose the thread ids it is about to write.
    const source = readFileSync(join(repoRoot, "src/app/api/cron/receipt-request-cards/route.ts"), "utf8");
    assert.match(source, /const claimLive = existing\.claimedAt !== null/);
    assert.match(source, /if \(claimLive\) \{[\s\S]{0,600}inFlight\.push\(owner\);/);
    // The UNCERTAIN conversion sits AFTER that guard, on the expired path.
    const liveAt = source.indexOf("if (claimLive) {");
    const convertAt = source.indexOf('data: { status: "UNCERTAIN", lastError: "uncertain-delivery"');
    assert.ok(liveAt > 0 && convertAt > liveAt);
});

test("only a REJECTED send returns to PENDING; UNKNOWN is never auto-retried", () => {
    const source = readFileSync(join(repoRoot, "src/app/api/cron/receipt-request-cards/route.ts"), "utf8");
    assert.match(source, /if \(result\.kind === "rejected"\) \{[\s\S]{0,600}status: "PENDING"/);
    assert.match(source, /if \(result\.kind === "unknown"\) \{[\s\S]{0,700}status: "UNCERTAIN"/);
    // An unknown outcome must never be handed back to the retry pass.
    const unknownAt = source.indexOf('if (result.kind === "unknown")');
    const block = source.slice(unknownAt, unknownAt + 700);
    assert.doesNotMatch(block, /status: "PENDING"/, "an unknown send is not retryable");
});

test("open issues are paged with their OWN cursor and budget", () => {
    const source = readFileSync(join(repoRoot, "src/app/api/cron/receipt-requests/route.ts"), "utf8");
    assert.match(source, /const OPEN_ISSUE_BATCH_SIZE = 100;/);
    assert.match(source, /const OPEN_CURSOR_KEY = "receiptRequestsOpenIssueCursor";/);
    assert.notEqual(
        source.indexOf('const OPEN_CURSOR_KEY'),
        source.indexOf('const CURSOR_KEY'),
        "sharing one cursor would make each pass corrupt the other's resume point",
    );
    // Same wall clock as the line pass, and it never checkpoints past a failure
    // or an unresolved contended component.
    assert.match(source, /while \([^)]*Date\.now\(\) - startedAt < RUN_BUDGET_MS\)[\s\S]{0,400}reviewIssue\.findMany/);
    assert.match(source, /if \(pageErrors > 0 \|\| pageContended > 0\) break;[\s\S]{0,200}openCursor = page\[page\.length - 1\]\.id;/);
});

test("an issue whose BankLine is gone is CLOSED as target-missing", () => {
    // The matcher has nothing to match, so it would be skipped — and nag —
    // forever. A deleted or re-imported statement line really happens.
    const source = readFileSync(join(repoRoot, "src/app/api/cron/receipt-requests/route.ts"), "utf8");
    assert.match(source, /const orphaned = page\.filter\(issue => !present\.has\(issue\.targetKey\)\)/);
    assert.match(source, /resolution: "target-missing"/);
    // Closed with EMPTY codes — that is the lifecycle's clear step.
    assert.match(source, /issue\.targetKey,\s*\n\s*\[\],\s*\n\s*\{ \.\.\.details, resolution: "target-missing" \}/);
});

test("a cursor write failure is a 500, never ok:true", () => {
    const source = readFileSync(join(repoRoot, "src/app/api/cron/receipt-requests/route.ts"), "utf8");
    assert.match(source, /class CursorWriteError extends Error/);
    assert.match(source, /throw new CursorWriteError\(message\);/);
    assert.match(source, /if \(error instanceof CursorWriteError\)[\s\S]{0,300}status: 500/);
    assert.match(source, /error: "cursor-write-failed"/);
    // Every checkpoint fails the same way.
    const throws = source.match(/throw new CursorWriteError\(message\);/g) ?? [];
    assert.equal(throws.length, 3, "the line cursor, the open-issue cursor, and the phase");
});

test("the bank pull plans its window from a persisted high-water mark", () => {
    const source = readFileSync(join(repoRoot, "src/app/api/cron/bank-register-pull/route.ts"), "utf8");
    assert.match(source, /const WINDOW_STATE_KEY = "bankRegisterPullWindow";/);
    assert.match(source, /const PULL_BUDGET_MS = 50_000;/);
    assert.match(source, /windowState,\s*\n\s*saveWindowState,\s*\n\s*budgetMs: PULL_BUDGET_MS,/);
    // A corrupt state plans the WIDEST safe window, never a narrow one.
    assert.match(source, /return \{ highWater: null, lastFullSweep: null, continueAfter: null \};/);
});

test("a descriptor-only difference is NOT a restatement", () => {
    // When the pull stopped appending the QBO transaction type, every
    // observation stored in the old format hashed differently from the same
    // transaction re-read today — so the ingest 409'd and the nightly pull
    // stalled on rows that had not changed at all.
    const oldFormat = {
        postedDate: "2026-08-16", amountCents: -12_345,
        rawDescriptor: "LOWES #02516 Expense", checkNumber: null,
    };
    const newFormat = { ...oldFormat, rawDescriptor: "LOWES #02516 POS DEB C#8516" };
    assert.equal(
        computeQboLineContentHash(oldFormat), computeQboLineContentHash(newFormat),
        "same amount, date, check# and canonical payee = same transaction",
    );
    assert.equal(isDescriptorOnlyChange(oldFormat, newFormat), true);

    // A REAL restatement still is one.
    for (const changed of [
        { ...newFormat, amountCents: -99_999 },
        { ...newFormat, postedDate: "2026-08-17" },
        { ...newFormat, checkNumber: "1027" },
        { ...newFormat, rawDescriptor: "HOME DEPOT #4718" },
    ]) {
        assert.notEqual(computeQboLineContentHash(oldFormat), computeQboLineContentHash(changed));
        assert.equal(isDescriptorOnlyChange(oldFormat, changed), false);
    }
    // Identical text is not a "change" either.
    assert.equal(isDescriptorOnlyChange(newFormat, newFormat), false);
});

test("the ingest refreshes an old-format descriptor in place instead of 409ing", () => {
    const source = readFileSync(join(repoRoot, "src/app/api/integrations/bank-ledger/ingest/route.ts"), "utf8");
    assert.match(source, /if \(isDescriptorOnlyChange\(priorContent, line\)\)/);
    assert.match(source, /refreshQboDescriptors\(account, refreshDescriptors\)/);
    // The 409 is still there for a genuine identity change.
    assert.match(source, /reason: "qbo-txn-conflict"/);
});

test("?continue=1 and moreToProcess consult BOTH cursors", () => {
    // The sweep has two independent passes with two resume points; asking only
    // about the line cursor made a half-finished OPEN-ISSUE pass look like
    // nothing in progress.
    const source = readFileSync(join(repoRoot, "src/app/api/cron/receipt-requests/route.ts"), "utf8");
    assert.match(source, /const \[phase, lineCursor, openCursor\] = await Promise\.all\(\[readPhase\(\), readCursor\(\), readOpenCursor\(\)\]\);/);
    // ...and the PHASE, because each cursor is cleared the moment its pass
    // finishes, so a cycle can be unfinished with neither one parked.
    assert.match(source, /if \(!shouldResumeSweep\(phase, lineCursor, openCursor\)\)/);
    assert.match(source, /moreToProcess: !exhausted \|\| !openExhausted/);
});

test("queue actions CAS on the state the submitted view saw", () => {
    const source = readFileSync(join(repoRoot, "src/lib/actions.ts"), "utf8");
    assert.match(source, /function assertExpectedState\(expectedState: string\)/);
    // Exactly that state, not an allowed-set — a row can be NEEDS_REVIEW twice
    // with a whole booking attempt in between.
    for (const call of [
        /setReceiptIntakeJob\(id: string, projectId: string, expectedState: string/,
        /markReceiptIntakeDuplicate\(id: string, duplicateOfId: string, expectedState: string, expectedUpdatedAt: string\)/,
        /voidReceiptIntake\(id: string, expectedState: string, expectedUpdatedAt: string\)/,
    ]) {
        assert.match(source, call);
    }
    // ...and on the row VERSION too, because the same state twice over is not
    // the same row (see tests/receipt-intake-park.test.ts for the ABA case).
    assert.match(source, /where: \{ id, state: expected, updatedAt: seenAt, \.\.\.notClaimedByWorker\(now\) \}/);
    assert.doesNotMatch(source, /where: \{ id, state: \{ in: allowed \}/, "the allowed-set CAS is gone");
});

test("a duplicate target must be a real original, and cycles are refused", () => {
    const source = readFileSync(join(repoRoot, "src/lib/actions.ts"), "utf8");
    assert.match(source, /if \(original\.state === "DUPLICATE"\) throw/);
    assert.match(source, /if \(original\.state === "VOID"\) throw/);
    assert.match(source, /if \(original\.duplicateOfId === id\) throw/);
});

// ── A signed memo needs a durable artifact (round-11 item 6) ────────────────

test("signed:true with no verifiable artifact is a 422 that writes nothing", async () => {
    // `signed:true` on its own used to close the chase, so a truncated or
    // malformed forwarder row silenced a genuinely missing receipt and left
    // nothing behind a human could open. These requests are refused BEFORE any
    // read or write — the route never reaches Prisma on this path.
    // The BRIDGE key now, not the intake one — see receipt-bridge-secret.test.ts.
    process.env.RECEIPT_INTAKE_SECRET = "test-intake-secret";
    process.env.RECEIPT_ARCHIVE_SECRET = "test-archive-secret";
    process.env.RECEIPT_BRIDGE_SECRET = "test-bridge-secret";
    const { POST } = await import("../src/app/api/automation/receipt-requests/answers/route");

    const post = (body: Record<string, unknown>) => POST(new Request(
        "https://probuild.test/api/automation/receipt-requests/answers",
        {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-receipt-intake-secret": "test-bridge-secret",
            },
            body: JSON.stringify(body),
        },
    ));

    // A signed memo must carry a Drive FILE ID. None of these is one, and none
    // of them reaches Drive or the database: 422, because re-sending the same
    // body would fail the same way (see receipt-answers-drive.test.ts for the
    // three Drive outcomes).
    for (const [label, body] of [
        ["no artifact at all", { fingerprint: "pb-bl-1", signed: true }],
        ["the gate's own example", { fingerprint: "pb-bl-1", signed: true, pdf_id: "x" }],
        ["a URL where the id goes", { fingerprint: "pb-bl-1", signed: true, pdf_id: "https://drive.google.com/file/d/1abc/view" }],
        ["a URL and no id", { fingerprint: "pb-bl-1", signed: true, pdf_url: "https://drive.google.com/file/d/1abc/view" }],
        ["a signature id, which is no longer accepted", { fingerprint: "pb-bl-1", signed: true, signature_id: "sig-123" }],
    ] as const) {
        const res = await post(body);
        assert.equal(res.status, 422, label);
        const payload = await res.json() as { ok: boolean; reason: string; targetKey: string };
        assert.equal(payload.ok, false, label);
        assert.equal(payload.reason, "missing-artifact", label);
        assert.equal(payload.targetKey, "bl-1", label);
    }

    // Unauthenticated is still 401, and a row that is not a signature is still
    // an ignore rather than an error — neither path reaches the artifact gate.
    const unauth = await POST(new Request("https://probuild.test/api/automation/receipt-requests/answers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fingerprint: "pb-bl-1", signed: true }),
    }));
    assert.equal(unauth.status, 401);

    const notSigned = await post({ fingerprint: "pb-bl-1", signed: false });
    assert.equal(notSigned.status, 200);
    assert.deepEqual(await notSigned.json(), { ok: true, ignored: true, reason: "not-a-signature" });

    // Beverly's own fingerprints are still ignored, not 400'd: the forwarder
    // ships one file for both systems and must not retry forever on rows that
    // were never ours.
    const notOurs = await post({ fingerprint: "bev-42", signed: true });
    assert.equal(notOurs.status, 200);
    assert.deepEqual(await notOurs.json(), { ok: true, ignored: true });
});

test("the card snapshot is re-verified under the claim, immediately before the send", () => {
    const source = readFileSync(join(repoRoot, "src/app/api/cron/receipt-request-cards/route.ts"), "utf8");
    // Rebuild -> (cancel | POSTING) -> post. In that order, inside the loop
    // that already holds the claim token.
    const rebuildAt = source.indexOf("const rebuilt = rebuildCardItems(claimedCard.items, truth, claimedCard.owner);");
    const markAt = source.indexOf('data: { status: "POSTING", itemsJson: JSON.stringify(card.items) }');
    const postAt = source.indexOf("const result = await postOwnerCard(webhookUrl, card);");
    assert.ok(rebuildAt > 0 && markAt > rebuildAt && postAt > markAt);
    // The truth is read fresh, not carried from the selection scan.
    assert.match(source, /async function loadCardItemTruth\(issueIds: string\[\]\)/);
    assert.match(source, /where: \{ id: \{ in: issueIds \} \}/);
    // An empty rebuild DELETES the row, so the owner's day is not consumed by
    // a slot that can never be posted.
    assert.match(source, /if \(rebuilt\.items\.length === 0\) \{[\s\S]{0,600}deleteMany\(\{\s*\n\s*where: \{ id: rowId, claimToken: token, postedAt: null \}/);
    // The retry pass goes through the SAME loop, so it rebuilds too: it posts
    // from `toPost`, which every path feeds.
    assert.match(source, /for \(const \{ card: claimedCard, rowId, token, resumed \} of toPost\.slice\(0, CARD_RATE_CEILING\)\)/);
});

test("mint-then-refresh: the canonical line's descriptor moves with the observation", () => {
    // THE BUG, end to end. The pull mints a canonical BankLine from a QBO
    // observation, copying its descriptor. Later the pull stops appending the
    // transaction type, so the observation refreshes to the real bank text —
    // the one carrying `C#8516` — while the minted line keeps the tail-less
    // copy. The chaser reads the LINE, so the charge resolves to `office`, and
    // the crew is never asked for that receipt.
    const source = readFileSync(join(repoRoot, "src/app/api/integrations/bank-ledger/ingest/route.ts"), "utf8");
    const refresh = source.slice(source.indexOf("refreshQboDescriptors: async (account, rows) =>"));
    const body = refresh.slice(0, refresh.indexOf("\n    createQboObservations:"));

    // Both writes in ONE transaction — half of this landing is the same bug.
    assert.match(body, /await prisma\.\$transaction\(async tx => \{/);
    assert.match(body, /tx\.bankLineObservation\.updateMany\(/);
    assert.match(body, /tx\.bankLine\.updateMany\(/);
    // NARROW: QBO-owned, unmatched, and the sole observation on that line.
    assert.match(body, /where: \{ id: lineId, sourceOfRecord: "QBO", state: "POSTED" \}/);
    assert.match(body, /if \(observationCount !== 1\) continue;/);
    // The derived payee is re-derived, or the disagreement just moves columns.
    assert.match(body, /normalizedPayee: bankLineIdentityPayee\(\{ memo: row\.rawDescriptor \}\)/);
});

test("and the refreshed descriptor is what gives the chaser the card tail", () => {
    // The observable consequence, not the mechanism: the old text resolves to
    // nobody, the refreshed text resolves to the person who spent the money.
    const stale = "LOWES #02516 Expense";
    const refreshed = "LOWES #02516 POS DEB C#8516";
    assert.equal(resolveReceiptOwner(stale).cardTail, null, "no tail: nobody is asked");
    assert.equal(resolveReceiptOwner(refreshed).cardTail, "8516");
    assert.notEqual(resolveReceiptOwner(refreshed).owner, resolveReceiptOwner(stale).owner);
    // And both texts are still the SAME transaction, so the refresh is not a
    // restatement — that is what makes updating in place legitimate.
    assert.equal(
        computeQboLineContentHash({ postedDate: "2026-08-16", amountCents: -12_345, rawDescriptor: stale, checkNumber: null }),
        computeQboLineContentHash({ postedDate: "2026-08-16", amountCents: -12_345, rawDescriptor: refreshed, checkNumber: null }),
    );
});


// -- The refresh takes the identity lock (round-17 item 2) -----------------

test("the descriptor refresh takes the identity lock before touching identity", () => {
    // Minting and statement adoption both plan under BANK_LINE_IDENTITY_LOCK
    // precisely so no two writers see different versions of an identity. This
    // refresh rewrites rawDescriptor AND normalizedPayee, so without the lock
    // it is a third writer outside that agreement: an adoption planned from the
    // OLD payee commits against the NEW one, matches nothing, and mints a
    // SECOND canonical line for a transaction that already had one - and
    // amountCents is immutable by trigger, so only a human can unpick it.
    const source = readFileSync(join(repoRoot, "src/app/api/integrations/bank-ledger/ingest/route.ts"), "utf8");
    const fn = source.slice(source.indexOf("refreshQboDescriptors: async (account, rows) =>"));
    const body = fn.slice(0, fn.indexOf("createQboObservations:"));
    const lockAt = body.indexOf("pg_advisory_xact_lock");
    const readAt = body.indexOf("tx.bankLineObservation.updateMany(");
    const lineAt = body.indexOf("tx.bankLine.updateMany(");
    assert.ok(lockAt > 0, "the refresh must take the lock");
    assert.ok(readAt > lockAt, "before it reads or writes the observation");
    assert.ok(lineAt > lockAt, "and before it rewrites the canonical identity");
    // $executeRaw, not $queryRaw: the lock function returns void.
    assert.match(body, /await tx\.\$executeRaw`SELECT pg_advisory_xact_lock\(hashtext\(\$\{BANK_LINE_IDENTITY_LOCK\}\)\)`;/);
    // The SAME lock the mint and adoption paths take - a different key would
    // exclude nobody.
    const pull = readFileSync(join(repoRoot, "src/app/api/cron/bank-register-pull/route.ts"), "utf8");
    assert.match(pull, /pg_advisory_xact_lock\(hashtext\(\$\{BANK_LINE_IDENTITY_LOCK\}\)\)/);
});

// -- A truncated mint is not a complete run (item 4) -----------------------

test("mintFromQbo reports truncation, and a truncated run stamps nothing", () => {
    const route = readFileSync(join(repoRoot, "src/app/api/cron/bank-register-pull/route.ts"), "utf8");
    // Three exits, and only one of them is "finished".
    assert.match(route, /return \{ minted, skipped, complete: true, remainingCursor: null \};/);
    assert.match(route, /return \{ minted, skipped, complete: false, remainingCursor: "deadline" \};/);
    assert.match(route, /return \{ minted, skipped, complete: false, remainingCursor \};/);
    // The batch cap is a truncation too - falling out of the loop is not done.
    assert.match(route, /const MINT_MAX_BATCHES = 10;/);
    assert.match(route, /remainingCursor = result\.nextId;/);
    // The freshness clock needs a run that was BOTH clean and whole.
    assert.match(route, /if \(summary\.ok && summary\.complete && ambiguousCount === 0\) \{[\s\S]{0,400}BANK_PULL_LAST_SUCCESS_KEY/);
    // And the cursor is persisted, so a backlog that is not draining is visible.
    assert.match(route, /mintRemainingCursor: typeof parsed\.mintRemainingCursor === "string"/);

    const lib = readFileSync(join(repoRoot, "src/lib/bank-register-pull.ts"), "utf8");
    assert.match(lib, /if \(summary\.minted && summary\.minted\.complete === false\) \{[\s\S]{0,200}summary\.complete = false;/);
    assert.match(lib, /mintRemainingCursor: summary\.minted\?\.remainingCursor \?\? null,/);
});
