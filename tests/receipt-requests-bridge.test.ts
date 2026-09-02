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
