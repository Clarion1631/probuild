import type { PrismaClient } from '@prisma/client';
import { DIAGNOSTIC_ACCOUNT, parseReceiptEvidenceQuery } from './receipt-evidence-diagnostic-query';

export type DiagnosticDb = Pick<PrismaClient, 'bankLine' | 'bankLineObservation' | 'expense' | 'receiptMemoArtifact'>;
type Query = NonNullable<ReturnType<typeof parseReceiptEvidenceQuery>>;
const CHILD_LIMIT = 10;
const EVIDENCE_LIMIT = 30;
const statementSelect = {
    id: true, account: true, source: true, sourceDocumentId: true, sourceLineId: true,
    postedDate: true, amountCents: true, rawDescriptor: true, checkNumber: true,
    createdAt: true,
    statementImport: { select: {
        id: true, account: true, periodStart: true, periodEnd: true,
        openingCents: true, closingCents: true, contentHash: true, status: true,
    } },
} as const;

/** Explicit IDs only. Candidates are observations, not inferred bindings.
 * This diagnostic deliberately takes no locks and provides no transactional
 * certification: consumers must reread/version-fence before any later action.
 */
export async function loadReceiptEvidenceDiagnostic(db: DiagnosticDb, query: Query) {
    const rawLines = await db.bankLine.findMany({
        where: { id: { in: query.bankLineIds }, account: DIAGNOSTIC_ACCOUNT },
        orderBy: { id: 'asc' }, take: 11,
        select: {
            id: true, account: true, postedDate: true, amountCents: true, rawDescriptor: true,
            normalizedPayee: true, sourceOfRecord: true, qbTxnId: true, qbBankMatched: true,
            probuildExpenseId: true, state: true, updatedAt: true,
            observations: { where: { account: DIAGNOSTIC_ACCOUNT, source: 'STATEMENT' },
                orderBy: { id: 'asc' }, take: CHILD_LIMIT + 1, select: statementSelect },
        },
    });
    const inScope = rawLines.filter(line => line.account === DIAGNOSTIC_ACCOUNT && query.bankLineIds.includes(line.id));
    const rawQbo = query.qbTxnIds.length ? await db.bankLineObservation.findMany({
        where: { account: DIAGNOSTIC_ACCOUNT, source: 'QBO_REGISTER', sourceLineId: { in: query.qbTxnIds } },
        orderBy: { id: 'asc' }, take: EVIDENCE_LIMIT + 1,
        select: { id: true, account: true, source: true, sourceLineId: true, sourceDocumentId: true,
            bankLineId: true, postedDate: true, amountCents: true, rawDescriptor: true, createdAt: true },
    }) : [];
    const qboObservations = rawQbo.filter(row => row.account === DIAGNOSTIC_ACCOUNT && row.source === 'QBO_REGISTER' && query.qbTxnIds.includes(row.sourceLineId)).slice(0, EVIDENCE_LIMIT);
    // Never fetch an Expense merely because the caller named its QBO id: the
    // account-scoped observation is the required provenance for this read.
    const scopedQboIds = [...new Set(qboObservations.map(row => row.sourceLineId))];
    const linkedExpenseIds = inScope.flatMap(line => line.probuildExpenseId ? [line.probuildExpenseId] : []);
    const rawExpenses = scopedQboIds.length || linkedExpenseIds.length ? await db.expense.findMany({
        where: { OR: [{ qbPurchaseId: { in: scopedQboIds } }, { id: { in: linkedExpenseIds } }] },
        orderBy: { id: 'asc' }, take: EVIDENCE_LIMIT + 1,
        select: {
            id: true, qbPurchaseId: true, qbSyncToken: true, qbSyncedAt: true,
            amount: true, date: true, vendor: true, receiptUrl: true, status: true,
            description: true, projectId: true, estimateId: true, itemId: true,
            taxAmount: true, taxAtSource: true, installedAtCustomer: true,
            taxDeductibleBase: true, taxSource: true, taxDeductibleBaseSource: true, needsTaxReview: true,
            receiptIntake: { select: { id: true, expenseId: true, qbPurchaseId: true,
                state: true, stateReason: true, txnDate: true, vendor: true, totalCents: true } },
        },
    }) : [];
    const rawMemos = inScope.length ? await db.receiptMemoArtifact.findMany({
        where: { targetType: 'bank-line', targetKey: { in: inScope.map(line => line.id) } },
        orderBy: { id: 'asc' }, take: 11,
        select: { id: true, targetKey: true, pdfId: true, createdAt: true },
    }) : [];
    const lines = inScope.map(line => ({ ...line,
        observations: line.observations.filter(row => row.account === DIAGNOSTIC_ACCOUNT && row.source === 'STATEMENT' && (!row.statementImport || row.statementImport.account === DIAGNOSTIC_ACCOUNT)).slice(0, CHILD_LIMIT),
        observationsTruncated: line.observations.length > CHILD_LIMIT,
    }));
    return {
        lines,
        notFoundInAccount: query.bankLineIds.filter(id => !lines.some(line => line.id === id)),
        qboObservations,
        candidateExpenses: rawExpenses.filter(row => linkedExpenseIds.includes(row.id) || (row.qbPurchaseId !== null && scopedQboIds.includes(row.qbPurchaseId))).slice(0, EVIDENCE_LIMIT),
        memoBindings: rawMemos.filter(row => inScope.some(line => line.id === row.targetKey)).slice(0, 10),
        truncated: rawLines.length > 10 || inScope.some(line => line.observations.length > CHILD_LIMIT) || rawQbo.length > EVIDENCE_LIMIT || rawExpenses.length > EVIDENCE_LIMIT || rawMemos.length > 10,
    };
}

export function createReceiptEvidenceDiagnosticHandler(deps: {
    authorized(request: Request): boolean;
    load(query: Query): Promise<object>;
}) {
    const respond = (body: object, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
    return async (request: Request) => {
        if (!deps.authorized(request)) return respond({ error: 'Unauthorized' }, 401);
        const query = parseReceiptEvidenceQuery(new URL(request.url).searchParams);
        if (!query) return respond({ error: 'Provide 1–10 unique bankLineIds and optional 1–10 unique qbTxnIds; no other parameters.' }, 400);
        try {
            const evidence = await deps.load(query);
            return respond({ ok: true, account: DIAGNOSTIC_ACCOUNT, ...evidence,
                matchingVerdict: 'not-evaluated', businessActionsPerformed: false,
                limitations: ['Explicit-ID projection only; not a candidate census.', 'Read-only observations may change between reads; this is not an apply or binding certification.'] });
        } catch {
            return respond({ error: 'Receipt evidence diagnostic unavailable' }, 503);
        }
    };
}
