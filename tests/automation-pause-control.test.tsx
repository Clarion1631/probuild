/**
 * THE PAUSE TOGGLE MUST SURVIVE THE BANK-ONLY CUTOVER.
 *
 * `receiptPushPaused` is one DB setting governing two rails: the QuickBooks
 * push, and (with RECEIPT_BOOK_NATIVE) ProBuild booking the Expense itself.
 * Booking consults it on BOTH, so it is the only brake on receipts reaching job
 * cost that works without a redeploy.
 *
 * The control rendered its switch only when `QBO_RECEIPT_PUSH_ENABLED` was
 * true, and native booking runs precisely when that env is FALSE — so the brake
 * lost its button in the one configuration that needs it most, leaving a static
 * "Off by deployment" badge on a pipeline that was booking every receipt.
 *
 * Rendered rather than source-asserted (the precedent in this repo is
 * tests/qbo-expense-sync-ui.test.tsx): what matters is what an admin can click.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
// The control calls `useRouter` (to refresh after a flip), which throws
// outside an app-router context. Supplied here rather than mocked: CI is Node
// 20, where `mock.module` corrupts the require chain.
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import PipelineControls from "../src/app/automation/components/pipeline-controls";

const ROUTER = {
    refresh: () => {}, push: () => {}, replace: () => {},
    back: () => {}, forward: () => {}, prefetch: () => {},
} as never;

function render(over: {
    pushEnabled?: boolean;
    nativeBookingEnabled?: boolean;
    receiptPushPaused?: boolean;
    isAdmin?: boolean;
} = {}) {
    return renderToStaticMarkup(
        createElement(AppRouterContext.Provider, { value: ROUTER },
            createElement(PipelineControls, {
                pushEnabled: false,
                nativeBookingEnabled: false,
                syncCronEnabled: true,
                receiptPushPaused: false,
                qboSyncPaused: false,
                isAdmin: true,
                ...over,
            }),
        ),
    );
}

/** The receipt row only — the QuickBooks->ProBuild sync row is a separate control. */
function receiptRow(markup: string): string {
    const next = markup.indexOf("QuickBooks → ProBuild sync");
    return next === -1 ? markup : markup.slice(0, next);
}

test("PUSH OFF + NATIVE ON: the pause switch is rendered, and says what it pauses", () => {
    const row = receiptRow(render({ pushEnabled: false, nativeBookingEnabled: true }));

    assert.match(row, /role="switch"/, "an admin can actually pause it");
    assert.doesNotMatch(row, /Off by deployment/);
    // The copy has to be true: nothing goes to QuickBooks on this rail.
    assert.match(row, /Receipt booking in ProBuild/);
    assert.match(row, /ProBuild books receipts to job costing itself and nothing is sent to QuickBooks\./);
    assert.match(row, /Pause stops booking, and receipts keep arriving and wait\./);
    assert.doesNotMatch(row, /drop straight into QuickBooks/, "that is the other rail's promise");
    // And the switch names the same rail.
    assert.match(row, /aria-label="Pause receipt booking in ProBuild"/);
});

test("BOTH OFF: nothing is booking, so the badge stays", () => {
    const row = receiptRow(render({ pushEnabled: false, nativeBookingEnabled: false }));
    assert.match(row, /Off by deployment/);
    assert.doesNotMatch(row, /role="switch"/, "there is nothing to pause");
});

test("PUSH ON: today's control and today's wording, unchanged", () => {
    const row = receiptRow(render({ pushEnabled: true, nativeBookingEnabled: false }));
    assert.match(row, /role="switch"/);
    assert.match(row, /Receipt → QuickBooks push/);
    assert.match(row, /Receipts drop straight into QuickBooks as they&#x27;re scanned\./);
    assert.doesNotMatch(row, /Receipt booking in ProBuild/);

    // The push outranks the flag: native booking is unreachable while the push
    // is live (book.ts only takes that branch when isPushEnabled is false), so
    // the row must not start claiming ProBuild is booking.
    const both = receiptRow(render({ pushEnabled: true, nativeBookingEnabled: true }));
    assert.match(both, /Receipt → QuickBooks push/);
    assert.doesNotMatch(both, /Receipt booking in ProBuild/);
});

test("the paused state reads as paused on the native rail too", () => {
    const row = receiptRow(render({ nativeBookingEnabled: true, receiptPushPaused: true }));
    assert.match(row, /Paused/);
    assert.match(row, /aria-checked="false"/);
    assert.match(row, /aria-label="Resume receipt booking in ProBuild"/);
});

test("the page passes the flag the control needs, read from RECEIPT_BOOK_NATIVE", async () => {
    // The control is only as live as its props. `/automation` is a server
    // component with a database on every path, so the wiring is pinned at the
    // source rather than rendered.
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const dir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
    const page = readFileSync(path.join(dir, "..", "src/app/automation/page.tsx"), "utf8");
    assert.match(page, /const nativeBookingEnabled = process\.env\.RECEIPT_BOOK_NATIVE === "true";/);
    assert.match(page, /nativeBookingEnabled=\{nativeBookingEnabled\}/);

    const health = readFileSync(
        path.join(dir, "..", "src/app/automation/components/pipeline-health.tsx"), "utf8",
    );
    assert.match(health, /nativeBookingEnabled=\{nativeBookingEnabled\}/, "and it reaches the control");
});

test("the pause API does not itself refuse while the QuickBooks push is off", async () => {
    // The button would be pointless if the write path still gated on the env
    // var. It gates on the ROLE and on a known setting key, and nothing else.
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const dir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
    const route = readFileSync(
        path.join(dir, "..", "src/app/api/automation/settings/route.ts"), "utf8",
    );
    assert.doesNotMatch(route, /QBO_RECEIPT_PUSH_ENABLED/);
    assert.doesNotMatch(route, /RECEIPT_BOOK_NATIVE/);
    assert.match(route, /isAdminOrManager\(user\)/);
});
