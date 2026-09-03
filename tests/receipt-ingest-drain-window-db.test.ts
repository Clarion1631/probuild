/**
 * THE MIXED-VERSION DRAIN WINDOW, AGAINST A REAL POSTGRES (Codex round 48,
 * item 1).
 *
 * During the rollout, old instances are still serving
 * `/api/integrations/receipt-ingest`. Their Prisma client predates
 * `sourceFileId`/`sourceGroupIndex`, so every row they insert carries NULL in
 * both — including rows inserted AFTER the pre-deploy `SOURCE_FILE_ID_BACKFILL`
 * has already run. The NEW route dedupes on `sourceFileId`, so it cannot see
 * those rows: a delivery whose response was lost, retried against a new
 * instance, inserts the whole receipt a second time. The `--post-deploy`
 * backfill then stamps the legacy row and the duplicate is permanent, and the
 * partial unique index never objected because it only covers rows where
 * `sourceFileId` is NOT NULL — which the legacy row was not, at insert time.
 *
 * Two halves of one fix are exercised here, and only a real server can show
 * either:
 *
 *   * the BRIDGE TRIGGER stamps an old-style insert and takes the same
 *     per-file advisory lock the route takes, so the two versions serialize;
 *   * the route's locked dedupe finds the stamped row and answers
 *     `alreadyIngested` instead of writing a second copy.
 *
 * Each test carries its CONTROL: the same interleaving with the trigger absent
 * duplicates the receipt, which is what production would have done.
 *
 * Opt-in by design: it needs a THROWAWAY database and it writes rows. It runs
 * in CI's migrations job and skips everywhere else, including anywhere
 * DATABASE_URL looks like production.
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import {
    SOURCE_FILE_BRIDGE_DROP_SQL,
    SOURCE_FILE_BRIDGE_SQL,
    SOURCE_FILE_ID_BACKFILL,
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

/** Two CONNECTIONS: the "old instance" and the "new instance" must be able to block on each other. */
const oldBuild = url && !looksLikeProd ? new PrismaClient({ datasources: { db: { url } } }) : null;
const db = url && !looksLikeProd ? new PrismaClient({ datasources: { db: { url } } }) : null;

/** The REAL route handler, on the real singleton, pointed at this database. */
let POST: (req: Request) => Promise<Response>;

const SECRET = "drain-window-test-secret";

before(async () => {
    if (!url || looksLikeProd) return;
    const pooled = new URL(url);
    pooled.searchParams.set("pgbouncer", "true");
    process.env.DATABASE_URL = pooled.toString();
    process.env.RECEIPT_INGEST_SECRET = SECRET;
    const mod = await import("../src/app/api/integrations/receipt-ingest/route");
    POST = mod.POST as unknown as (req: Request) => Promise<Response>;
});

const PFX = "drain-db";
const CLIENT = `${PFX}-client`;
const PROJECT = `${PFX}-project`;
const ESTIMATE = `${PFX}-estimate`;
const CODE = `${PFX}-costcode`;
const ITEM = `${PFX}-item`;
const FILE = `${PFX}-drive-file`;
const FILE_URL = `https://drive.google.com/file/d/${FILE}/view`;
const PROJECT_NAME = "Drain Window Job";

function gate() {
    let open!: () => void;
    const reached = new Promise<void>(resolve => (open = resolve));
    return { reached, open };
}

async function cleanup() {
    if (!db) return;
    // By ID PREFIX as well: the control test deliberately rewrites a row's
    // receiptUrl, which takes it out of reach of the other two arms.
    await db.expense.deleteMany({
        where: { OR: [{ sourceFileId: FILE }, { receiptUrl: FILE_URL }, { id: { startsWith: PFX } }] },
    });
    await db.estimateItem.deleteMany({ where: { id: ITEM } });
    await db.estimate.deleteMany({ where: { id: ESTIMATE } });
    await db.project.deleteMany({ where: { id: PROJECT } });
    await db.costCode.deleteMany({ where: { id: CODE } });
    await db.client.deleteMany({ where: { id: CLIENT } });
}

