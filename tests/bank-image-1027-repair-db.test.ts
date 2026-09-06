import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { bankImage1027Transaction } from "../src/lib/bank-image-1027-repair-db";
import { LEGACY_1027, REPLACEMENT_1027, type RepairSnapshot } from "../src/lib/bank-image-1027-repair";

const url = process.env.BANK_IMAGE_REPAIR_TEST_URL;
const skip = !url && "requires explicitly supplied disposable PostgreSQL";
const id = "bank-image-1027-repair-test";
const next = { ...REPLACEMENT_1027, kind: "CHECK_FRONT" as const, capturedAt: new Date(REPLACEMENT_1027.capturedAt), documentDate: new Date(REPLACEMENT_1027.documentDate) };
const ref = "secure:bank-images/test-only.jpg";
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }

test("real PostgreSQL preserves microseconds, rolls audit failure back, and fences match inserts", { skip }, async () => {
    assert.ok(url);
    assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname), "test refuses non-local databases");
    const db = new PrismaClient({ datasources: { db: { url } } });
    let seeded = false;
    try {
        assert.equal(await db.bankImage.findUnique({ where: { source_sourceExternalId: { source: LEGACY_1027.source, sourceExternalId: LEGACY_1027.sourceExternalId } } }), null, "do not replace existing evidence even in test DB");
        await db.bankImage.create({ data: { id, ...LEGACY_1027, documentDate: new Date(LEGACY_1027.documentDate), capturedAt: new Date("2026-08-19T10:12:41.451Z") } });
        seeded = true;
        await db.$executeRaw`UPDATE "BankImage" SET "capturedAt" = '2026-08-19T10:12:41.451123Z'::timestamptz WHERE id = ${id}`;
        let original!: RepairSnapshot;
        await assert.rejects(bankImage1027Transaction(db, async tx => {
            original = (await tx.lock())!;
            assert.equal(original.capturedAtExact, "2026-08-19T10:12:41.451123Z");
            assert.match(String(original.row.capturedAt), /451123/);
            const after = await tx.replace(original, next, ref);
            await tx.audit({ before: original.row, after, credentialLabel: "BANK_IMAGE_INGEST_SECRET" });
            throw Error("simulate failure before transaction commit");
        }));
        assert.equal(await db.auditLog.count({ where: { entityId: id } }), 0);
        assert.equal((await db.bankImage.findUniqueOrThrow({ where: { id } })).driveFileId, null);
        await bankImage1027Transaction(db, async tx => {
            const before = (await tx.lock())!;
            const altered = structuredClone(before); altered.row.capturedAt = String(altered.row.capturedAt).replace("451123", "451124");
            await assert.rejects(tx.replace(altered, next, ref), /compare-and-set/);
        });

        const locked = deferred(); const release = deferred(); let matchFinished = false;
        const holder = bankImage1027Transaction(db, async tx => { await tx.lock(); locked.resolve(); await release.promise; });
        await locked.promise;
        const match = db.bankImageMatch.create({ data: { id: `${id}-match`, bankImageId: id, qbType: "Purchase", qbTxnId: "test-only", confirmedBy: "test-only" } }).then(() => { matchFinished = true; });
        // Attach rejection handling immediately while the lock assertion waits.
        // Awaiting match below still propagates any failure to the test.
        void match.catch(() => {});
        try { await new Promise(r => setTimeout(r, 200)); assert.equal(matchFinished, false, "FOR UPDATE must block the FK insert"); }
        finally { release.resolve(); await holder; }
        await match;
        await bankImage1027Transaction(db, async tx => { assert.equal((await tx.lock())!.matchCount, 1); });
        await db.bankImageMatch.delete({ where: { bankImageId: id } });

        await bankImage1027Transaction(db, async tx => {
            const before = (await tx.lock())!; const after = await tx.replace(before, next, ref);
            await tx.audit({ before: before.row, after, credentialLabel: "BANK_IMAGE_INGEST_SECRET" });
        });
        const audit = await db.auditLog.findFirstOrThrow({ where: { entityId: id } });
        assert.equal(audit.actorId, null); assert.equal(audit.actorEmail, null);
        assert.match(JSON.stringify(audit.snapshot), /451123/);
        assert.equal((await db.bankImage.findUniqueOrThrow({ where: { id } })).driveFileId, ref);
    } finally {
        if (seeded) {
            await db.bankImageMatch.deleteMany({ where: { bankImageId: id } });
            await db.auditLog.deleteMany({ where: { entityId: id } });
            await db.bankImage.delete({ where: { id } });
        }
        await db.$disconnect();
    }
});
