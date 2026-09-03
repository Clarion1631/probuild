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

test("N groups of one old-build transaction get N distinct ordinals", { skip }, async () => {
    await seed();
    await installBridge();
    try {
        await db!.$transaction(async tx => {
            const raw = tx as unknown as { $executeRawUnsafe(q: string, ...v: unknown[]): Promise<unknown> };
            await raw.$executeRawUnsafe(OLD_INSERT, `${PFX}-g0`, 10, FILE_URL, ESTIMATE);
            await raw.$executeRawUnsafe(OLD_INSERT, `${PFX}-g1`, 20, FILE_URL, ESTIMATE);
            await raw.$executeRawUnsafe(OLD_INSERT, `${PFX}-g2`, 30, FILE_URL, ESTIMATE);
        });
        const rows = await rowsForFile();
        assert.deepEqual(rows.map(r => r.sourceGroupIndex), [0, 1, 2]);
    } finally {
        await cleanup();
    }
});

test("a SECOND old-build delivery of the same file is refused, not duplicated", { skip }, async () => {
    // The ordinal counts within the TRANSACTION, so a re-delivery starts at 0
    // again and collides with the row already there. The unique index refuses
    // it, the old instance sees an error, and its Apps Script does not archive
    // the file — which is the correct outcome for a document already booked.
    await seed();
    await installBridge();
    try {
        await oldStyleInsert(db!, `${PFX}-first`);
        let error: unknown = null;
        await oldStyleInsert(db!, `${PFX}-second`).catch(caught => { error = caught; });
        assert.ok(error, "the second delivery must fail");
        // Postgres names the constraint and the colliding key; Prisma passes
        // the message through with SQLSTATE 23505 (unique_violation).
        assert.match(String((error as { message?: string })?.message ?? error), /23505|already exists/i);
        assert.equal((await rowsForFile()).length, 1, "exactly one copy survives");
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
    // The other order. The new build writes ordinal 0 for its single group; the
    // old instance's retry starts its own count at 0 and collides, so the
    // duplicate is refused by the index rather than landing beside it.
    await seed();
    await installBridge();
    try {
        const res = await ingest(PAYLOAD);
        assert.equal((await res.json() as { created?: number }).created, 1);

        let error: unknown = null;
        await oldStyleInsert(db!, `${PFX}-late`).catch(caught => { error = caught; });
        assert.ok(error, "the old build's second copy must be refused");
        assert.equal((await rowsForFile()).length, 1, "still exactly one row for this file");
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
