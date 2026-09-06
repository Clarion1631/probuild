import { createBankImageDiagnosticHandler } from "@/lib/bank-image-diagnostic";
import { prisma } from "@/lib/prisma";
import { SECURE_BUCKET } from "@/lib/secure-storage";
import { getSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export const GET = createBankImageDiagnosticHandler({
    secret: () => process.env.BANK_IMAGE_INGEST_SECRET,
    find: (source, sourceExternalId) => prisma.bankImage.findUnique({
        where: { source_sourceExternalId: { source, sourceExternalId } },
        select: {
            kind: true, source: true, sourceExternalId: true, account: true,
            capturedAt: true, documentDate: true, fileName: true, mime: true,
            byteSize: true, normalizedCheckNumber: true, amountCents: true, driveFileId: true,
        },
    }),
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
