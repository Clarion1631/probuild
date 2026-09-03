/**
 * Rejecting a row, and publishing one.
 *
 * Both are two writes that must agree. A reject deletes the row AND queues its
 * object for deletion: do them separately and either the bytes are orphaned
 * with nothing left to remember them (delete first, record fails) or the queue
 * names a path a live row still points at (record first, delete fails). A
 * publish moves STAGING -> RECEIVED: do it by id alone and a row that moved on
 * gets dragged back to RECEIVED and re-read, which for a BOOKED row is a second
 * Purchase.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { RECOVERABLE_PARK_REASONS } from "../src/lib/receipt-intake/stored-object";
import {
    rejectRowAndQueueCleanup,
    type RejectClient,
    type RejectTxClient,
} from "../src/lib/receipt-intake/storage-cleanup";

const ROOT = path.resolve(__dirname, "..");
const intake = readFileSync(path.join(ROOT, "src/app/api/receipts/intake/route.ts"), "utf8");
const finalize = readFileSync(
    path.join(ROOT, "src/app/api/receipts/intake/[id]/finalize/route.ts"),
    "utf8",
);

type Row = Record<string, unknown>;

interface Store {
    rows: Row[];
    events: { id: string; data: Record<string, unknown> }[];
    committed: boolean;
}

const parked = (over: Row = {}): Row => ({
    id: "row-1",
    state: "STAGING",
    stateReason: null,
    claimToken: null,
    storagePath: "receipts/intake/row-1.v1.bin",
    // The upload lease this decision was reached about. A resumed /start bumps
    // it, which is what makes a stale verdict land on nothing.
    uploadLeaseVersion: 1,
    uploadUrlExpiresAt: null,
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    ...over,
});

/**
 * A $transaction that really rolls back, over rows that really match a where.
 *
 * The fence is the whole subject here, so the fake has to evaluate it rather
 * than match on the id like the code used to.
 */
function client(rows: Row[], onTx?: (store: Store) => void): { db: RejectClient; store: Store } {
    const store: Store = { rows: rows.map(r => ({ ...r })), events: [], committed: false };
    const db: RejectClient = {
        $transaction: async fn => {
            // A concurrent writer, running between the caller's read and this
            // transaction — the race this fence exists for.
            onTx?.(store);
            let staged = store.rows.map(r => ({ ...r }));
            const stagedEvents: Store["events"] = [];
            let seq = 0;
            const tx: RejectTxClient = {
                automationEvent: {
                    create: async ({ data }) => {
                        const id = `ev-${++seq}`;
                        stagedEvents.push({ id, data });
                        return { id };
                    },
                },
                receiptIntake: {
                    findUnique: async ({ where }) => staged.find(row => row.id === where.id) ?? null,
                    deleteMany: async ({ where }) => {
                        const matches = staged.filter(row =>
                            Object.entries(where).every(([k, v]) => row[k] === v));
                        staged = staged.filter(row => !matches.includes(row));
                        return { count: matches.length };
                    },
                },
            };
            const out = await fn(tx);
            store.rows = staged;
            store.events.push(...stagedEvents);
            store.committed = true;
            return out;
        },
    };
    return { db, store };
}

test("a reject deletes the row and queues the object in ONE transaction", async () => {
    const { db, store } = client([parked()]);
    const injected = await rejectRowAndQueueCleanup(parked() as never, "unsupported-type", db);
    assert.equal(injected.ok, true);
    assert.deepEqual(store.rows, [], "the row is gone");
    assert.equal(store.events.length, 1, "and exactly one cleanup is queued");
    assert.equal(store.events[0].data.status, "pending");
    assert.match(String(store.events[0].data.detail), /receipts\/intake\/row-1\.v1\.bin/);
});

test("PUBLISH vs REJECT: a row published mid-reject is not deleted, and nothing is queued", async () => {
    // The race: /finalize inspects the object, decides it is unsupported, and
    // in that window a concurrent publisher (another finalize, or the sweeper)
    // moves the row to RECEIVED and seals its object to the canonical path.
    // Deleting by id would destroy a PUBLISHED receipt and queue its live
    // bytes for deletion.
    const { db, store } = client([parked()], s => {
        s.rows = [parked({ state: "RECEIVED", storagePath: "receipts/row-1/abc.png" })];
    });
    const result = await rejectRowAndQueueCleanup(parked() as never, "unsupported-file-type", db);
    assert.equal(result.ok, false);
    assert.equal(store.committed, false, "the whole transaction rolled back");
    assert.deepEqual(store.events, [], "no cleanup naming a path a live row points at");
    assert.equal(store.rows.length, 1, "the published row survives");
    assert.equal(store.rows[0].state, "RECEIVED");
});

