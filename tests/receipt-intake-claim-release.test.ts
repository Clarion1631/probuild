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

/**
 * Every `data: { ... }` of every receiptIntake update in the file, with context.
 *
 * TWO CALL SHAPES since the round-42 evidence fence (finding 1): a direct
 * `tx.receiptIntake.updateMany(...)` and the fenced `evidenceUpdateMany(...)`
 * helper, which takes the identical args object and runs it under the shared
 * advisory lock. A walker that only knew the first shape silently stopped
 * seeing most of the worker's transitions the moment they were fenced — which
 * is exactly the vacuous pass the count assertion below exists to catch.
 */
const UPDATE_CALL_SHAPES = ["receiptIntake.update", "evidenceUpdateMany("];

function updateBlocks(source: string): { data: string; where: string }[] {
    const blocks: { data: string; where: string }[] = [];
    let at = -1;
    const nextCall = (from: number) => {
        let best = -1;
        for (const candidate of UPDATE_CALL_SHAPES) {
            const hit = source.indexOf(candidate, from);
            if (hit !== -1 && (best === -1 || hit < best)) best = hit;
        }
        return best;
    };
    at = nextCall(0);
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
        at = nextCall(end);
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
        //
        // stateReason is deliberately absent from this write (not set to
        // null): a READ row's stateReason can only ever be null or
        // "tax-implausible" (finishRouting is the ONLY path to READ), and that
        // warning must survive into BOOKING/BOOKED rather than being cleared
        // on the way through — see preservedTaxWarning in route-state.ts.
        const isPromotion = /state: "BOOKING" \}/.test(block.data) && !setsRetry;
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

test("applyRead is the ONE lease-keeping write, and it can only say RECEIVED", () => {
    // The scanner above skips it, because its `data` carries no state literal —
    // it spreads a patch. So it is asserted directly instead: routing continues
    // under this lease, which is the whole reason it keeps it, and the compiler
    // is what stops a TERMINAL state being routed back through it.
    const worker = readFileSync(
        path.join(__dirname, "..", "src/lib/receipt-intake/worker.ts"),
        "utf8",
    );
    assert.match(worker, /patch: ReadPatch & \{ state: "RECEIVED" \}/);

    const fn = route.slice(route.indexOf("applyRead: async"));
    const body = fn.slice(0, fn.indexOf("findWeakHit:"));
    assert.match(body, /where: \{ id: rowId, state: ownership\.state, claimToken: ownership\.claimToken \}/,
        "still fenced on ownership like every other write");
    assert.ok(!/RELEASE_CLAIM/.test(body), "and deliberately does NOT release: routing is not finished");
    assert.match(body, /nextRetryAt is deliberately/, "with the reason written down at the write itself");

    // Every TERMINAL outcome goes through applyState, which does release.
    // `gated`, not `gate`, since round 39 (finding 2): a routed DUPLICATE for a
    // row other rows are filed behind becomes NEEDS_REVIEW first. Still ONE
    // applyState, and still the write that releases the claim.
    assert.match(worker, /const gated = await applyRoutedState\(deps, row\.id, gate,/);
    assert.match(worker, /return gated\.owned \? gated\.state : "STALE";/);
});
