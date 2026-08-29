import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import {
    upsertQboPurchaseClassification,
    type QboPurchaseClassificationPersistenceClient,
} from "../src/lib/qbo-expense-sync";

const databaseUrl = process.env.QBO_CLASSIFICATION_PERSISTENCE_TEST_URL;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function assertDisposableLocalDatabase(url: string): void {
    const parsed = new URL(url);
    assert.ok(
        ["127.0.0.1", "localhost"].includes(parsed.hostname),
        "QBO_CLASSIFICATION_PERSISTENCE_TEST_URL must target a disposable local PostgreSQL database",
    );
    assert.equal(
        /supabase/i.test(url),
        false,
        "persistence integration test must never target Supabase",
    );
    // A localhost URL is not proof of disposability: a tunnel or port-forward to a
    // real database also answers on 127.0.0.1, and this suite DROPs a table. Require
    // the database itself to be named as disposable, and require an explicit ack.
    assert.match(
        parsed.pathname,
        /(disposable|scratch|_test|-test)/i,
        "QBO_CLASSIFICATION_PERSISTENCE_TEST_URL database name must contain disposable, scratch, or test",
    );
    assert.equal(
        process.env.QBO_CLASSIFICATION_PERSISTENCE_TEST_DISPOSABLE,
        "yes",
        "set QBO_CLASSIFICATION_PERSISTENCE_TEST_DISPOSABLE=yes to confirm the target database may be dropped",
    );
}

test(
    "classification upsert persists a create when updatedAt has no database default",
    { skip: !databaseUrl && "set QBO_CLASSIFICATION_PERSISTENCE_TEST_URL to a disposable local PostgreSQL URL" },
    async () => {
        assertDisposableLocalDatabase(databaseUrl!);
        const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });

        try {
            // This deliberately matches the original production table shape:
            // updatedAt is NOT NULL and has no database default. A Prisma create
            // that omits updatedAt must fail here rather than being hidden by a mock.
            await db.$executeRawUnsafe('DROP TABLE IF EXISTS "QboPurchaseClassification"');
            await db.$executeRawUnsafe(`
                CREATE TABLE "QboPurchaseClassification" (
                    "qbPurchaseId" TEXT NOT NULL PRIMARY KEY,
                    "classification" TEXT NOT NULL,
                    "reason" TEXT,
                    "qbSyncToken" TEXT,
                    "classifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    "updatedAt" TIMESTAMP(3) NOT NULL
                )
            `);

            await upsertQboPurchaseClassification(
                db as unknown as QboPurchaseClassificationPersistenceClient,
                {
                    qbPurchaseId: "purchase-persistence-1",
                    classification: "job-cost",
                    reason: null,
                    qbSyncToken: "0",
                },
            );

            const row = await db.qboPurchaseClassification.findUnique({
                where: { qbPurchaseId: "purchase-persistence-1" },
            });
            assert.deepEqual(row && {
                qbPurchaseId: row.qbPurchaseId,
                classification: row.classification,
                reason: row.reason,
                qbSyncToken: row.qbSyncToken,
                hasUpdatedAt: row.updatedAt instanceof Date,
            }, {
                qbPurchaseId: "purchase-persistence-1",
                classification: "job-cost",
                reason: null,
                qbSyncToken: "0",
                hasUpdatedAt: true,
            });
        } finally {
            await db.$disconnect();
        }
    },
);

test(
    "classification migration repairs the updatedAt database default for existing tables",
    { skip: !databaseUrl && "set QBO_CLASSIFICATION_PERSISTENCE_TEST_URL to a disposable local PostgreSQL URL" },
    async () => {
        assertDisposableLocalDatabase(databaseUrl!);
        const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });

        try {
            execFileSync(process.execPath, ["scripts/apply-qbo-purchase-classification.mjs"], {
                cwd: root,
                env: { ...process.env, DATABASE_URL: databaseUrl! },
                stdio: "pipe",
            });

            const inserted = await db.$queryRawUnsafe<Array<{ updatedAt: Date }>>(`
                INSERT INTO "QboPurchaseClassification" (
                    "qbPurchaseId", "classification", "reason", "qbSyncToken"
                ) VALUES ('purchase-migration-default-1', 'job-cost', NULL, NULL)
                RETURNING "updatedAt"
            `);
            assert.equal(inserted.length, 1);
            assert.ok(inserted[0].updatedAt instanceof Date);
        } finally {
            await db.$disconnect();
        }
    },
);