test("a row re-parked or claimed mid-reject also loses the fence", async () => {
    for (const moved of [
        parked({ stateReason: "file-missing", state: "NEEDS_REVIEW" }),
        parked({ claimToken: "worker-1" }),
        parked({ storagePath: "receipts/intake/row-1-other.bin" }),
    ]) {
        const { db, store } = client([parked()], s => { s.rows = [moved]; });
        const result = await rejectRowAndQueueCleanup(parked() as never, "empty-file", db);
        assert.equal(result.ok, false, JSON.stringify(moved));
        assert.deepEqual(store.events, [], "nothing queued");
        assert.equal(store.rows.length, 1, "nothing deleted");
    }
});

test("a row that is already GONE is not treated as a successful reject", async () => {
    // An absent row is a row somebody else accounted for. Queueing its path for
    // deletion here is exactly how a live object gets swept: the retry of a
    // reject can arrive after the id was reused by a re-created row, or after
    // the object was sealed under a path a new row points at.
    const { db, store } = client([]);
    const result = await rejectRowAndQueueCleanup(parked() as never, "unsupported-type", db);
    assert.equal(result.ok, false);
    assert.deepEqual(store.events, []);
});

test("a lost reject fence answers 409 publish-conflict and keeps the object", () => {
    const branch = finalize.slice(finalize.indexOf("const rejected = await rejectRowAndQueueCleanup"));
    const head = branch.slice(0, branch.indexOf("settleQueuedCleanup"));
    // The reject is fenced on what was OBSERVED, so losing it means the row is
    // not ours to reject — a 409 the caller can retry, never a 2xx and never a
    // deletion.
    assert.match(head, /state: row\.state/);
    assert.match(head, /stateReason: row\.stateReason/);
    assert.match(head, /storagePath: row\.storagePath/);
    assert.match(head, /publish-conflict/);
    assert.match(head, /status: 409/);
    assert.ok(
        !/deleteObjectOrRecord|removeSecureDoc/.test(head),
        "no object deletion on the lost-fence path",
    );
});

test("publishing STAGING -> RECEIVED is fenced on the exact state", () => {
    const fn = intake.slice(intake.indexOf("async function publishStagedRow"));
    const body = fn.slice(0, fn.indexOf("\n/**"));
    assert.match(body, /updateMany/, "not a bare update by id");
    assert.match(
        body,
        /where: \{ id, state: expectState, storagePath: expectStoragePath \}/,
        "fenced on state AND the exact object the caller verified, not state alone",
    );
    assert.match(body, /alreadyPublished: true/, "an already-RECEIVED row is the outcome we wanted");
    assert.match(body, /publish-conflict/);
});

test("a losing publish cleans up its own object when the winner published a different path", () => {
    // Two concurrent replays of the same bytes each upload to their OWN random
    // path (see /start), then both call publishStagedRow. Whichever loses the
    // CAS must not just report the winner's RECEIVED outcome and walk away —
    // its own upload is now unreferenced by any row, and nothing else will
    // ever find it to clean it up.
    const fn = intake.slice(intake.indexOf("async function publishStagedRow"));
    const body = fn.slice(0, fn.indexOf("\n/**"));
    const conflictBranch = body.slice(body.indexOf("if (count === 0)"));
    assert.match(conflictBranch, /storagePath: true/, "re-reads the winner's actual storagePath, not just state");
    assert.match(
        conflictBranch,
        /current\?\.storagePath && current\.storagePath !== expectStoragePath/,
        "only cleans up when the winner published somewhere else",
    );
    assert.match(conflictBranch, /deleteObjectOrRecord\(expectStoragePath, "orphaned-by-concurrent-publish"\)/);
    // Cleanup must happen BEFORE the idempotent success is returned — the
    // finding was specifically that the loser reported success and never
    // cleaned up its own path.
    assert.ok(
        conflictBranch.indexOf("deleteObjectOrRecord(expectStoragePath") <
            conflictBranch.indexOf("alreadyPublished: true"),
        "cleanup runs before the idempotent success is returned",
    );
});