async function seed() {
    await cleanup();
    await db!.client.create({ data: { id: CLIENT, name: "Drain Window", initials: "DW" } });
    await db!.project.create({
        data: { id: PROJECT, name: PROJECT_NAME, clientId: CLIENT, status: "In Progress" },
    });
    await db!.costCode.create({ data: { id: CODE, code: "03-PLUMB", name: "Plumbing", isActive: true } });
    await db!.estimate.create({
        data: {
            id: ESTIMATE, title: "Drain Window", code: `EST-${PFX}`, projectId: PROJECT,
            status: "Approved", totalAmount: 1000, balanceDue: 1000,
        },
    });
    await db!.estimateItem.create({
        data: { id: ITEM, estimateId: ESTIMATE, name: "rough-in", costCodeId: CODE },
    });
}

async function installBridge() {
    for (const sql of SOURCE_FILE_BRIDGE_SQL) await db!.$executeRawUnsafe(sql);
}
async function removeBridge() {
    for (const sql of SOURCE_FILE_BRIDGE_DROP_SQL) await db!.$executeRawUnsafe(sql);
}

/**
 * An OLD instance's insert, verbatim: it names neither new column, because its
 * client does not know they exist. Raw SQL for exactly that reason — a Prisma
 * client generated from today's schema cannot express the old shape.
 */
const OLD_INSERT =
    `INSERT INTO "Expense" (id, amount, vendor, description, status, date, "receiptUrl", "estimateId", "createdAt", "updatedAt")
     VALUES ($1, $2, 'Home Depot', 'old build row', 'Pending', now(), $3, $4, now(), now())`;

async function oldStyleInsert(client: PrismaClient, id: string, amount = 120.5) {
    await client.$executeRawUnsafe(OLD_INSERT, id, amount, FILE_URL, ESTIMATE);
}

function ingest(body: Record<string, unknown>) {
    return POST(new Request("https://probuild.test/api/integrations/receipt-ingest", {
        method: "POST",
        headers: { "x-ingest-key": SECRET, "content-type": "application/json" },
        body: JSON.stringify(body),
    }));
}

/** A url with no derivable Drive id: a shortened link, as Drive sometimes returns. */
const SHORT_URL = "https://drive.google.com/open-short/abcdef";

/** Three groups of one receipt, the shape the old handler writes one row at a time. */
const THREE_GROUPS = [
    { category: "Plumbing", amount: 10 },
    { category: "Plumbing", amount: 20 },
    { category: "Plumbing", amount: 30 },
];

/**
 * THE PRE-FIX BRIDGE, kept verbatim so the control is the real thing rather
 * than a description of it. Transaction-local counter: three autocommit
 * inserts each start at 0.
 */
const PRE_FIX_BRIDGE_FUNCTION = `
    CREATE OR REPLACE FUNCTION probuild_expense_source_file_bridge()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $bridge$
    DECLARE
        derived TEXT;
        next_index INT;
        counter_key TEXT;
    BEGIN
        IF NEW."sourceFileId" IS NULL AND NEW."receiptUrl" IS NOT NULL THEN
            derived := COALESCE(
                substring(NEW."receiptUrl" from '/d/([A-Za-z0-9_-]+)'),
                substring(NEW."receiptUrl" from '[?&]id=([A-Za-z0-9_-]+)')
            );
            NEW."sourceFileId" := derived;
        END IF;
        IF NEW."sourceFileId" IS NULL THEN
            RETURN NEW;
        END IF;
        PERFORM pg_advisory_xact_lock(
            hashtextextended('receipt-ingest:' || NEW."sourceFileId", 0)
        );
        IF NEW."sourceGroupIndex" IS NULL THEN
            counter_key := 'probuild.bridge_' || md5(NEW."sourceFileId");
            next_index := COALESCE(NULLIF(current_setting(counter_key, true), '')::int, -1) + 1;
            PERFORM set_config(counter_key, next_index::text, true);
            NEW."sourceGroupIndex" := next_index;
        END IF;
        RETURN NEW;
    END;
    $bridge$`;

