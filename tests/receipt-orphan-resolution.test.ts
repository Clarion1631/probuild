import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
    ORPHAN_AUDIT_KIND,
    ORPHAN_RESOLUTIONS,
    gtrFileMarker,
    isQboPurchaseId,
    markedFileId,
    verifyOrphanClaim,
} from "../src/lib/receipt-intake/orphan-purchase";
import { POSSIBLE_ORPHAN_REASON, UNKNOWN_ORPHAN_STATES } from "../src/lib/receipt-intake/park";
import {
    chatSpaceOf,
    isChatMessageName,
    isChatThreadName,
    parseChatDelivery,
} from "../src/lib/receipt-request-cards";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── "Mark delivered" needs the thread identity (round-14 item 2) ────────────

test("a delivered card must carry BOTH Chat names, from the same space", () => {
    // The space is now checked against configuration too — see
    // receipt-artifact-verification.test.ts for that half.
    const env = { RECEIPTS_CHAT_WEBHOOK: "https://chat.googleapis.com/v1/spaces/AAQAKhvMYtg/messages?key=k" };
    const thread = "spaces/AAQAKhvMYtg/threads/xyz-123";
    const message = "spaces/AAQAKhvMYtg/messages/xyz-123.abc-456";
    assert.deepEqual(parseChatDelivery(thread, message, env), { threadName: thread, messageName: message });

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
        assert.equal(parseChatDelivery(t, m, env), null, label);
    }
    // Surrounding whitespace is a paste artefact, not a mistake.
    assert.deepEqual(parseChatDelivery(`  ${thread} `, ` ${message}  `, env), { threadName: thread, messageName: message });
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

const FILE_ID = "1sEISJBJaGRYpivooQJBR";
const facts = (over: Partial<{ id: string; totalCents: number | null; privateNote: string | null }> = {}) => ({
    id: "6625",
    totalCents: 12_345,
    privateNote: `Receipt via ProBuild ${gtrFileMarker(FILE_ID)}`,
    ...over,
});

test("a located purchase must match this receipt's amount, to the cent", () => {
    // The operator is reading a list in one window and typing an id into
    // another. A transposed digit lands on somebody else's purchase, and
    // recording it would attach this receipt's history to theirs.
    assert.deepEqual(verifyOrphanClaim(facts(), 12_345, FILE_ID), { ok: true, purchaseId: "6625" });

    const off = verifyOrphanClaim(facts({ totalCents: 12_344 }), 12_345, FILE_ID);
    assert.equal(off.ok, false);
    if (!off.ok) {
        assert.equal(off.reason, "amount-mismatch");
        assert.match(off.detail ?? "", /123\.44[\s\S]*123\.45/, "the message names both amounts");
    }

    // A 404 from QBO is an ANSWER — that id is not a purchase here.
    assert.deepEqual(verifyOrphanClaim(null, 12_345, FILE_ID), { ok: false, reason: "not-found" });
    // And anything we cannot check is refused rather than trusted.
    assert.equal(verifyOrphanClaim(facts({ totalCents: null }), 12_345, FILE_ID).ok, false);
    assert.equal(verifyOrphanClaim(facts(), null, FILE_ID).ok, false);
});

test("a located purchase must carry THIS receipt's file marker", () => {
    // The amount alone is weak: this business posts several purchases for the
    // same amount to the same vendor in a week. Every Purchase the pipeline
    // creates says which document it came from, so one that says nothing was
    // not ours, and one that names another file is another receipt's.
    const noMarker = verifyOrphanClaim(facts({ privateNote: "Paid at the counter" }), 12_345, FILE_ID);
    assert.equal(noMarker.ok, false);
    if (!noMarker.ok) assert.equal(noMarker.reason, "marker-missing");

    const nullNote = verifyOrphanClaim(facts({ privateNote: null }), 12_345, FILE_ID);
    assert.equal(nullNote.ok, false);
    if (!nullNote.ok) assert.equal(nullNote.reason, "marker-missing");

    const otherFile = verifyOrphanClaim(facts({ privateNote: gtrFileMarker("some-other-file-id") }), 12_345, FILE_ID);
    assert.equal(otherFile.ok, false);
    if (!otherFile.ok) assert.equal(otherFile.reason, "marker-mismatch");

    // No file identity on our side is not a reason to accept on trust.
    assert.equal(verifyOrphanClaim(facts(), 12_345, null).ok, false);

    // The marker parser, on its own.
    assert.equal(markedFileId(`x ${gtrFileMarker("abc")} y`), "abc");
    assert.equal(markedFileId("no marker here"), null);
    assert.equal(markedFileId(null), null);
    // Amount is checked BEFORE the marker, so a wrong amount still reports as
    // a wrong amount rather than as a marker problem.
    const bothWrong = verifyOrphanClaim(facts({ totalCents: 1, privateNote: null }), 12_345, FILE_ID);
    assert.equal(bothWrong.ok, false);
    if (!bothWrong.ok) assert.equal(bothWrong.reason, "amount-mismatch");
});

test("the orphan write carries the WHOLE predicate, so a BOOKED row is untouchable", () => {
    // Re-checking in JavaScript proves what was true a moment ago. These
    // conditions can all change between the render and the click, so they
    // belong in the UPDATE — and a direct call against a BOOKED or ARCHIVED row
    // must change nothing even though the operator never saw such a row.
    const actions = readFileSync(join(repoRoot, "src/lib/actions.ts"), "utf8");
    const whereAt = actions.indexOf("const orphanWhere = {");
    assert.ok(whereAt > 0, "the predicate is one object, not scattered checks");
    const predicate = actions.slice(whereAt, actions.indexOf("};", whereAt));
    for (const clause of [
        /state: \{ in: \[\.\.\.UNKNOWN_ORPHAN_STATES\] \}/,
        /stateReason: \{ endsWith: `:\$\{POSSIBLE_ORPHAN_REASON\}` \}/,
        /sendAttempted: true/,
        /postVoidQbPurchaseId: null/,
        /claimToken: null/,
        /updatedAt: seenAt/,
    ]) {
        assert.match(predicate, clause);
    }
    // BOOKED and ARCHIVED are not in the permitted set, at all.
    assert.deepEqual([...UNKNOWN_ORPHAN_STATES], ["VOID", "DUPLICATE"]);
    for (const state of ["BOOKED", "ARCHIVED", "READ", "NEEDS_REVIEW", "BOOKING"]) {
        assert.ok(!UNKNOWN_ORPHAN_STATES.includes(state), `${state} is never an unknown-id orphan`);
    }
    // The write uses it, and a miss is a TYPED refusal rather than a generic one.
    assert.match(actions, /await prisma\.receiptIntake\.updateMany\(\{ where: orphanWhere, data \}\)/);
    assert.match(actions, /code: "not-an-unknown-orphan" as const/);
    // The only reason string that can reach the predicate is the one the park
    // plan writes.
    assert.equal(POSSIBLE_ORPHAN_REASON, "possible-orphan-purchase");
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
    const writeAt = actions.indexOf("updateMany({ where: orphanWhere, data })");
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