test("recovery is restricted to the two reasons a re-upload can actually fix", () => {
    // "Any NEEDS_REVIEW row" would drag a row parked for a vendor mismatch, a
    // zero total, or a QBO fault back to RECEIVED and re-read it, discarding a
    // decision a human had already made.
    // ONE list, in the lib, asked by both publishers — two copies is how they
    // come to disagree about whether a human's decision can be overwritten.
    assert.deepEqual(RECOVERABLE_PARK_REASONS, ["file-missing", "sha-mismatch"]);
    assert.match(intake, /finalizeDisposition\(existing\) === "publish"/);
    assert.match(finalize, /finalizeDisposition\(row\)/, "the finalize route asks the same rule");
    for (const source of [intake, finalize]) {
        assert.ok(!/"file-missing" \|\| /.test(source), "no hand-rolled copy of the list");
    }
});

test("a heal that loses its CAS deletes the object it just uploaded", () => {
    // The upload happened before the CAS. Losing the race means nothing
    // references those bytes, and the row we were healing belongs to somebody
    // else now.
    const heal = intake.slice(intake.indexOf("const healed = await storeObject"));
    const body = heal.slice(0, heal.indexOf("return NextResponse.json({\n                ok: true, recovered: true"));
    assert.match(body, /if \(count === 0\)/);
    assert.match(body, /deleteObjectOrRecord\(payload\.storagePath, "heal-lost-race"\)/);
    assert.match(body, /publish-conflict/);
    assert.ok(
        body.indexOf("payload.storagePath !== existing.storagePath") < body.indexOf("heal-lost-race"),
        "and never deletes the path the surviving row still points at",
    );
});

// ── /start re-arms a recoverable park instead of claiming we hold it ────────

const start = readFileSync(
    path.join(ROOT, "src/app/api/receipts/intake/start/route.ts"),
    "utf8",
);

test("/start hands a recoverable park a NEW url, and asks the shared rule which parks those are", () => {
    // Answering alreadyReceived here told the forwarder we held a receipt we
    // did not hold — and it deletes its only copy on that answer.
    assert.match(start, /finalizeDisposition\(existing\) === "publish"/);
    const branch = start.slice(start.indexOf("if (recoverable) {"));
    const body = branch.slice(0, branch.indexOf("// IDENTITY MUST BE PROVEN"));
    assert.match(body, /recovered: true/);
    assert.match(body, /expectedSha256,/, "the sha the client is about to upload is re-armed");
    assert.match(body, /fileSha256: "",/, "and the stale stored hash is cleared");
    // Fenced like every other publish-path write, and a lost fence writes
    // nothing rather than pointing a live row at an empty path.
    assert.match(body, /where: \{ id: existing\.id, \.\.\.publishFence\(existing\) \}/);
    assert.match(body, /return leaseConflict\(existing\.id\)/);
});

test("A LIVE LEASE SURVIVES A RECOVERABLE RETRY — same path, same version, no delete", () => {
    // The re-arm below it is destructive by design (new version, new path, the
    // old object deleted) and it used to run on EVERY /start for a parked row,
    // including one whose signed URL was still live. Two retries for the same
    // parked sourceRef therefore raced: the second deleted the object the first
    // was about to PUT its bytes to. An earlier round fixed exactly this for
    // STAGING rows and left the recovery path alone — so the rule is now ONE
    // rule, in one module, and both callers reach it.
    const branch = start.slice(start.indexOf("if (recoverable) {"));
    const body = branch.slice(0, branch.indexOf("// IDENTITY MUST BE PROVEN"));
    const reuse = body.indexOf("await reuseLiveLease(existing, ext, leaseDeps, {");
    assert.ok(reuse > 0, "the recovery asks the shared rule first");
    assert.ok(
        reuse < body.indexOf("const nextLease = existing.uploadLeaseVersion + 1"),
        "BEFORE it bumps the version",
    );
    assert.ok(
        reuse < body.indexOf("start-rearmed-repath"),
        "and before anything is deleted",
    );
    // The identity writes a recovery needs still happen — they just land on the
    // SAME path and lease version, so a corrected hash is not a reason to
    // repath.
    const patch = body.slice(reuse, body.indexOf("if (keptRecovery)"));
    assert.match(patch, /expectedSha256,/);
    assert.match(patch, /fileSha256: "",/);
    assert.ok(!/uploadLeaseVersion/.test(patch), "the version is NOT touched");
    assert.ok(!/storagePath/.test(patch), "and neither is the path");
});

