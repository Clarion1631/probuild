/**
 * The one lease-reuse rule /start applies, in every resumable state.
 *
 * The interesting behaviour here is entirely about a RACE — two /start calls for
 * one sourceRef, which is the normal shape of a network retry, a double-tap, or
 * a forwarder's own retry policy — so it lives in a lib and is driven through an
 * injected client rather than by standing up a route handler.
 *
 * The failure it exists to prevent: every branch other than this one is
 * destructive by design (new lease version, new path, the previous object
 * deleted). Running that while a signed URL is still live invalidates the FIRST
 * caller's URL and deletes the object it is about to PUT its bytes to. An
 * earlier round fixed exactly this for STAGING rows and left the recoverable
 * NEEDS_REVIEW re-arm alone — so the rule is now one rule, and both callers are
 * exercised below.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
    discardUnresumedLease,
    liveLeasePath,
    newLeaseNonce,
    reuseLiveLease,
    type LeaseRow,
} from "../src/lib/receipt-intake/upload-lease";
import { uploadPathFor } from "../src/lib/receipt-intake/stored-object";

const HOUR = 60 * 60_000;

/** The generation the CREATING request stamped on the lease. */
const CREATED_NONCE = "lease-nonce-created";

type LeaseFixture = LeaseRow & { uploadLeaseNonce: string };

/** A recoverable park: the state the earlier fix did NOT cover. */
const parked = (over: Partial<LeaseFixture> = {}): LeaseFixture => ({
    id: "row-1",
    state: "NEEDS_REVIEW",
    stateReason: "sha-mismatch",
    uploadLeaseVersion: 2,
    storagePath: uploadPathFor("row-1", 2, "png"),
    uploadUrlExpiresAt: new Date(Date.now() + HOUR),
    uploadLeaseNonce: CREATED_NONCE,
    ...over,
});

const staging = (over: Partial<LeaseFixture> = {}): LeaseFixture => parked({
    state: "STAGING",
    stateReason: null,
    uploadLeaseVersion: 1,
    storagePath: uploadPathFor("row-1", 1, "png"),
    ...over,
});

interface Store {
    rows: Record<string, unknown>[];
    signed: string[];
    deleted: string[];
}

/**
 * A store whose `updateMany` really evaluates the where clause, because the
 * FENCE is the whole subject: a CAS that matched on the id alone would report
 * success for a row somebody else had already moved.
 */
function client(rows: (LeaseRow | Record<string, unknown>)[]) {
    const store: Store = { rows: rows.map(r => ({ ...r } as Record<string, unknown>)), signed: [], deleted: [] };
    let adoptions = 0;
    const matching = (where: Record<string, unknown>) => (row: Record<string, unknown>) =>
        Object.entries(where).every(([key, want]) => {
            const have = row[key];
            if (want instanceof Date) return have instanceof Date && have.getTime() === want.getTime();
            return have === want || (have == null && want == null);
        });
    const deps = {
        db: {
            updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
                const hits = store.rows.filter(matching(where));
                for (const hit of hits) Object.assign(hit, data);
                return { count: hits.length };
            },
            // The discard is a DELETE over the same evaluated where, so the fake
            // has to be able to lose the CAS the same way the database would.
            deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
                const hits = store.rows.filter(matching(where));
                store.rows = store.rows.filter(row => !hits.includes(row));
                for (const hit of hits) store.deleted.push(String(hit.storagePath));
                return { count: hits.length };
            },
        },
        sign: async (storagePath: string) => {
            store.signed.push(storagePath);
            return { uploadUrl: `https://example/${storagePath}`, token: "tok", storagePath };
        },
        expiresAt: () => new Date(Date.now() + 2 * HOUR),
        // Deterministic, and never the creator's: an adoption must always be
        // distinguishable from the lease it adopted.
        nonce: () => "lease-nonce-adopted-" + (++adoptions),
    };
    return { store, deps };
}

// ── The finding: a recoverable row's retries were NOT idempotent ───────────

