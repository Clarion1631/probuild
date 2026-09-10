import { prisma } from '@/lib/prisma';
import { hasCronSecret } from '@/lib/cron-auth';
import { createReceiptEvidenceDiagnosticHandler, loadReceiptEvidenceDiagnostic } from '@/lib/receipt-evidence-diagnostic';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Strict ops authentication in every environment; GET only, no QBO calls or writes.
export const GET = createReceiptEvidenceDiagnosticHandler({
    authorized: hasCronSecret,
    load: query => loadReceiptEvidenceDiagnostic(prisma, query),
});
