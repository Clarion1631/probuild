import { Prisma, type PrismaClient } from "@prisma/client";
import { LEGACY_1027, type RepairSnapshot, type RepairTransaction } from "./bank-image-1027-repair";

export function bankImage1027Transaction<T>(db: PrismaClient, run: (tx: RepairTransaction) => Promise<T>): Promise<T> {
    return db.$transaction(async tx => run({
        lock: async () => {
            // FOR UPDATE fences both extraction/ingest updates and a match INSERT's
            // foreign-key KEY SHARE lock. Count matches in a second READ COMMITTED
            // statement so a match that committed while this lock waited is seen.
            const rows = await tx.$queryRaw<Array<{ row: Record<string, unknown>; capturedAtExact: string }>>(Prisma.sql`
                SELECT to_jsonb(b) AS row,
                    to_char(b."capturedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "capturedAtExact"
                FROM "BankImage" b
                WHERE b.source = ${LEGACY_1027.source} AND b."sourceExternalId" = ${LEGACY_1027.sourceExternalId}
                FOR UPDATE
            `);
            const found = rows[0];
            if (!found) return null;
            const matchCount = await tx.bankImageMatch.count({ where: { bankImageId: String(found.row.id) } });
            return { ...found, matchCount };
        },
        replace: async (before: RepairSnapshot, next, secureRef) => {
            // Exact JSON CAS preserves every original timestamp digit. No JS Date
            // equality against the legacy timestamptz(6) column.
            const rows = await tx.$queryRaw<Array<{ row: Record<string, unknown> }>>(Prisma.sql`
                UPDATE "BankImage" b SET
                    "capturedAt" = ${next.capturedAt}, "fileName" = ${next.fileName},
                    mime = ${next.mime}, "byteSize" = ${next.byteSize},
                    "amountCents" = ${next.amountCents}, "driveFileId" = ${secureRef}, "updatedAt" = now()
                WHERE b.id = ${String(before.row.id)} AND to_jsonb(b) = ${JSON.stringify(before.row)}::jsonb
                    AND NOT EXISTS (SELECT 1 FROM "BankImageMatch" m WHERE m."bankImageId" = b.id)
                RETURNING to_jsonb(b) AS row
            `);
            if (rows.length !== 1) throw Error("legacy compare-and-set failed");
            return rows[0].row;
        },
        audit: async snapshot => {
            const before = snapshot.before as Record<string, unknown>;
            await tx.auditLog.create({ data: {
                entity: "BankImage", entityId: String(before.id), action: "repair-redacted-front",
                actorId: null, actorEmail: null,
                snapshot: snapshot as Prisma.InputJsonObject,
            } });
        },
    }), { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 20_000, maxWait: 5_000 });
}