test("both /start branches take the live-lease rule from the SAME place", () => {
    // Two copies of "may I reuse this lease" is how the STAGING path came to be
    // fixed while the recovery path stayed broken.
    assert.equal((start.match(/await reuseLiveLease\(/g) ?? []).length, 2, "recovery and resume");
    assert.match(start, /import \{ reuseLiveLease \} from "@\/lib\/receipt-intake\/upload-lease";/);
    // And one 409 helper, so every lost claim answers identically.
    assert.equal(
        (start.match(/return leaseConflict\(existing\.id\)/g) ?? []).length,
        4,
        "both reuse callers and both new-lease claims",
    );
    assert.match(start, /error: "publish-conflict",/, "which is still a publish-conflict");
});

test("the re-arm branch runs BEFORE the identity check, and only for a parked row", () => {
    // For a STAGING row the sha check still stands: it is what stops receipt B
    // from being handed a URL over receipt A's verified bytes.
    assert.match(start, /existing\.state !== "STAGING"\s*\n\s*&& finalizeDisposition\(existing\) === "publish"/);
    assert.ok(
        start.indexOf("if (recoverable) {") < start.indexOf("const knownSha ="),
        "the recoverable branch is taken before the identity check",
    );
    assert.match(start, /alreadyReceived: true/, "everything else still answers alreadyReceived");
});

test("a re-arm that changes the extension does not orphan the old object", () => {
    const branch = start.slice(start.indexOf("if (recoverable) {"));
    const body = branch.slice(0, branch.indexOf("// IDENTITY MUST BE PROVEN"));
    assert.match(body, /retryPath !== existing\.storagePath/);
    assert.match(body, /deleteObjectOrRecord\(existing\.storagePath, "start-rearmed-repath"\)/);
});

// ── The sweeper rejects through the same fenced transaction ────────────────

const sweeper = readFileSync(
    path.join(ROOT, "src/app/api/cron/receipt-intake-worker/route.ts"),
    "utf8",
);

test("SWEEPER RACE: a publish that wins mid-sweep leaves the row and the bytes alone", async () => {
    // The sweep reads a batch, then spends a storage round trip per row
    // deciding what to do with it. A /finalize arriving in that window can
    // publish the row and seal its object — and the old unfenced
    // `deleteMany({ id, state: "STAGING" })` plus a bare object delete would
    // then destroy a published receipt's row OR its bytes, depending on
    // timing. The reject transaction is what makes that a no-op.
    const { db, store } = client([parked()], s => {
        s.rows = [parked({ state: "RECEIVED", storagePath: "receipts/row-1/sealed.png" })];
    });
    let deletedBytes = 0;
    const dropped = await rejectRowAndQueueCleanup(parked() as never, "unsupported-file-type", db);
    if (dropped.ok) deletedBytes++; // the caller only touches storage on success
    assert.equal(dropped.ok, false, "the fence lost");
    assert.equal(deletedBytes, 0, "so no object was deleted");
    assert.deepEqual(store.events, [], "and nothing was queued for deletion");
    assert.equal(store.rows[0].state, "RECEIVED", "the published row is untouched");
});

test("the sweeper uses the fenced reject, and touches no bytes when it loses", () => {
    const fn = sweeper.slice(sweeper.indexOf("sweepStaleStaging: async"));
    const body = fn.slice(0, fn.indexOf("loadPhases:"));
    assert.match(body, /const dropped = await rejectRowAndQueueCleanup\(/);
    assert.match(body, /if \(!dropped\.ok\) continue;/);
    assert.match(body, /settleQueuedCleanup\(dropped\.eventId, row\.storagePath\)/);
    // The unfenced pair this replaces.
    assert.ok(
        !/deleteMany\(\{ where: \{ id: row\.id, state: "STAGING" \} \}\)/.test(body),
        "no delete-by-id-and-state",
    );
    assert.ok(
        body.indexOf("if (!dropped.ok) continue;") < body.indexOf("settleQueuedCleanup"),
        "the object is only touched after the row is provably gone",
    );
});

test("nothing destructive happens while the upload lease is live", () => {
    const fn = sweeper.slice(sweeper.indexOf("sweepStaleStaging: async"));
    const body = fn.slice(0, fn.indexOf("loadPhases:"));
    // Three destructive outcomes, three lease checks: sha-mismatch park,
    // file-missing park, and the reject.
    assert.equal(
        (body.match(/if \(leaseLive\) \{ leaseActive\+\+; continue; \}/g) ?? []).length,
        3,
        "every destructive branch waits for the lease",
    );
    // Publishing is NOT gated on it: a complete, correct object is a complete,
    // correct object whether or not the URL is still live.
    const publishBranch = body.slice(body.indexOf("if (check.ok) {"), body.indexOf("if (check.kind === \"transient\")"));
    assert.ok(publishBranch.includes("sealAndPublish"));
    assert.equal(
        (publishBranch.match(/if \(leaseLive\)/g) ?? []).length,
        1,
        "only the sha-mismatch park inside the ok branch waits",
    );
});

// ── RESUME vs REJECT: the upload lease version decides (round-14 item 1) ───

test("a client that RESUMES its upload mid-sweep is not rejected for the old one", async () => {
    // The real interleaving: the sweep reads a stale STAGING row, spends a
    // storage round trip on the object the client abandoned, and decides to
    // reject. In that window /start hands the client a fresh URL — a new lease
    // version, a new path, a live expiry. Without the version in the fence the
    // sweep deletes the row (and queues its object) for a receipt that is
    // actively being uploaded, and the forwarder is told nothing.
    const observed = parked({ uploadLeaseVersion: 1, storagePath: "receipts/intake/row-1.v1.bin" });
    const { db, store } = client([observed], s => {
        s.rows = [parked({
            uploadLeaseVersion: 2,
            storagePath: "receipts/intake/row-1.v2.bin",
            uploadUrlExpiresAt: new Date(Date.now() + 60 * 60_000),
        })];
    });

    const dropped = await rejectRowAndQueueCleanup(observed as never, "unsupported-file-type", db);
    assert.equal(dropped.ok, false, "the fence lost to the newer lease");
    assert.equal(store.committed, false);
    assert.deepEqual(store.events, [], "the v1 object is not queued for deletion by this pass");
    assert.equal(store.rows.length, 1, "and the row survives");
    assert.equal(store.rows[0].uploadLeaseVersion, 2);
});

test("a lease that came back to life inside the transaction aborts the reject", async () => {
    // The version alone cannot see this one: /start refreshed the EXPIRY on the
    // same lease. The verifier runs on a row re-read inside the transaction,
    // which is the only place that is true.
    const observed = parked();
    const { db, store } = client([observed], s => {
        s.rows = [parked({ uploadUrlExpiresAt: new Date(Date.now() + 60 * 60_000) })];
    });
    const dropped = await rejectRowAndQueueCleanup(
        observed as never,
        "unsupported-file-type",
        db,
        fresh => (fresh.uploadUrlExpiresAt as Date | null) &&
            (fresh.uploadUrlExpiresAt as Date).getTime() > Date.now()
            ? "upload-lease-active"
            : null,
    );
    assert.equal(dropped.ok, false);
    assert.deepEqual(store.events, []);
    assert.equal(store.rows.length, 1);
});

test("an unchanged lease still rejects — the control", async () => {
    const observed = parked();
    const { db, store } = client([observed]);
    const dropped = await rejectRowAndQueueCleanup(observed as never, "unsupported-file-type", db, () => null);
    assert.equal(dropped.ok, true);
    assert.deepEqual(store.rows, []);
    assert.equal(store.events.length, 1);
});

test("the sweeper and /start both fence on the lease version", () => {
    const start = readFileSync(
        path.join(ROOT, "src/app/api/receipts/intake/start/route.ts"),
        "utf8",
    );
    // /start claims the new lease BEFORE it signs anything: the version, the
    // expiry and the path move in ONE checked update, and a lost update is a
    // 409 rather than a URL for a row somebody else has moved on.
    assert.equal((start.match(/uploadLeaseVersion: nextLease/g) ?? []).length, 2, "resume and re-arm");
    assert.equal((start.match(/const nextLease = existing\.uploadLeaseVersion \+ 1/g) ?? []).length, 2);
    for (const branch of ["const rearmed = await signUpload(retryPath)", "const resumed = await signUpload(resumePath)"]) {
        const at = start.indexOf(branch);
        assert.ok(at > 0, branch);
        const update = start.lastIndexOf("await prisma.receiptIntake.updateMany(", at);
        assert.ok(update > 0 && update < at, `${branch}: the row moves before the URL is signed`);
    }
    // ONE 409 helper now — four call sites (the two new-lease claims and the
    // two live-lease reuses), so a lost claim cannot answer differently
    // depending on which branch lost it.
    assert.equal((start.match(/error: "publish-conflict"/g) ?? []).length, 1, "one helper");
    assert.equal(
        (start.match(/return leaseConflict\(existing\.id\)/g) ?? []).length,
        4,
        "and every lost claim goes through it",
    );

    // Every destructive sweeper write carries the version it observed.
    const fn = sweeper.slice(sweeper.indexOf("sweepStaleStaging: async"));
    const body = fn.slice(0, fn.indexOf("loadPhases:"));
    assert.equal(
        (body.match(/uploadLeaseVersion: row\.uploadLeaseVersion/g) ?? []).length,
        4,
        "the two parks, the publish commit and the reject",
    );
    // ...and the reject also re-reads the row inside the transaction.
    assert.match(body, /fresh => uploadLeaseActive\(/);
});
