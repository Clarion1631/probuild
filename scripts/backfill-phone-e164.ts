// One-shot backfill: populate Client.primaryPhoneE164 + additionalPhoneE164
// from existing Client.primaryPhone / additionalPhone values.
//
// Run with:
//   node --import tsx scripts/backfill-phone-e164.ts
// (or via PowerShell from the project root)
//
// Idempotent: only updates rows where the E164 column is currently NULL,
// and only writes a value if normalizeE164 returns one. Safe to re-run.

import { prisma } from "../src/lib/prisma";
import { normalizeE164 } from "../src/lib/phone";

async function main() {
    const candidates = await prisma.client.findMany({
        where: {
            OR: [
                { AND: [{ primaryPhone: { not: null } }, { primaryPhoneE164: null }] },
                { AND: [{ additionalPhone: { not: null } }, { additionalPhoneE164: null }] },
            ],
        },
        select: {
            id: true,
            primaryPhone: true,
            additionalPhone: true,
            primaryPhoneE164: true,
            additionalPhoneE164: true,
        },
    });

    let updated = 0;
    let unparseable = 0;

    for (const c of candidates) {
        const data: { primaryPhoneE164?: string; additionalPhoneE164?: string } = {};

        if (c.primaryPhone && !c.primaryPhoneE164) {
            const e = normalizeE164(c.primaryPhone);
            if (e) data.primaryPhoneE164 = e;
            else unparseable++;
        }
        if (c.additionalPhone && !c.additionalPhoneE164) {
            const e = normalizeE164(c.additionalPhone);
            if (e) data.additionalPhoneE164 = e;
            else unparseable++;
        }

        if (Object.keys(data).length === 0) continue;
        await prisma.client.update({ where: { id: c.id }, data });
        updated++;
    }

    console.log(`[backfill-phone-e164] candidates=${candidates.length} updated=${updated} unparseable=${unparseable}`);
}

main()
    .catch((e) => {
        console.error("[backfill-phone-e164] FAIL:", e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