test("CONCURRENT RETRY on a recoverable row: same path, same lease version, no delete", async () => {
    // Two /start calls arrive for one parked sourceRef. Before this, EVERY one
    // of them bumped uploadLeaseVersion, repointed storagePath, and deleted the
    // previous path — so the second call destroyed the object the first was
    // about to upload to, and the first request's signed URL pointed at nothing.
    const row = parked();
    const { store, deps } = client([row]);

    const [first, second] = await Promise.all([
        reuseLiveLease(row, "png", deps, { expectedSha256: "a".repeat(64), fileSha256: "" }),
        reuseLiveLease(row, "png", deps, { expectedSha256: "a".repeat(64), fileSha256: "" }),
    ]);

    for (const outcome of [first, second]) {
        assert.ok(outcome, "a live lease is reused, never re-armed");
        assert.equal(outcome!.kind, "signed");
    }
    assert.deepEqual(store.signed, [row.storagePath, row.storagePath], "the SAME path, twice");
    assert.equal(store.rows[0].uploadLeaseVersion, 2, "the version never moved");
    assert.equal(store.rows[0].storagePath, row.storagePath, "and neither did the path");
    assert.deepEqual(store.deleted, [], "nothing was deleted");
});

test("the recovery's identity writes still land — on the SAME lease", async () => {
    // A recoverable park can legitimately come back with a CORRECTED hash (a
    // re-scanned Drive file, a recomputed digest). Reusing the lease must not
    // cost it that, or /finalize would verify the new bytes against the old
    // promise and park the row again.
    const row = parked({ storagePath: uploadPathFor("row-1", 2, "png") });
    const { store, deps } = client([{ ...row, expectedSha256: "old", fileSha256: "stale", nextRetryAt: new Date() }]);
    const outcome = await reuseLiveLease(row, "png", deps, {
        expectedSha256: "b".repeat(64),
        fileSha256: "",
        nextRetryAt: null,
    });
    assert.equal(outcome!.kind, "signed");
    assert.equal(store.rows[0].expectedSha256, "b".repeat(64));
    assert.equal(store.rows[0].fileSha256, "");
    assert.equal(store.rows[0].nextRetryAt, null);
    assert.equal(store.rows[0].uploadLeaseVersion, 2, "still not a new lease");
});

test("the lease EXPIRY moves with the URL it reissues", async () => {
    // A resigned URL is good for a fresh window. Leaving the row's recorded
    // expiry at its OLD value let the sweeper judge the lease dead and reclaim a
    // row whose client was still holding a perfectly live URL.
    const row = parked({ uploadUrlExpiresAt: new Date(Date.now() + 60_000) });
    const { store, deps } = client([row]);
    await reuseLiveLease(row, "png", deps);
    const after = store.rows[0].uploadUrlExpiresAt as Date;
    assert.ok(after.getTime() > row.uploadUrlExpiresAt!.getTime(), "extended");
});

// ── STAGING answers the same way, from the same code ──────────────────────

test("a STAGING retry against a live lease is idempotent too", async () => {
    const row = staging();
    const { store, deps } = client([row]);
    const first = await reuseLiveLease(row, "png", deps);
    const second = await reuseLiveLease(row, "png", deps);
    assert.equal(first!.kind, "signed");
    assert.equal(second!.kind, "signed");
    assert.deepEqual(store.signed, [row.storagePath, row.storagePath]);
    assert.equal(store.rows[0].uploadLeaseVersion, 1);
});

// ── When there is nothing live to reuse ───────────────────────────────────

test("an EXPIRED lease is not reused — the caller takes a new one", async () => {
    // Fair game to invalidate: nothing live can still be relying on it.
    for (const state of [parked, staging]) {
        const row = state({ uploadUrlExpiresAt: new Date(Date.now() - 1) });
        const { store, deps } = client([row]);
        assert.equal(await reuseLiveLease(row, "png", deps), null, row.state);
        assert.deepEqual(store.signed, [], "and no URL was handed out here");
    }
});

