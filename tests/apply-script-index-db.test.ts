/**
 * AN INVALID INDEX, AGAINST A REAL POSTGRES (Codex round 46, item 1).
 *
 * `CREATE INDEX CONCURRENTLY` can fail in any of its three build phases and
 * leaves the index BEHIND with the expected name and `indisvalid = false`. The
 * planner ignores it; a UNIQUE one enforces nothing. `IF NOT EXISTS` then
 * matches the name on every future run and skips, and every shape check the
 * verifier makes passes — because the shape IS right. The script printed
 * "verified 3 index(es)" over a duplicate-receipt guard that was not guarding.
 *
 * Nothing but a real server can produce that state, which is why this is a
 * DB-gated test: `indisvalid` is not something a fake can be wrong about.
 *
 * Opt-in by design. It runs in CI's migrations job and skips everywhere else,
 * including anywhere DATABASE_URL looks like production.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import {
    INDEX_STATEMENTS,
    rebuildInvalidIndex,
    toConcurrentIndexSql,
} from "../scripts/apply-expense-attribution.mjs";

const url =
    process.env.PHASE_INVARIANT_DB_TEST_URL ??
    process.env.RECEIPT_INTAKE_DB_TEST_URL ??
    process.env.MIGRATION_HISTORY_TEST_URL;
const looksLikeProd = !!url && /supabase\.(co|com)/i.test(url);
const skip = !url
    ? "set PHASE_INVARIANT_DB_TEST_URL to a disposable PostgreSQL URL"
    : looksLikeProd
        ? "refusing to run against what looks like production"
        : false;

const db = url && !looksLikeProd ? new PrismaClient({ datasources: { db: { url } } }) : null;

const INDEX = "Expense_sourceFileId_sourceGroupIndex_key";
const PFX = "idx-db";
const CLIENT = `${PFX}-client`;
const PROJECT = `${PFX}-project`;
const ESTIMATE = `${PFX}-estimate`;
const KEEP = `${PFX}-keep`;
const DUPE = `${PFX}-dupe`;

const indexState = async () => {
    const [row] = (await db!.$queryRawUnsafe(
        `SELECT i.indisvalid AS is_valid, i.indisready AS is_ready
           FROM pg_index i
           JOIN pg_class ic ON ic.oid = i.indexrelid
           JOIN pg_namespace n ON n.oid = ic.relnamespace
          WHERE ic.relname = $1 AND n.nspname = 'public'`,
        INDEX,
    )) as { is_valid: boolean; is_ready: boolean }[];
    return row ?? null;
};

async function cleanup() {
    if (!db) return;
    await db.expense.deleteMany({ where: { id: { in: [KEEP, DUPE] } } });
    await db.estimate.deleteMany({ where: { id: ESTIMATE } });
    await db.project.deleteMany({ where: { id: PROJECT } });
    await db.client.deleteMany({ where: { id: CLIENT } });
}

async function seed() {
    await cleanup();
    await db!.client.create({ data: { id: CLIENT, name: "Index DB", initials: "IX" } });
    await db!.project.create({
        data: { id: PROJECT, name: "Index DB", clientId: CLIENT, status: "In Progress" },
    });
    await db!.estimate.create({
        data: {
            id: ESTIMATE, title: "Index DB", code: `EST-${PFX}`, projectId: PROJECT,
            status: "Approved", totalAmount: 100, balanceDue: 100,
        },
    });
}

/** Leave the real index in the broken state a failed CONCURRENTLY build makes. */
async function breakTheIndex({ withDuplicate }: { withDuplicate: boolean }) {
    await db!.$executeRawUnsafe(`DROP INDEX CONCURRENTLY IF EXISTS "${INDEX}"`);
    await db!.expense.create({
        data: {
            id: KEEP, estimateId: ESTIMATE, projectId: PROJECT, amount: 10,
            status: "Pending", sourceFileId: `${PFX}-file`, sourceGroupIndex: 0,
        },
    });
    if (withDuplicate) {
        await db!.expense.create({
            data: {
                id: DUPE, estimateId: ESTIMATE, projectId: PROJECT, amount: 10,
                status: "Pending", sourceFileId: `${PFX}-file`, sourceGroupIndex: 0,
            },
        });
    }
    // With the duplicate present the build genuinely fails and Postgres keeps
    // the invalid index; without it, this succeeds, so the invalid state is
    // produced by building it, breaking it, and leaving it behind.
    const create = toConcurrentIndexSql(
        (INDEX_STATEMENTS as string[]).find(sql => sql.includes(INDEX))!,
    );
    await db!.$executeRawUnsafe(create).catch(() => {});
    if (!withDuplicate) {
        // No duplicate, so the build worked. Mark it invalid the way an
        // interrupted build would leave it.
        await db!.$executeRawUnsafe(
            `UPDATE pg_index SET indisvalid = false, indisready = false
              WHERE indexrelid = (SELECT oid FROM pg_class WHERE relname = $1)`,
            INDEX,
        );
    }
}

test("an INVALID index is detected and rebuilt", { skip }, async () => {
    await seed();
    try {
        await breakTheIndex({ withDuplicate: false });
        const broken = await indexState();
        assert.equal(broken?.is_valid, false, "the fixture really is invalid");

        const repair = await rebuildInvalidIndex(db, INDEX, broken);
        assert.equal(repair.ok, true, `the rebuild should have worked: ${repair.error}`);
        assert.match(repair.message ?? "", /rebuilt index/);

        const fixed = await indexState();
        assert.deepEqual(
            { valid: fixed?.is_valid, ready: fixed?.is_ready },
            { valid: true, ready: true },
            "and the guard actually guards again",
        );
        // ...and it is the RIGHT index: partial, unique, on both columns.
        const [def] = (await db!.$queryRawUnsafe(
            `SELECT pg_get_indexdef(indexrelid) AS def FROM pg_index i
               JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = $1`,
            INDEX,
        )) as { def: string }[];
        assert.match(def.def, /CREATE UNIQUE INDEX/);
        assert.match(def.def, /WHERE \("sourceFileId" IS NOT NULL\)/);
    } finally {
        await cleanup();
    }
});

test("...and a rebuild blocked by real duplicates fails LOUDLY, naming them", { skip }, async () => {
    // The other branch, and the one that matters operationally: an invalid
    // UNIQUE index usually means the table holds rows it would refuse. Saying
    // so beats a stack trace, and beats looping.
    await seed();
    try {
        await breakTheIndex({ withDuplicate: true });
        const broken = await indexState();
        assert.equal(broken?.is_valid, false);

        const repair = await rebuildInvalidIndex(db, INDEX, broken);
        assert.equal(repair.ok, false, "it must not claim success");
        assert.match(repair.error ?? "", /could not be rebuilt/);
        assert.match(repair.error ?? "", /duplicated|duplicate key/i, "the reason is in the message");
        assert.match(repair.error ?? "", /holds rows it would refuse/, "and so is the remedy");
    } finally {
        await cleanup();
        // Leave the database as we found it for the suites that follow.
        await db!.$executeRawUnsafe(`DROP INDEX CONCURRENTLY IF EXISTS "${INDEX}"`).catch(() => {});
        await db!.$executeRawUnsafe(
            toConcurrentIndexSql((INDEX_STATEMENTS as string[]).find(sql => sql.includes(INDEX))!),
        );
    }
});

after(async () => {
    await db?.$disconnect();
});
