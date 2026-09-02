import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
    ORPHAN_AUDIT_KIND,
    ORPHAN_RESOLUTIONS,
    isQboPurchaseId,
    verifyOrphanClaim,
} from "../src/lib/receipt-intake/orphan-purchase";
import {
    chatSpaceOf,
    isChatMessageName,
    isChatThreadName,
    parseChatDelivery,
} from "../src/lib/receipt-request-cards";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── "Mark delivered" needs the thread identity (round-14 item 2) ────────────

test("a delivered card must carry BOTH Chat names, from the same space", () => {
    const thread = "spaces/AAQAKhvMYtg/threads/xyz-123";
    const message = "spaces/AAQAKhvMYtg/messages/xyz-123.abc-456";
    assert.deepEqual(parseChatDelivery(thread, message), { threadName: thread, messageName: message });

    for (const [label, t, m] of [
        ["no thread", "", message],
        ["no message", thread, ""],
        ["a thread pasted into the message box", thread, thread],
        ["a message pasted into the thread box", message, message],
        ["a bare space", "spaces/AAQAKhvMYtg", message],
        ["a URL rather than a resource name", "https://chat.google.com/room/AAQAKhvMYtg", message],
        ["whitespace only", "   ", "   "],
        ["two DIFFERENT spaces", thread, "spaces/AAQAOther/messages/xyz-123"],
        ["not strings", null, undefined],
    ] as const) {
        assert.equal(parseChatDelivery(t, m), null, label);
    }
    // Surrounding whitespace is a paste artefact, not a mistake.
    assert.deepEqual(parseChatDelivery(`  ${thread} `, ` ${message}  `), { threadName: thread, messageName: message });
});

test("the two Chat name shapes are not interchangeable", () => {
    assert.equal(isChatThreadName("spaces/A/threads/1"), true);
    assert.equal(isChatThreadName("spaces/A/messages/1"), false);
    assert.equal(isChatMessageName("spaces/A/messages/1"), true);
    assert.equal(isChatMessageName("spaces/A/threads/1"), false);
    assert.equal(chatSpaceOf("spaces/AAQAKhvMYtg/threads/x"), "AAQAKhvMYtg");
    assert.equal(chatSpaceOf("nonsense"), null);
});

