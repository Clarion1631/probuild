import { createBankImage1027RepairHandler, verifyRepairStorage } from "@/lib/bank-image-1027-repair";
import { bankImage1027Transaction } from "@/lib/bank-image-1027-repair-db";
import { preparePrivateBankImage } from "@/lib/bank-image-private";
import { prisma } from "@/lib/prisma";
import { SECURE_BUCKET } from "@/lib/secure-storage";
import { getSupabase } from "@/lib/supabase";

export const maxDuration = 30;
export const POST = createBankImage1027RepairHandler({
    secret: () => process.env.BANK_IMAGE_INGEST_SECRET,
    prepare: preparePrivateBankImage,
    transaction: run => bankImage1027Transaction(prisma, run),
    verifyStorage: async (prepared, bytes) => {
        const supabase = getSupabase();
        if (!supabase) throw Error("private storage unavailable");
        await verifyRepairStorage(prepared, bytes, {
            upload: async (path, data, metadata) => ({ error: !!(await supabase.storage.from(SECURE_BUCKET).upload(path, data, { contentType: "image/jpeg", upsert: false, metadata })).error }),
            download: async path => {
                const { data } = await supabase.storage.from(SECURE_BUCKET).download(path);
                return data ? Buffer.from(await data.arrayBuffer()) : null;
            },
        });
    },
});
