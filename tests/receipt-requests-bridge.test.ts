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

test("every bypassed machine endpoint refuses a Server Action dispatch", async () => {
    const { isMachineOnlyBypass, isPublicProxyBypass } = await loadProxy();
    for (const path of [
        "/api/automation/receipt-requests/threads",
        "/api/automation/receipt-requests/threads/",
        "/api/automation/receipt-requests/answers",
        "/api/automation/receipt-requests/answers/",
        // Phase 1's endpoints carry the identical hole; the fix is shared.
        "/api/receipts/intake",
        "/api/receipts/intake/",
        "/api/receipts/intake/abc123/archived",
        "/api/office-tasks/ingest",
    ]) {
        assert.equal(isMachineOnlyBypass(path), true, path);
        // Every one must ALSO be on the bypass — otherwise this guard is
        // protecting a path the proxy was never waving through anyway.
        assert.equal(isPublicProxyBypass(path), true, `${path} must be a bypass path`);
    }
});

test("the Server-Action refusal is exact-match — it neither over- nor under-reaches", async () => {
    const { isMachineOnlyBypass } = await loadProxy();
    for (const path of [
        "/api/receipts/intake/abc123",
        "/api/receipts/intake/abc123/archived/extra",
        "/api/office-tasks/ingest/extra",
        "/api/office-tasks",
        "/api/automation/receipt-requests",
        "/api/automation/receipt-requests/threads/extra",
        // Genuinely anonymous-action surfaces keep their bypass.
        "/portal/projects/abc",
        "/share/room/tok",
    ]) {
        assert.equal(isMachineOnlyBypass(path), false, path);
    }
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
