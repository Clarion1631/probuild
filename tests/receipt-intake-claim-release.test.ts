/**
 * Ownership release.
 *
 * The worker claims a row by writing a claim token, and every write it makes
 * afterwards is fenced on {id, state, claimToken}. That fence is only half the
 * mechanism: a transition that COMPLETES the work must also hand the row back,
 * in the SAME write. Leave the token behind and the row is owned by a pass that
 * has finished — the next pass's CAS matches nothing, no other write can move
 * it, and it sits until a human notices. (The claim query skips rows that carry
 * a live token, which is what makes the leak permanent rather than a delay.)
 *
 * This walks every UPDATE in the worker's dependency factory rather than
 * naming the ones that exist today, so a transition added later is covered by
 * default instead of by remembering to add a case here.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const route = readFileSync(path.join(ROOT, "src/app/api/cron/receipt-intake-worker/route.ts"), "utf8");

/** Every `data: { ... }` of every receiptIntake update in the file, with context. */
function updateBlocks(source: string): { data: string; where: string }[] {
    const blocks: { data: string; where: string }[] = [];
    const needle = "receiptIntake.update";
    let at = source.indexOf(needle);
    while (at !== -1) {
        // Balanced scan from the call's opening brace to its close.
        const open = source.indexOf("{", at);
        let depth = 0;
        let end = open;
        for (; end < source.length; end++) {
            if (source[end] === "{") depth++;
            else if (source[end] === "}") { depth--; if (depth === 0) break; }
        }
        const call = source.slice(open, end + 1);
        const dataAt = call.indexOf("data: {");
        if (dataAt !== -1) {
            let d = 0;
            const i = call.indexOf("{", dataAt);
            let stop = i;
            for (; stop < call.length; stop++) {
                if (call[stop] === "{") d++;
                else if (call[stop] === "}") { d--; if (d === 0) break; }
            }
            // Everything before `data:` is the where clause (and, for the
            // aliased ones, the `owns` object it was built from).
            blocks.push({ data: call.slice(i, stop + 1), where: call.slice(0, dataAt) });
        }
        at = source.indexOf(needle, end);
    }
    return blocks;
}

/**
 * Only the CLAIM HOLDER's writes. The cutover sweep, the STAGING sweep and the
 * claim query itself all write rows nobody owns — releasing a claim there is
 * meaningless, and the claim query is the one write that TAKES ownership.
 */
const heldSection = route.slice(route.indexOf("applyState: async"));
const blocks = updateBlocks(heldSection);

test("the walker actually found the worker's updates", () => {
    // A structural test that matches nothing passes vacuously forever.
    assert.ok(blocks.length >= 7, `expected the worker's updates, found ${blocks.length}`);
});

test("EVERY completed, deferred or terminal transition releases the claim", () => {
    const leaked: string[] = [];
    for (const block of blocks) {
        // Shorthand counts: `{ attempts, nextRetryAt }` is every bit as much a
        // transition as `{ nextRetryAt: x }`, and a filter that only saw the
        // long form let a real leak through when this guard was first written.
        const setsState = /\bstate\b/.test(block.data);
        const setsRetry = /\bnextRetryAt\b/.test(block.data);
        if (!setsState && !setsRetry) continue; // not a transition (e.g. the send mark)

        // THE ONE EXCEPTION: READ -> BOOKING hands the row straight to
        // bookReceipt in the same pass, and both its send mark and its BOOKED
        // commit CAS on this same token. Releasing here would admit a second
        // worker to the same booking.
        const isPromotion = /state: "BOOKING", stateReason: null/.test(block.data) && !setsRetry;
        if (isPromotion) continue;

        const releases = /claimToken: null/.test(block.data) || /RELEASE_CLAIM/.test(block.data);
        if (!releases) leaked.push(block.data.replace(/\s+/g, " ").slice(0, 120));
    }
    assert.deepEqual(leaked, [], "these transitions keep a claim nobody will ever release");
});

test("releasing clears BOTH claim fields, never just the token", () => {
    // claimedAt is what the stuck-row health probe reads. A token cleared
    // without its timestamp leaves a row that looks claimed to everything
    // except the CAS.
    assert.match(route, /const RELEASE_CLAIM = \{ claimToken: null, claimedAt: null \}/);
    const halfReleased = blocks
        .filter(b => /claimToken: null/.test(b.data) && !/claimedAt: null/.test(b.data))
        .map(b => b.data.replace(/\s+/g, " ").slice(0, 90));
    assert.deepEqual(halfReleased, [], "these rows still look claimed to the health probe");
});

test("a routed row keeps no claim: finishRouting clears both fields under its fence", () => {
    const fn = route.slice(route.indexOf("finishRouting: async"));
    const body = fn.slice(0, fn.indexOf("\n        },"));
    assert.match(body, /where: \{ id: rowId, state: "RECEIVED", claimToken \}/, "fenced on state AND token");
    assert.match(body, /state: "READ"/);
    assert.match(body, /claimToken: null/);
    assert.match(body, /claimedAt: null/);
});

test("every fenced write CASes on the OWNERSHIP it was handed, not on the id alone", () => {
    // `where: { id }` on its own is how a superseded pass overwrites the work
    // of the pass that replaced it.
    const fenced = blocks.filter(b => /\bstate\b/.test(b.data) || /\bnextRetryAt\b/.test(b.data));
    assert.ok(fenced.length >= 6, `expected the worker's transitions, found ${fenced.length}`);
    for (const block of fenced) {
        // Either the token is named in the where clause, or it arrives via the
        // `owns` alias — which is itself built from {state, claimToken}.
        assert.match(
            block.where,
            /claimToken|where: owns/,
            `unfenced write: ${block.data.replace(/\s+/g, " ").slice(0, 90)}`,
        );
    }
    assert.match(route, /const owns = \{ id: rowId, state: "BOOKING", claimToken \} as const;/);
});