const PAYLOAD = {
    projectName: PROJECT_NAME,
    vendor: "Home Depot",
    date: "2026-08-14",
    fileId: FILE,
    fileUrl: FILE_URL,
    groups: [{ category: "Plumbing", amount: 120.5 }],
};

const rowsForFile = async () =>
    db!.expense.findMany({
        where: { OR: [{ sourceFileId: FILE }, { receiptUrl: FILE_URL }] },
        select: { id: true, sourceFileId: true, sourceGroupIndex: true, amount: true },
        orderBy: { id: "asc" },
    });

after(async () => {
    if (!db) return;
    await removeBridge().catch(() => {});
    await cleanup();
    await db.$disconnect();
    await oldBuild?.$disconnect();
});

test("CONTROL: without the bridge, an old-build row is invisible and the receipt duplicates", { skip }, async () => {
    await seed();
    try {
        await removeBridge().catch(() => {});
        // The old instance lands its row. `sourceFileId` is NULL, because its
        // client has never heard of the column.
        await oldStyleInsert(db!, `${PFX}-legacy`);
        const legacy = await rowsForFile();
        assert.equal(legacy.length, 1);
        assert.equal(legacy[0].sourceFileId, null, "an old-build row names no file");

        // ...and the pre-deploy backfill has ALREADY run, so nothing stamps it.
        // The new route is then asked for the same document. The receipt-url
        // arm of the dedupe is what catches it (round 48, item 1, second half),
        // so this control isolates the trigger by deleting that row's url.
        await db!.$executeRawUnsafe(
            `UPDATE "Expense" SET "receiptUrl" = $1 WHERE id = $2`,
            "https://drive.google.com/uc?export=view", `${PFX}-legacy`,
        );
        const res = await ingest(PAYLOAD);
        const json = await res.json() as { created?: number; alreadyIngested?: boolean };
        assert.equal(json.alreadyIngested, undefined, "the new build cannot see the old row");
        assert.equal(json.created, 1, "so it writes the receipt a second time");

        // The duplicate the --post-deploy backfill would then make permanent.
        await db!.$executeRawUnsafe(SOURCE_FILE_ID_BACKFILL);
        const after = await db!.expense.findMany({
            where: { OR: [{ sourceFileId: FILE }, { id: `${PFX}-legacy` }] },
            select: { id: true },
        });
        assert.equal(after.length, 2, "two rows for one delivery — the failure this bridge exists to stop");
    } finally {
        await cleanup();
        await installBridge();
    }
});

test("the bridge stamps an old-build insert on the way in", { skip }, async () => {
    await seed();
    await installBridge();
    try {
        await oldStyleInsert(db!, `${PFX}-stamped`);
        const rows = await rowsForFile();
        assert.equal(rows.length, 1);
        assert.equal(rows[0].sourceFileId, FILE, "derived from the Drive url, at INSERT time");
        assert.equal(rows[0].sourceGroupIndex, 0, "and given the first ordinal");
    } finally {
        await cleanup();
    }
});

test("a 3-group delivery at the OLD HANDLER'S boundaries lands all three", { skip }, async () => {
    // ROUND 49, ITEM 1 — the P0. The deployed handler does NOT wrap its groups
    // in a transaction: it calls prisma.expense.create() once per group, each
    // its own autocommit statement. Wrapping them in one transaction, as the
    // first version of this test did, tested a shape production never
    // produces — and hid that the transaction-local counter gave every group
    // ordinal 0, so group two died on the unique index and was lost.
    await seed();
    await installBridge();
    try {
        await oldStyleInsert(db!, `${PFX}-g0`, 10);
        await oldStyleInsert(db!, `${PFX}-g1`, 20);
        await oldStyleInsert(db!, `${PFX}-g2`, 30);

        const rows = await rowsForFile();
        assert.equal(rows.length, 3, "all three groups are in the table");
        assert.deepEqual(rows.map(r => r.sourceGroupIndex).sort((a, b) => (a ?? 0) - (b ?? 0)), [0, 1, 2]);
        assert.deepEqual(
            rows.map(r => Number(r.amount)).sort((a, b) => a - b),
            [10, 20, 30],
            "and the money is all of it, not just the first group",
        );
    } finally {
        await cleanup();
    }
});