test("a row that never had a lease is not reused", async () => {
    // The single-shot POST path writes no uploadUrlExpiresAt at all.
    const row = parked({ uploadUrlExpiresAt: null });
    const { deps } = client([row]);
    assert.equal(await reuseLiveLease(row, "png", deps), null);
});

test("a CHANGED extension takes a new lease rather than reusing a mismatched path", async () => {
    // The path is derived from (id, leaseVersion, ext). Reusing it for a caller
    // that changed its declared type would leave the row pointing at an object
    // whose name disagrees with its type.
    const row = parked();
    const { store, deps } = client([row]);
    assert.equal(await reuseLiveLease(row, "pdf", deps), null);
    assert.deepEqual(store.signed, []);
    assert.equal(store.rows[0].storagePath, row.storagePath, "and the row is untouched");
});

test("liveLeasePath answers the same three questions on its own", () => {
    const row = parked();
    assert.equal(liveLeasePath(row, "png"), row.storagePath);
    assert.equal(liveLeasePath(row, "pdf"), null, "wrong extension");
    assert.equal(liveLeasePath({ ...row, uploadUrlExpiresAt: null }, "png"), null, "no lease");
    assert.equal(
        liveLeasePath(row, "png", row.uploadUrlExpiresAt!.getTime()),
        null,
        "an expiry exactly NOW is expired, not live",
    );
});

// ── A lost fence never falls through to the destructive branch ────────────

test("a row that MOVED under us is a conflict, never a repath-and-delete", async () => {
    // We know a live lease existed a moment ago. Re-pathing and deleting on the
    // strength of a row that just changed is precisely what this prevents — the
    // client retries and reads whatever the winner left.
    const row = parked();
    const { store, deps } = client([{ ...row, uploadLeaseVersion: 3 }]);
    const outcome = await reuseLiveLease(row, "png", deps);
    assert.deepEqual(outcome, { kind: "conflict" });
    assert.deepEqual(store.signed, [], "no URL for a lease we could not extend");
});

test("a row the WORKER claimed loses the fence", async () => {
    const row = parked();
    const { store, deps } = client([{ ...row, claimToken: "worker-1" }]);
    assert.deepEqual(await reuseLiveLease(row, "png", deps), { kind: "conflict" });
    assert.deepEqual(store.signed, []);
});

test("a row RE-PARKED under a different reason loses the fence", async () => {
    // file-missing -> vendor-mismatch is a human's decision. Quietly re-arming
    // it would clear a hash and a retry time nobody here looked at.
    const row = parked({ stateReason: "file-missing" });
    const { store, deps } = client([{ ...row, stateReason: "vendor-mismatch" }]);
    assert.deepEqual(await reuseLiveLease(row, "png", deps), { kind: "conflict" });
    assert.deepEqual(store.signed, []);
});

test("the CAS carries the identity the retry proved: id, state, path and version", async () => {
    const row = parked();
    const seen: Record<string, unknown>[] = [];
    const { deps } = client([row]);
    const spy = {
        ...deps,
        db: {
            updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
                seen.push(args.where);
                return { count: 1 };
            },
        },
    };
    await reuseLiveLease(row, "png", spy);
    assert.deepEqual(seen[0], {
        id: "row-1",
        storagePath: row.storagePath,
        state: "NEEDS_REVIEW",
        stateReason: "sha-mismatch",
        claimToken: null,
        uploadLeaseVersion: 2,
    });
});

test("an extended lease whose URL cannot be signed is a 503, not a fall-through", async () => {
    // Falling through would reach the destructive branch — which is the thing
    // this module exists to keep away from a live lease.
    const row = parked();
    const { store, deps } = client([row]);
    const outcome = await reuseLiveLease(row, "png", { ...deps, sign: async () => null });
    assert.deepEqual(outcome, { kind: "storage-unavailable" });
    assert.equal(store.rows[0].uploadLeaseVersion, 2, "and the row still holds its lease");
});

// ── The finding: a failed signer deleted a row another request had RESUMED ──

