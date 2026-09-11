import { prisma } from '@/lib/prisma';
import { hasCronSecret } from '@/lib/cron-auth';
import { resolveCompanyTimeZone } from '@/lib/company-timezone';
import { receiptRecognitionPolicy } from '@/lib/receipt-source-recognition';
import { reviewedReceiptFactsFingerprint } from '@/server/receipt-reviewed-source-facts';
import { reviewedReceiptPairsFingerprint } from '@/server/receipt-reviewed-pair-facts';
import { decimalStringToCents } from '@/lib/receipt-requests';
import { BANK_PULL_CHASER_WINDOW_HOURS } from '@/lib/pipeline-health';
import { createReceiptComponentDiagnosticHandler, loadReceiptComponentDiagnostic } from '@/lib/receipt-component-diagnostic';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

// Strict cron GET; all reads use the normal application client. No writes or external calls.
export const GET = createReceiptComponentDiagnosticHandler({
    authorized: hasCronSecret,
    load: async (query, startedAt) => {
        const zone = await resolveCompanyTimeZone();
        const recognitionEnabled = process.env.RECEIPT_SOURCE_RECOGNITION_ENABLED === 'true';
        return loadReceiptComponentDiagnostic(prisma, query, {
            now: () => new Date(), startedAt, zone, recognitionEnabled,
            policy: receiptRecognitionPolicy(recognitionEnabled, reviewedReceiptFactsFingerprint, reviewedReceiptPairsFingerprint),
            decimalStringToCents, bankPullWindowHours: BANK_PULL_CHASER_WINDOW_HOURS,
        });
    },
});
