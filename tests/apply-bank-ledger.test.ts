import assert from "node:assert/strict";
import test from "node:test";
import { checkDatabaseIdentity } from "../scripts/apply-bank-ledger.mjs";

// checkDatabaseIdentity is a pure function — importing this module must NOT
// resolve DATABASE_URL, validate CLI flags, or open a Prisma connection
// (those are all guarded behind the isMainModule check in the script), so
// this file can run in the normal `tsx --test` unit-test process with no DB
// and no env vars set. If that guard ever regresses, this import itself
// starts throwing/exiting and every test below fails immediately.

test("checkDatabaseIdentity (Codex round-3 defect 6: host is compared, not just db name)", async t => {
    await t.test("passes when both db and host match", () => {
        const result = checkDatabaseIdentity({ db: "probuild", host: "10.0.0.5", port: 5432 }, "probuild", "10.0.0.5");
        assert.equal(result.ok, true);
    });

    await t.test("aborts when the database name matches but the host does not", () => {
        // The exact round-2 gap this defect closes: two servers can share a
        // database name, and the old check only compared current_database().
        const result = checkDatabaseIdentity({ db: "probuild", host: "10.0.0.9", port: 5432 }, "probuild", "10.0.0.5");
        assert.equal(result.ok, false);
        if (!result.ok) {
            assert.match(result.message, /does not match/);
            assert.match(result.message, /--expect-host "10\.0\.0\.5"/);
        }
    });

    await t.test("aborts when the host matches but the database name does not", () => {
        const result = checkDatabaseIdentity({ db: "staging", host: "10.0.0.5", port: 5432 }, "probuild", "10.0.0.5");
        assert.equal(result.ok, false);
    });

    await t.test("aborts when both db and host mismatch", () => {
        const result = checkDatabaseIdentity({ db: "staging", host: "10.0.0.9", port: 5432 }, "probuild", "10.0.0.5");
        assert.equal(result.ok, false);
    });

    await t.test("compares a null host (unix socket) against the literal 'local/unix-socket' expectation", () => {
        const matched = checkDatabaseIdentity({ db: "probuild", host: null, port: null }, "probuild", "local/unix-socket");
        assert.equal(matched.ok, true);

        const mismatched = checkDatabaseIdentity({ db: "probuild", host: null, port: null }, "probuild", "10.0.0.5");
        assert.equal(mismatched.ok, false);
    });

    await t.test("the error message names both the actual and expected identity, and never proceeds past it", () => {
        const result = checkDatabaseIdentity({ db: "wrong-db", host: "wrong-host", port: 6543 }, "probuild", "10.0.0.5");
        assert.equal(result.ok, false);
        if (!result.ok) {
            assert.match(result.message, /"wrong-db"/);
            assert.match(result.message, /host=wrong-host/);
            assert.match(result.message, /port=6543/);
            assert.match(result.message, /--expect-db "probuild"/);
            assert.match(result.message, /Aborting before any mutation/);
        }
    });
});
