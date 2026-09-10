import { prisma } from '@/lib/prisma';
import {
  createApplyContext, parseRefreshBody, readBoundedBody, readRefreshEvidence,
} from '@/lib/bank-source-refresh';
import { fetchBankRegister } from '@/lib/qbo-bank-register';
import { registerRowToIngestLine } from '@/lib/bank-register-pull';
import { createRouteDeadline, qbFetch } from '@/lib/quickbooks';
import { getFreshQBTokens } from '@/lib/quickbooks-payments';
import { hasCronSecret } from '@/lib/cron-auth';
import { lockReceiptEvidence } from '@/lib/receipt-evidence-lock';
import { lockQboExpense } from '@/lib/qbo-expense-sync';
import { lockBankLineIdentity } from '@/lib/bank-reconcile-guard';
import { rollingWindow } from '@/app/api/integrations/bank-ledger/conflict-diagnostic/route';
import { createDepositSourceRefreshHandler, createQboSourceReaders } from '@/lib/bank-deposit-source-refresh';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const readers = createQboSourceReaders({ qbFetch, getTokens: getFreshQBTokens, createDeadline: createRouteDeadline });

const handler = createDepositSourceRefreshHandler({
  authorize: hasCronSecret,
  readBody: (req) => readBoundedBody(req, 8192),
  parseBody: parseRefreshBody,
  toIngestLine: registerRowToIngestLine,
  readRegister: async () => {
    const window = rollingWindow();
    return fetchBankRegister(getFreshQBTokens, window.startDate, window.endDate, { fresh: true });
  },
  fetchDeposit: readers.fetchDeposit,
  fetchPayment: readers.fetchPayment,
  readEvidence: (id) => readRefreshEvidence(prisma, id),
  // Same fence order as the Purchase refresh; the descriptor CAS + epoch bump + audit happen inside the ctx.
  apply: (id, body, remainingMs) => prisma.$transaction(async (tx) => {
    await lockReceiptEvidence(tx);
    await lockQboExpense(tx, id);
    await lockBankLineIdentity(tx);
    return body(createApplyContext(tx, id));
  }, { timeout: Math.min(15_000, remainingMs), maxWait: Math.min(2_000, remainingMs) }),
});

export async function POST(req: Request): Promise<Response> {
  return handler(req);
}
