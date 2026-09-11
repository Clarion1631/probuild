import { prisma } from '@/lib/prisma';
import { hasCronSecret } from '@/lib/cron-auth';
import { probeDrivePdfContent } from '@/lib/google-drive';
import { lockReceiptEvidence } from '@/lib/receipt-evidence-lock';
import { lockBankLineIdentity } from '@/lib/bank-reconcile-guard';
import { createLegacyRecoveryHandler, loadPinnedRecoveryPacket } from '@/lib/legacy-affidavit-recovery-handler';
import { createLegacyRecoveryService } from '@/lib/legacy-affidavit-recovery-service';
import { loadRecoverySnapshot, writeRecovery } from '@/lib/legacy-affidavit-recovery-store';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export const POST = createLegacyRecoveryHandler({
    authorized: hasCronSecret,
    // Shared normal-answer protection must be active before administrative writes.
    enabled: () => process.env.RECEIPT_MEMO_CONTENT_GUARD_ENABLED === 'true',
    handle: async request => {
        // Request-local immutable configuration: never accept provenance in the body.
        const pinned = loadPinnedRecoveryPacket(process.env);
        const packet = pinned.packet;
        return createLegacyRecoveryService({
            packet: async () => pinned,
            drive: probeDrivePdfContent,
            snapshot: async () => loadRecoverySnapshot(prisma, packet),
            now: () => new Date(),
            transaction: async body => prisma.$transaction(async tx => body({
                snapshot: async () => loadRecoverySnapshot(tx, packet),
                lockEvidence: async () => lockReceiptEvidence(tx),
                lockBankIdentity: async () => lockBankLineIdentity(tx),
                lockContent: async hash => { await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`memo-sha256:${hash}`}))`; },
                lockPdf: async id => { await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`memo-pdf:${id}`}))`; },
                writeRecovery: async record => writeRecovery(tx, record),
            }), { maxWait: 5_000, timeout: 15_000 }),
        }).handle(request);
    },
});