/** The lease /start just wrote, as the request that wrote it knows it. */
const asCreated = (row: LeaseFixture) => ({
    id: row.id,
    storagePath: row.storagePath,
    uploadLeaseVersion: row.uploadLeaseVersion,
    uploadUrlExpiresAt: row.uploadUrlExpiresAt!,
    uploadLeaseNonce: row.uploadLeaseNonce,
});

test("A RESUMED ROW SURVIVES the original request's signer failure", async () => {
    // /start creates the row FIRST and signs its URL SECOND. In that gap a
    // concurrent /start for the same sourceRef hits the unique violation, finds
    // this row with a live lease, and reuseLiveLease hands it a WORKING signed
    // URL over the same path. The unconditional delete this replaces then
    // removed the row that retry had just adopted: its bytes landed at a path
    // no row pointed at, /finalize 404'd on an id that no longer existed, and
    // the sourceRef stopped protecting the document's identity.
    const created = staging();
    const { store, deps } = client([created]);

    // The retry, interleaved BEFORE the original's discard.
    const resumed = await reuseLiveLease(created, "png", deps);
    assert.equal(resumed?.kind, "signed");

    const outcome = await discardUnresumedLease(asCreated(created), deps.db);
    assert.equal(outcome, "resumed", "the CAS refuses to delete a row somebody else adopted");
    assert.equal(store.rows.length, 1, "the row survives");
    assert.deepEqual(store.deleted, [], "and nothing is dropped");
    // The URL the retry is holding still names the path the surviving row
    // points at, so its upload finalizes against a live row.
    const signed = (resumed as { signed: { storagePath: string } }).signed;
    assert.equal(signed.storagePath, store.rows[0].storagePath);
    assert.equal(store.rows[0].state, "STAGING", "still resumable, not orphaned");
});

test("with NOBODY resuming it, the row really is discarded", async () => {
    // The control. Without it a CAS that matched nothing would pass the test
    // above while leaking a STAGING row — and its sourceRef — on every signer
    // failure.
    const created = staging();
    const { store, deps } = client([created]);
    assert.equal(await discardUnresumedLease(asCreated(created), deps.db), "discarded");
    assert.deepEqual(store.rows, [], "no row is left holding the sourceRef");
});

test("a row the RESUME branch repathed is not deleted either", async () => {
    // The other way a retry adopts the row: an expired lease, or a caller
    // declaring a different extension, takes the destructive branch — new lease
    // version, new path. Pinning the version and the path is what sees it.
    const created = staging();
    const { store, deps } = client([created]);
    store.rows[0].uploadLeaseVersion = 2;
    store.rows[0].storagePath = uploadPathFor(created.id, 2, "png");

    assert.equal(await discardUnresumedLease(asCreated(created), deps.db), "resumed");
    assert.equal(store.rows.length, 1);
});

test("a row that PUBLISHED under us is not deleted", async () => {
    // /finalize can land between the create and the signer failure. Deleting a
    // published row would destroy a receipt over a signing hiccup.
    const created = staging();
    const { store, deps } = client([created]);
    store.rows[0].state = "RECEIVED";
    assert.equal(await discardUnresumedLease(asCreated(created), deps.db), "resumed");
    assert.equal(store.rows.length, 1);
});

test("the discard CAS reads every column an adopter would have moved", async () => {
    // Each is a witness for one way the row can be adopted: the version and
    // path for a resume, the state for a publish, and the NONCE for a lease
    // reuse -- which the expiry alone could not see, because a reuse writes the
    // same "now + 2h" the original issue did.
    const created = staging();
    const { store, deps } = client([created]);
    for (const [column, value] of [
        ["uploadUrlExpiresAt", new Date(Date.now() + 3 * HOUR)],
        ["uploadLeaseVersion", 9],
        ["storagePath", "receipts/intake/row-1.v9.png"],
        ["state", "NEEDS_REVIEW"],
        ["uploadLeaseNonce", "lease-nonce-adopted-1"],
    ] as const) {
        store.rows = [{ ...created, [column]: value } as Record<string, unknown>];
        assert.equal(
            await discardUnresumedLease(asCreated(created), deps.db),
            "resumed",
            `a moved ${column} must lose the CAS`,
        );
        assert.equal(store.rows.length, 1, column);
    }
});