test("no thread identity means the card STAYS uncertain", () => {
    const actions = readFileSync(join(repoRoot, "src/lib/actions.ts"), "utf8");
    // The refusal comes BEFORE the write, and it is not a "stale" verdict —
    // nothing changed underneath them, they just have to paste the names.
    assert.match(actions, /const confirmed = decision === "delivered"\s*\n\s*\? parseChatDelivery\(delivery\?\.threadName, delivery\?\.messageName\)/);
    assert.match(actions, /if \(decision === "delivered" && !confirmed\) \{[\s\S]{0,400}stale: false as const/);
    // POSTED is written only on the confirmed branch, and it carries the names.
    assert.match(actions, /data: confirmed\s*\n\s*\? \{\s*\n\s*status: "POSTED"/);
    assert.match(actions, /threadName: confirmed\.threadName,\s*\n\s*messageName: confirmed\.messageName,/);
});

// ── The unknown-ID orphan (round-14 item 3) ────────────────────────────────

test("a located purchase must match this receipt's amount, to the cent", () => {
    // The operator is reading a list in one window and typing an id into
    // another. A transposed digit lands on somebody else's purchase, and
    // recording it would attach this receipt's history to theirs.
    assert.deepEqual(verifyOrphanClaim({ id: "6625", totalCents: 12_345 }, 12_345), { ok: true, purchaseId: "6625" });

    const off = verifyOrphanClaim({ id: "6625", totalCents: 12_344 }, 12_345);
    assert.equal(off.ok, false);
    if (!off.ok) {
        assert.equal(off.reason, "amount-mismatch");
        assert.match(off.detail ?? "", /123\.44[\s\S]*123\.45/, "the message names both amounts");
    }

    // A 404 from QBO is an ANSWER — that id is not a purchase here.
    assert.deepEqual(verifyOrphanClaim(null, 12_345), { ok: false, reason: "not-found" });
    // And anything we cannot check is refused rather than trusted.
    assert.equal(verifyOrphanClaim({ id: "1", totalCents: null }, 12_345).ok, false);
    assert.equal(verifyOrphanClaim({ id: "1", totalCents: 12_345 }, null).ok, false);
});

test("a purchase id is digits — a paste error is not a lookup", () => {
    for (const good of ["1", "6625", "00042"]) assert.equal(isQboPurchaseId(good), true, good);
    for (const bad of ["", "  ", "abc", "66-25", "6625; DROP", "1e5", null, undefined, 6625]) {
        assert.equal(isQboPurchaseId(bad), false, String(bad));
    }
});

test("both answers are audited, and only ONE of them frees the dedup key", () => {
    const actions = readFileSync(join(repoRoot, "src/lib/actions.ts"), "utf8");
    // "located": the id is recorded where the known-id flow reads it, and the
    // key stays HELD — a purchase exists, so a re-send would double-book.
    assert.match(actions, /postVoidQbPurchaseId: purchaseId,/);
    // The located branch runs from `const data =` to the `:` that opens the
    // other one, and it must not mention the key at all.
    const dataAt = actions.indexOf("const data = purchaseId !== null");
    assert.ok(dataAt > 0);
    const elseAt = actions.indexOf("        : {", dataAt);
    assert.ok(elseAt > dataAt, "both branches must still be there");
    const locatedBranch = actions.slice(dataAt, elseAt);
    assert.match(locatedBranch, /postVoidQbPurchaseId: purchaseId,/);
    assert.doesNotMatch(locatedBranch, /dedupStrongKey/, "a purchase EXISTS — freeing the key would double-book it");
    // "no-purchase": nothing exists, so the quarantine has nothing to protect.
    assert.match(actions, /dedupStrongKey: null,\s*\n\s*stateReason: `\$\{row\.stateReason \?\? "possible-orphan"\}; \$\{ORPHAN_RESOLUTIONS\.noPurchase\}`/);
    // AUDITED with who decided, after the write committed.
    assert.match(actions, /kind: ORPHAN_AUDIT_KIND,/);
    assert.match(actions, /decidedBy: user\.email \?\? user\.id,/);
    const writeAt = actions.indexOf("where: { id, state: row.state, updatedAt: seenAt }");
    const auditAt = actions.indexOf("kind: ORPHAN_AUDIT_KIND,");
    assert.ok(writeAt > 0 && auditAt > writeAt, "an event describing a decision that did not commit is worse than none");
    // QuickBooks stays READ-only.
    assert.match(actions, /const response = await qbFetch\(`\/purchase\/\$\{encodeURIComponent\(purchaseId\)\}`, tokens\);/);
    assert.doesNotMatch(actions, /qbFetch\([^)]*method: "POST"[^)]*purchase/i);
    assert.equal(ORPHAN_AUDIT_KIND, "receipt-orphan-resolution");
    assert.deepEqual(Object.values(ORPHAN_RESOLUTIONS), ["purchase-located", "no-purchase-exists"]);
});

test("the control is offered for BOTH orphan kinds", () => {
    const tab = readFileSync(join(repoRoot, "src/app/automation/components/receipts/receipts-tab.tsx"), "utf8");
    // Rendered unconditionally inside the Exceptions rows — the known-id block
    // above it is the one that is conditional.
    assert.match(tab, /<UnknownOrphanControls intakeId=\{row\.id\} expectedUpdatedAt=\{row\.updatedAt\} \/>/);
    const controlAt = tab.indexOf("<UnknownOrphanControls");
    const conditionalAt = tab.indexOf("{row.postVoidQbPurchaseId && (");
    assert.ok(conditionalAt > 0 && controlAt > conditionalAt, "it sits outside the known-id conditional");
});