test("CONTROL: a transaction-local ordinal loses groups two and three", { skip }, async () => {
    // The pre-fix bridge, verbatim, installed for this test only: the counter
    // lives in a transaction-local GUC, so three autocommit inserts each start
    // at 0. This is what production would have done to a three-group receipt.
    await seed();
    await removeBridge().catch(() => {});
    try {
        await db!.$executeRawUnsafe(PRE_FIX_BRIDGE_FUNCTION);
        await db!.$executeRawUnsafe(`DROP TRIGGER IF EXISTS probuild_expense_source_file_bridge ON "Expense"`);
        await db!.$executeRawUnsafe(
            `CREATE TRIGGER probuild_expense_source_file_bridge
             BEFORE INSERT ON "Expense" FOR EACH ROW
             EXECUTE FUNCTION probuild_expense_source_file_bridge()`,
        );

        await oldStyleInsert(db!, `${PFX}-g0`, 10);
        let second: unknown = null;
        await oldStyleInsert(db!, `${PFX}-g1`, 20).catch(caught => { second = caught; });
        let third: unknown = null;
        await oldStyleInsert(db!, `${PFX}-g2`, 30).catch(caught => { third = caught; });

        assert.ok(second, "group two collides on ordinal 0");
        assert.ok(third, "and so does group three");
        assert.equal((await rowsForFile()).length, 1, "two thirds of the receipt is gone");

        // ...and the retry against the new route then calls it done, which is
        // how the loss becomes permanent.
        const res = await ingest({ ...PAYLOAD, groups: THREE_GROUPS });
        const json = await res.json() as { alreadyIngested?: boolean; created?: number };
        assert.equal(json.alreadyIngested, undefined, "the SHIPPED route resumes rather than reporting done");
        assert.equal(json.created, 2, "it lands the two groups the old handler lost");
    } finally {
        await removeBridge().catch(() => {});
        await cleanup();
        await installBridge();
    }
});

test("a retry after a PARTIAL old delivery lands the missing groups, not nothing", { skip }, async () => {
    // The other half of the P0: a crash (or a lost response) after group one
    // leaves exactly one row. The old rule — any row for this file means the
    // document is done — answered alreadyIngested and the rest of the receipt
    // was dropped for good.
    await seed();
    await installBridge();
    try {
        await oldStyleInsert(db!, `${PFX}-partial`, 10);
        assert.equal((await rowsForFile()).length, 1, "the crash left one group behind");

        const res = await ingest({ ...PAYLOAD, groups: THREE_GROUPS });
        const json = await res.json() as { created?: number; alreadyIngested?: boolean };
        assert.equal(json.alreadyIngested, undefined, "not 'done' — there are two groups still missing");
        assert.equal(json.created, 2);

        const rows = await rowsForFile();
        assert.equal(rows.length, 3, "the document is whole");
        assert.deepEqual(
            rows.map(r => r.sourceGroupIndex).sort((a, b) => (a ?? 0) - (b ?? 0)),
            [0, 1, 2],
            "distinct ordinals, no duplicate of group one",
        );

        // ...and a SECOND retry of the complete document adds nothing.
        const again = await ingest({ ...PAYLOAD, groups: THREE_GROUPS });
        assert.deepEqual(await again.json(), { ok: true, alreadyIngested: true, created: 0 });
        assert.equal((await rowsForFile()).length, 3);
    } finally {
        await cleanup();
    }
});

