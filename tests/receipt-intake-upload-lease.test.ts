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
    extendedExpiry,
    issuedLeaseIsCurrent,
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
    let duringSign: () => Promise<void> | void = () => {};
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
        // Re-reads the LIVE row out of the store, so a loser of the adoption
        // CAS sees what actually won rather than a snapshot the test posed.
        reload: async (id: string) =>
            (store.rows.find(r => r.id === id) as unknown as LeaseRow | undefined) ?? null,
        sign: async (storagePath: string) => {
            store.signed.push(storagePath);
            // A hook for the tests that need somebody else to move the row
            // WHILE the signing round trip is in flight.
            await duringSign();
            return { uploadUrl: `https://example/${storagePath}`, token: "tok", storagePath };
        },
        expiresAt: () => new Date(Date.now() + 2 * HOUR),
        // Deterministic, and never the creator's: an adoption must always be
        // distinguishable from the lease it adopted.
        nonce: () => "lease-nonce-adopted-" + (++adoptions),
    };
    return {
        store,
        deps,
        /** Run `body` inside the signing round trip, once. */
        onSign(body: () => Promise<void> | void) {
            let fired = false;
            duringSign = async () => {
                if (fired) return;
                fired = true;
                await body();
            };
        },
    };
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

test("the CAS carries the WHOLE lease identity, generation included", async () => {
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
    // THE NONCE AND THE EXPIRY ARE IN THE WHERE CLAUSE. They used to be
    // left out on purpose, so two concurrent adopters both matched, both
    // wrote their own generation, and the earlier one's 200 carried a
    // lease /finalize would refuse. Pinning them makes exactly one
    // adopter the writer of any given generation.
    assert.deepEqual(seen[0], {
        id: "row-1",
        storagePath: row.storagePath,
        state: "NEEDS_REVIEW",
        stateReason: "sha-mismatch",
        claimToken: null,
        uploadLeaseVersion: 2,
        uploadLeaseNonce: CREATED_NONCE,
        uploadUrlExpiresAt: row.uploadUrlExpiresAt,
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
    // THE GENERATION NO LONGER MOVES on an extension — an extension is the
    // same lease, and both retries have to be able to finalize under it. So
    // the expiry is what the discard's witness has to be, and the adoption
    // FORCES it past what it found rather than hoping the clock does.
    assert.equal(store.rows[0].uploadLeaseNonce, CREATED_NONCE, "same lease, same generation");
    assert.equal(
        (store.rows[0].uploadUrlExpiresAt as Date).getTime(),
        created.uploadUrlExpiresAt!.getTime() + 1,
        "one millisecond past the instant it found, by construction",
    );

    assert.equal(await discardUnresumedLease(asCreated(created), deps.db), "resumed");
    assert.equal(store.rows.length, 1, "the row survives");
    assert.deepEqual(store.deleted, [], "and nothing is dropped");
    const signed = (resumed as { signed: { storagePath: string } }).signed;
    assert.equal(signed.storagePath, store.rows[0].storagePath, "the retry's URL still names a live row");
});

test("CLOCK SKEW: an adoption never moves the expiry BACKWARDS", async () => {
    // Two hosts, two clocks. The adopter's "now + 2h" can land BEFORE ours.
    // Writing it would shorten a lease whose holder is still using a URL
    // signed for a full window -- which is how the sweeper comes to reclaim a
    // row somebody is actively uploading to. The extension takes the later of
    // the two, and still moves it far enough for the discard to see.
    const created = staging();
    const { store, deps } = client([created]);
    const skewed = {
        ...deps,
        expiresAt: () => new Date(created.uploadUrlExpiresAt!.getTime() - 5 * 60_000),
    };
    const resumed = await reuseLiveLease(created, "png", skewed);
    assert.equal(resumed?.kind, "signed");
    assert.equal(
        (store.rows[0].uploadUrlExpiresAt as Date).getTime(),
        created.uploadUrlExpiresAt!.getTime() + 1,
        "the skewed, EARLIER instant was refused; the lease only ever grows",
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

// -- Round 19: every 200 /start hands back must remain FINALIZABLE --------
//
// The test this replaces asserted the opposite, and blessed the bug: it
// required two adoptions of the SAME live lease to stamp DIFFERENT
// generations. Only the last one is stored, /finalize demands the generation
// its URL was issued under, so the earlier caller -- holding a signed URL it
// had just been handed for the same path -- was answered 409 lease-stale. An
// endpoint whose entire purpose is idempotent retries was issuing responses
// that could never be used.

/** What /finalize does with an echoed lease, in one line. */
const finalizable = (store: Store, uploadLease: string) =>
    store.rows.length === 1 && store.rows[0].uploadLeaseNonce === uploadLease;

test("CONCURRENT /start: both 200s carry the SAME lease, and both finalize", async () => {
    const created = staging();
    const { store, deps } = client([created]);

    // Both requests read the row before either writes -- the actual shape of
    // a double-tap, a network retry, or a forwarder's own retry policy.
    const [a, b] = await Promise.all([
        reuseLiveLease(created, "png", deps),
        reuseLiveLease(created, "png", deps),
    ]);

    assert.equal(a?.kind, "signed", "the first retry got a URL");
    assert.equal(b?.kind, "signed", "and so did the second");
    const leaseA = (a as { signed: { uploadLease: string } }).signed.uploadLease;
    const leaseB = (b as { signed: { uploadLease: string } }).signed.uploadLease;

    assert.equal(leaseA, leaseB, "one live lease, one generation");
    assert.equal(leaseA, CREATED_NONCE, "and it is the generation they adopted");
    // THE PROPERTY, stated as /finalize would evaluate it.
    assert.ok(finalizable(store, leaseA), "the first response is still finalizable");
    assert.ok(finalizable(store, leaseB), "and so is the second");

    // Same path, same version, nothing deleted -- the idempotency this rule
    // exists for is intact.
    assert.deepEqual(store.signed, [created.storagePath, created.storagePath]);
    assert.equal(store.rows[0].uploadLeaseVersion, 1);
    assert.deepEqual(store.deleted, []);
});

test("PRE-FIX CONTROL: minting a generation per adoption strands the first 200", async () => {
    // The old rule, reproduced exactly: a fresh nonce on every adoption, and
    // the nonce left out of the CAS so both writers land.
    const created = staging();
    const { store, deps } = client([created]);
    const oldRule = async (lease: string) => {
        await deps.db.updateMany({
            where: { id: created.id, storagePath: created.storagePath, state: created.state },
            data: { uploadUrlExpiresAt: deps.expiresAt(), uploadLeaseNonce: lease },
        });
        return lease;
    };

    const first = await oldRule("lease-nonce-adopted-1");
    const second = await oldRule("lease-nonce-adopted-2");

    assert.notEqual(first, second, "two 200s, two generations -- what shipped");
    assert.ok(finalizable(store, second), "the last writer's response works");
    assert.equal(
        finalizable(store, first),
        false,
        "and the first caller's, handed out moments earlier, is dead on arrival",
    );
});

test("a lease SUPERSEDED during the signing round trip is never returned", async () => {
    // The other side of the same failure: the CAS proves the lease was ours
    // when we wrote it, and signing is a network round trip. A concurrent
    // resume repaths the row while it is in flight, so the generation we were
    // about to hand back is one the row has already moved past.
    const created = staging();
    const { store, deps, onSign } = client([created]);
    onSign(() => {
        store.rows[0].uploadLeaseVersion = 2;
        store.rows[0].storagePath = uploadPathFor("row-1", 2, "png");
        store.rows[0].uploadLeaseNonce = "lease-nonce-resumed";
    });

    const outcome = await reuseLiveLease(created, "png", deps);

    assert.deepEqual(outcome, { kind: "conflict" }, "a retryable 409, never a stale 200");
});

test("CONTROL: with nobody moving the row, the same call returns its lease", async () => {
    // Without this, a revalidation that always failed would satisfy the test
    // above while making every honest retry a 409.
    const created = staging();
    const { store, deps } = client([created]);
    const outcome = await reuseLiveLease(created, "png", deps);
    assert.equal(outcome?.kind, "signed");
    const lease = (outcome as { signed: { uploadLease: string } }).signed.uploadLease;
    assert.ok(finalizable(store, lease));
});

test("a legacy row with NO generation gets one, and only one writer mints it", async () => {
    // A row that predates the nonce column carries null. The adoption has to
    // mint a value -- and the CAS pins the null, so two concurrent adopters
    // cannot each mint their own and strand one another.
    const legacy = staging({ uploadLeaseNonce: null as unknown as string });
    const { store, deps } = client([legacy]);

    const [a, b] = await Promise.all([
        reuseLiveLease(legacy, "png", deps),
        reuseLiveLease(legacy, "png", deps),
    ]);

    assert.equal(a?.kind, "signed");
    assert.equal(b?.kind, "signed");
    const leaseA = (a as { signed: { uploadLease: string } }).signed.uploadLease;
    const leaseB = (b as { signed: { uploadLease: string } }).signed.uploadLease;
    assert.equal(leaseA, leaseB, "they converge on the one that was minted");
    assert.ok(finalizable(store, leaseA));
});

test("extendedExpiry on its own: never equal, never earlier", () => {
    const base = new Date(1_000_000);
    assert.equal(extendedExpiry(base, new Date(1_000_000)).getTime(), 1_000_001, "equal is not allowed");
    assert.equal(extendedExpiry(base, new Date(999_000)).getTime(), 1_000_001, "earlier is not allowed");
    assert.equal(extendedExpiry(base, new Date(2_000_000)).getTime(), 2_000_000, "later is taken as is");
    assert.equal(extendedExpiry(null, new Date(2_000_000)).getTime(), 2_000_000, "nothing to beat");
});

test("the real generator is unique per call -- the fake's determinism is the test's", () => {
    const seen = new Set(Array.from({ length: 200 }, () => newLeaseNonce()));
    assert.equal(seen.size, 200);
});

// -- The three MINTING branches re-read before they answer ------------------
//
// The create, the resume repath and the re-arm repath all write the row, then
// sign, then answer -- and the sign is a network round trip a concurrent
// /start can move the row inside. They were returning the nonce they had
// generated, never re-checked, so a client could be handed a working signed
// URL together with a lease /finalize had already moved past. Unlike the reuse
// rule they cannot simply loop (their write was destructive), so a superseded
// lease becomes the retryable publish-conflict the callers already answer.

test("issuedLeaseIsCurrent: only the generation the row STILL holds is current", async () => {
    const row = staging();
    const reload = async () => row as unknown as LeaseRow;

    assert.equal(
        await issuedLeaseIsCurrent(
            row.id,
            { storagePath: row.storagePath, uploadLease: CREATED_NONCE },
            reload,
        ),
        true,
        "the lease the row holds, at the path the row points at",
    );

    // A generation the row has moved past. THIS is the case the mutation
    // survived on: /finalize refuses it, so returning it hands the client a URL
    // it can never use.
    assert.equal(
        await issuedLeaseIsCurrent(
            row.id,
            { storagePath: row.storagePath, uploadLease: "a-generation-since-superseded" },
            reload,
        ),
        false,
    );

    // A row repathed under us: the lease may still match, the object does not.
    assert.equal(
        await issuedLeaseIsCurrent(
            row.id,
            { storagePath: uploadPathFor("row-1", 9, "png"), uploadLease: CREATED_NONCE },
            reload,
        ),
        false,
    );

    // A row that is gone entirely is never current.
    assert.equal(
        await issuedLeaseIsCurrent(
            row.id,
            { storagePath: row.storagePath, uploadLease: CREATED_NONCE },
            async () => null,
        ),
        false,
    );

    // And a row whose generation is NULL -- never issued a signed URL -- cannot
    // match a lease somebody claims to hold.
    assert.equal(
        await issuedLeaseIsCurrent(
            row.id,
            { storagePath: row.storagePath, uploadLease: CREATED_NONCE },
            async () => ({ ...row, uploadLeaseNonce: null }) as unknown as LeaseRow,
        ),
        false,
    );
});
