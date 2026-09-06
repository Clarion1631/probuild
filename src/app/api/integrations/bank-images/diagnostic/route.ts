import { createBankImageDiagnosticHandler } from "@/lib/bank-image-diagnostic";
import { prisma } from "@/lib/prisma";
import { SECURE_BUCKET } from "@/lib/secure-storage";
import { getSupabase } from "@/lib/supabase";
import { Prisma } from "@prisma/client";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export const GET = createBankImageDiagnosticHandler({
    secret: () => process.env.BANK_IMAGE_INGEST_SECRET,
    find: (source, sourceExternalId) => prisma.$transaction(async tx => {
        const row = await tx.bankImage.findUnique({
            where: { source_sourceExternalId: { source, sourceExternalId } },
            select: {
                id: true, kind: true, source: true, sourceExternalId: true, account: true,
                capturedAt: true, documentDate: true, fileName: true, mime: true,
                byteSize: true, normalizedCheckNumber: true, amountCents: true, driveFileId: true,
                payerName: true, memoText: true, extractionModel: true,
                _count: { select: { matches: true } },
            },
        });
        if (!row) return null;
        // Return PostgreSQL's complete timestamp precision; JS Date drops the
        // final three digits. Both reads share one snapshot, without row locks.
        const exact = await tx.$queryRaw<Array<{ capturedAtExact: string; updatedAtExact: string; extractedAtExact: string | null }>>(Prisma.sql`
            SELECT
                to_char("capturedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "capturedAtExact",
                to_char("updatedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updatedAtExact",
                to_char("extractedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "extractedAtExact"
            FROM "BankImage" WHERE id = ${row.id}
        `);
        if (exact.length !== 1) throw Error("evidence snapshot unavailable");
        return { ...row, evidence: { ...exact[0], payerName: row.payerName, memoText: row.memoText, extractionModel: row.extractionModel, matchCount: row._count.matches } };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }),
    storagePresence: async (path) => {
        const supabase = getSupabase();
        if (!supabase) return "unavailable";
        const { data, error } = await supabase.storage.from(SECURE_BUCKET).info(path);
        if (data && !error) return "present";
        // An outage or permission error is not evidence of a missing image.
        if (error && "status" in error && error.status === 404) return "missing";
        return "unavailable";
    },
});