test("an UNPARSEABLE url still serializes an old insert against the new route", { skip }, async () => {
    // ROUND 49, ITEM 2. No /d/<id> and no ?id=<id>, so the bridge can derive
    // nothing — and used to return without taking any lock, which left the new
    // route reading "nothing here" while the old insert was still in flight.
    // The normalised url is the identity both sides hash instead.
    await seed();
    await installBridge();
    try {
        const inserted = gate();
        let oldError: unknown = null;
        const oldSide = (async () => {
            try {
                await oldBuild!.$transaction(async tx => {
                    const raw = tx as unknown as { $executeRawUnsafe(q: string, ...v: unknown[]): Promise<unknown> };
                    await raw.$executeRawUnsafe(OLD_INSERT, `${PFX}-short`, 120.5, SHORT_URL, ESTIMATE);
                    inserted.open();
                    await new Promise(resolve => setTimeout(resolve, 750));
                }, { timeout: 30_000 });
            } catch (caught) {
                oldError = caught;
            }
        })();

        await inserted.reached;
        const res = await ingest({ ...PAYLOAD, fileUrl: SHORT_URL });
        const json = await res.json() as { created?: number; alreadyIngested?: boolean };
        await oldSide;

        assert.equal(oldError, null, `the old insert failed: ${oldError}`);
        assert.equal(json.alreadyIngested, true, "it waited for the old insert, then saw it");
        assert.equal(json.created, 0);
        const rows = await db!.expense.findMany({
            where: { receiptUrl: SHORT_URL }, select: { id: true, sourceFileId: true },
        });
        assert.equal(rows.length, 1, "one delivery, one row");
        assert.equal(rows[0].sourceFileId, null, "and no fake file id was invented for it");
    } finally {
        await db!.expense.deleteMany({ where: { receiptUrl: SHORT_URL } });
        await cleanup();
    }
});

test("THE TRADE: a second OLD delivery appends, and the new route still refuses one", { skip }, async () => {
    // Stated plainly, because round 49 changed it. With ordinals counted per
    // TRANSACTION, a re-delivery restarted at 0 and died on the unique index —
    // which looked like a free dedupe and was actually the P0: the old handler
    // writes each group in its own autocommit, so that same rule killed group
    // TWO of a first delivery and lost it.
    //
    // Counting COMMITTED rows fixes the loss and gives up the accidental
    // dedupe: a second old-handler delivery appends. That is exactly what the
    // old build does today with no bridge at all, it is guarded by the old
    // handler's own url dedupe, and a duplicate a human can see on the expense
    // list is a smaller failure than money silently missing from a receipt the
    // archive says was imported.
    //
    // What this PR is responsible for — the NEW route never adding a copy —
    // still holds, and is asserted here rather than assumed.
    await seed();
    await installBridge();
    try {
        await oldStyleInsert(db!, `${PFX}-first`);
        await oldStyleInsert(db!, `${PFX}-second`);
        const rows = await rowsForFile();
        assert.equal(rows.length, 2, "the old build appends, as it always did");
        assert.deepEqual(rows.map(r => r.sourceGroupIndex).sort((a, b) => (a ?? 0) - (b ?? 0)), [0, 1],
            "with distinct ordinals, so neither insert is lost");

        // The new route, asked for the same one-group document, adds nothing:
        // group 0 is present, so there is nothing missing to resume.
        const res = await ingest(PAYLOAD);
        assert.deepEqual(await res.json(), { ok: true, alreadyIngested: true, created: 0 });
        assert.equal((await rowsForFile()).length, 2, "no third copy");
    } finally {
        await cleanup();
    }
});