// -- The hole in the previous round's own fix: an expiry is not an identity ---

test("SAME-MILLISECOND EXPIRY: an adopted row still survives the discard", async () => {
    // The previous CAS pinned `uploadUrlExpiresAt` and argued the adopter's
    // value must read strictly LATER, because it can only run after this
    // request's INSERT committed. That is an argument about ORDER; the CAS needs
    // INEQUALITY. Production issues both the initial and the resumed expiry as
    // "now + 2h" and Date.now() has millisecond resolution, so two requests a
    // few hundred microseconds apart write the SAME instant -- and the delete
    // then removed a row the retry had already been handed a working URL for.
    const created = staging();
    const { store, deps } = client([created]);

    // The adopter, with a clock that lands on the exact instant we wrote.
    const sameInstant = {
        ...deps,
        expiresAt: () => new Date(created.uploadUrlExpiresAt!.getTime()),
    };
    const resumed = await reuseLiveLease(created, "png", sameInstant);
    assert.equal(resumed?.kind, "signed");
    assert.equal(
        (store.rows[0].uploadUrlExpiresAt as Date).getTime(),
        created.uploadUrlExpiresAt!.getTime(),
        "the expiry is byte-identical: the OLD CAS's only witness saw nothing",
    );
    assert.notEqual(store.rows[0].uploadLeaseNonce, CREATED_NONCE, "but the generation moved");

    assert.equal(await discardUnresumedLease(asCreated(created), deps.db), "resumed");
    assert.equal(store.rows.length, 1, "the row survives");
    assert.deepEqual(store.deleted, [], "and nothing is dropped");
    const signed = (resumed as { signed: { storagePath: string } }).signed;
    assert.equal(signed.storagePath, store.rows[0].storagePath, "the retry's URL still names a live row");
});

test("CLOCK SKEW: an adoption whose expiry reads EARLIER also survives", async () => {
    // Two hosts, two clocks. The adopter's "now + 2h" can land BEFORE ours, so
    // any reasoning that treats the expiry as monotonic is wrong in both
    // directions -- and a CAS written as a comparison rather than an equality
    // would delete this row.
    const created = staging();
    const { store, deps } = client([created]);
    const skewed = {
        ...deps,
        expiresAt: () => new Date(created.uploadUrlExpiresAt!.getTime() - 5 * 60_000),
    };
    const resumed = await reuseLiveLease(created, "png", skewed);
    assert.equal(resumed?.kind, "signed");
    assert.ok(
        (store.rows[0].uploadUrlExpiresAt as Date).getTime() < created.uploadUrlExpiresAt!.getTime(),
        "the adopted lease really does expire earlier than the one we wrote",
    );

    assert.equal(await discardUnresumedLease(asCreated(created), deps.db), "resumed");
    assert.equal(store.rows.length, 1);
});

test("the control, restated: with NO adoption the generation is untouched and the row goes", async () => {
    // Without this, a CAS that matched nothing would pass both tests above while
    // leaking a STAGING row -- and its sourceRef -- on every signer failure.
    const created = staging();
    const { store, deps } = client([created]);
    assert.equal(store.rows[0].uploadLeaseNonce, CREATED_NONCE);
    assert.equal(await discardUnresumedLease(asCreated(created), deps.db), "discarded");
    assert.deepEqual(store.rows, []);
});

test("every adoption stamps a FRESH generation, so two of them never collide", async () => {
    const created = staging();
    const { store, deps } = client([created]);
    await reuseLiveLease(created, "png", deps);
    const first = store.rows[0].uploadLeaseNonce;
    await reuseLiveLease(created, "png", deps);
    assert.notEqual(store.rows[0].uploadLeaseNonce, first, "the second adoption wrote its own");
    assert.notEqual(first, CREATED_NONCE);
});

test("the real generator is unique per call -- the fake's determinism is the test's", () => {
    const seen = new Set(Array.from({ length: 200 }, () => newLeaseNonce()));
    assert.equal(seen.size, 200);
});
