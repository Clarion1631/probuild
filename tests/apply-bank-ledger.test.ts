import assert from "node:assert/strict";
import test from "node:test";
import { checkDatabaseIdentity, statements } from "../scripts/apply-bank-ledger.mjs";

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

// check_bank_line_amount_immutable() is a DB trigger — it can't run inside
// `tsx --test` without a live Postgres connection, so the SQL text in the
// exported `statements` array is the only pure surface available to verify
// it (Codex round-4, fix 1: BankLine.amountCents must be UNCONDITIONALLY
// immutable, with the round-3 `EXISTS (SELECT 1 FROM "RefundEvent" ...)`
// conditional removed entirely — that unlocked MVCC read let a concurrent
// RefundEvent insert + amountCents update both commit, and let the amount
// become editable again once every referencing RefundEvent was deleted).
test("check_bank_line_amount_immutable trigger SQL (Codex round-4 fix 1: unconditional, no RefundEvent gate)", async t => {
    function findStatement(needle: string): string {
        const found = statements.find((sql: string) => sql.includes(needle));
        assert.ok(found, `expected a statement containing "${needle}"`);
        return found as string;
    }

    await t.test("the trigger function's body never references RefundEvent — the round-3 conditional is gone, not just relaxed", () => {
        const fn = findStatement("CREATE OR REPLACE FUNCTION check_bank_line_amount_immutable()");
        assert.doesNotMatch(fn, /RefundEvent/);
        assert.doesNotMatch(fn, /EXISTS/);
    });

    await t.test("the trigger function raises unconditionally whenever amountCents changes — rejected with no references AND with references, because there is no query to distinguish the two anymore", () => {
        const fn = findStatement("CREATE OR REPLACE FUNCTION check_bank_line_amount_immutable()");
        assert.match(fn, /IF NEW\."amountCents" <> OLD\."amountCents" THEN\s+RAISE EXCEPTION/);
    });

    await t.test("the trigger fires BEFORE UPDATE on BankLine, not gated behind any other table", () => {
        const trigger = findStatement("CREATE TRIGGER bank_line_amount_immutable_trigger");
        assert.match(trigger, /BEFORE UPDATE ON "BankLine"/);
        assert.match(trigger, /EXECUTE FUNCTION check_bank_line_amount_immutable\(\)/);
    });

    await t.test("the trigger is dropped and recreated idempotently, same pattern as refund_event_signs_trigger", () => {
        findStatement('DROP TRIGGER IF EXISTS bank_line_amount_immutable_trigger ON "BankLine"');
    });
});