test("old-build insert FIRST, then the new route: one receipt, no duplicate", { skip }, async () => {
    await seed();
    await installBridge();
    try {
        await oldStyleInsert(db!, `${PFX}-legacy`);
        const res = await ingest(PAYLOAD);
        const json = await res.json() as { created?: number; alreadyIngested?: boolean };
        assert.equal(json.alreadyIngested, true, "the stamped row is visible to the new dedupe");
        assert.equal(json.created, 0);
        assert.equal((await rowsForFile()).length, 1);
    } finally {
        await cleanup();
    }
});

test("...and they SERIALIZE: an in-flight old insert blocks the new route", { skip }, async () => {
    // The lock is the half a sequential test cannot show. The old insert takes
    // the per-file advisory lock inside its trigger and holds it until COMMIT;
    // the route takes the same key before its authoritative dedupe, so it
    // cannot read "nothing here" while the other transaction is mid-flight.
    await seed();
    await installBridge();
    try {
        const inserted = gate();
        let oldError: unknown = null;
        const oldSide = (async () => {
            try {
                await oldBuild!.$transaction(async tx => {
                    const raw = tx as unknown as { $executeRawUnsafe(q: string, ...v: unknown[]): Promise<unknown> };
                    await raw.$executeRawUnsafe(OLD_INSERT, `${PFX}-inflight`, 120.5, FILE_URL, ESTIMATE);
                    inserted.open();
                    // Long enough that the route has certainly reached its lock.
                    await new Promise(resolve => setTimeout(resolve, 750));
                }, { timeout: 30_000 });
            } catch (caught) {
                oldError = caught;
            }
        })();

        await inserted.reached;
        const res = await ingest(PAYLOAD);
        const json = await res.json() as { created?: number; alreadyIngested?: boolean };
        await oldSide;

        assert.equal(oldError, null, `the old insert failed: ${oldError}`);
        assert.equal(json.alreadyIngested, true, "it waited, then saw the committed row");
        assert.equal(json.created, 0);
        assert.equal((await rowsForFile()).length, 1, "one delivery, one row");
    } finally {
        await cleanup();
    }
});

test("the NEW route first, then an old-build delivery of the same file", { skip }, async () => {
    // The other order. The new build writes ordinal 0; a straggler old instance
    // appends at 1 (see THE TRADE above — its own url dedupe is what stops it
    // in production, and this PR does not change that handler). What must hold
    // is that nothing is LOST and that the new route does not then add a third.
    await seed();
    await installBridge();
    try {
        const res = await ingest(PAYLOAD);
        assert.equal((await res.json() as { created?: number }).created, 1);

        await oldStyleInsert(db!, `${PFX}-late`);
        const rows = await rowsForFile();
        assert.deepEqual(rows.map(r => r.sourceGroupIndex).sort((a, b) => (a ?? 0) - (b ?? 0)), [0, 1]);

        const again = await ingest(PAYLOAD);
        assert.deepEqual(await again.json(), { ok: true, alreadyIngested: true, created: 0 });
        assert.equal((await rowsForFile()).length, 2, "the new route added nothing");
    } finally {
        await cleanup();
    }
});

test("an expense with no Drive url is untouched by the bridge", { skip }, async () => {
    // Every expense insert in the system passes through this trigger. One that
    // carries no receipt url must not be stamped, must not take a lock, and
    // must not be given an ordinal.
    await seed();
    await installBridge();
    try {
        await db!.$executeRawUnsafe(
            `INSERT INTO "Expense" (id, amount, vendor, status, date, "estimateId", "createdAt", "updatedAt")
             VALUES ($1, 42, 'Cash', 'Pending', now(), $2, now(), now())`,
            `${PFX}-plain`, ESTIMATE,
        );
        const row = await db!.expense.findUnique({
            where: { id: `${PFX}-plain` },
            select: { sourceFileId: true, sourceGroupIndex: true },
        });
        assert.deepEqual(row, { sourceFileId: null, sourceGroupIndex: null });
    } finally {
        await db!.expense.deleteMany({ where: { id: `${PFX}-plain` } });
        await cleanup();
    }
});
