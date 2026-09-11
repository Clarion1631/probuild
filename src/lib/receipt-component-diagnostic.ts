import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { DEAD_INTAKE_STATES, loadComponentToClosure } from './receipt-requests';
import { loadRetiredReceiptLineage, lineagePurchaseIds, lineageExpenseIds, LineageQueryOverflowError } from './retired-receipt-lineage';
import { dayKeyInTimeZone, startOfDateInTimeZone } from './tz-date';

/**
 * Bounded, read-only diagnostic for ONE WTB-0723 statement debit and ONE
 * QuickBooks Purchase. It projects the same-cents closure component the
 * production chaser would consider, the evidence in that component's date
 * range, and every row anywhere that already claims the supplied identities.
 *
 * It never writes, never evaluates a match, never binds anything, and never
 * calls QBO or the network. `complete: true` means only that every bounded
 * projection finished under cap and the epochs did not move between the first
 * and last read. Serial reads are not a snapshot.
 */

export const TARGET_ACCOUNT = 'WTB-0723';
export const TARGET_SOURCE = 'STATEMENT';
export const DIAGNOSTIC_BUDGET_MS = 45_000;
export const COMPONENT_CAP = 200;
export const OBSERVATION_CAP = 200;
export const EVIDENCE_CAP = 500;
export const CLAIM_CAP = 500;
export const EPOCH_KEYS = ['bankLedgerEpoch', 'receiptEvidenceEpoch', 'bankRegisterPullLastSuccess'] as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CUID_RE = /^c[0-9a-z]{24}$/;
const QB_TXN_RE = /^\d{1,20}$/;
const DEAD_STATES = [...DEAD_INTAKE_STATES];

export interface ReceiptComponentDiagnosticQuery { bankLineId: string; qbTxnId: string }

/** Exactly one `bankLineId` (UUID, or Prisma CUIDv1: lower-case `c` + 24 lower-case ASCII alphanumerics) and exactly one `qbTxnId` (1..20 digits). Nothing else, nothing repeated. */
export function parseReceiptComponentDiagnosticQuery(params: URLSearchParams): ReceiptComponentDiagnosticQuery | null {
    const keys = [...params.keys()];
    if (keys.length !== 2 || !keys.includes('bankLineId') || !keys.includes('qbTxnId')) return null;
    const bank = params.getAll('bankLineId');
    const qb = params.getAll('qbTxnId');
    if (bank.length !== 1 || qb.length !== 1) return null;
    if (!QB_TXN_RE.test(qb[0])) return null;
    if (UUID_RE.test(bank[0])) return { bankLineId: bank[0].toLowerCase(), qbTxnId: qb[0] };
    if (CUID_RE.test(bank[0])) return { bankLineId: bank[0], qbTxnId: qb[0] };
    return null;
}

type FindManyOnly<M extends { findMany: unknown }> = Pick<M, 'findMany'>;
/** Read-only surface: `findMany` only. A write method does not type-check. */
export interface DiagnosticDb {
    bankLine: FindManyOnly<PrismaClient['bankLine']>;
    bankLineObservation: FindManyOnly<PrismaClient['bankLineObservation']>;
    expense: FindManyOnly<PrismaClient['expense']>;
    receiptIntake: FindManyOnly<PrismaClient['receiptIntake']>;
    reviewIssue: FindManyOnly<PrismaClient['reviewIssue']>;
    receiptMemoArtifact: FindManyOnly<PrismaClient['receiptMemoArtifact']>;
    automationSetting: FindManyOnly<PrismaClient['automationSetting']>;
}

export interface DiagnosticDeps {
    now(): Date;
    /** Company IANA zone, resolved by the route. */
    zone: string;
    recognitionEnabled: boolean;
    /** receiptRecognitionPolicy(...) string, resolved by the route. */
    policy: string;
    decimalStringToCents(value: string): number | null;
    startedAt?: Date;
    /** BANK_PULL_CHASER_WINDOW_HOURS, passed through by the route. */
    bankPullWindowHours: number;
    budgetMs?: number;
}

export type DiagnosticStatus =
    | 'complete' | 'stale' | 'unstable' | 'overflow' | 'deadline' | 'target-not-found' | 'target-not-canonical'
    | 'qbo-observation-missing' | 'candidate-missing' | 'candidate-ambiguous' | 'candidate-amount-mismatch';

export const DIAGNOSTIC_LIMITATIONS = [
    'Serial bounded reads: rows can move between reads; this is not an atomic snapshot.',
    'Presence of every unknown or unindexed identity is not certified; only the listed exact keys were queried.',
    'No runtime verification of the source PDF or receipt bytes was performed.',
    'No unindexed PayPal or free-text reference search was performed; receiptUrl/sourceFileId were matched exactly, never by substring.',
    'No matching verdict, binding, or business action: this is an observation projection only.',
];

class DiagnosticDeadlineError extends Error { name = 'DiagnosticDeadlineError'; }
class DiagnosticOverflowError extends Error {
    name = 'DiagnosticOverflowError';
    constructor(public readonly projection: string, public readonly cap: number) { super(`${projection} exceeded ${cap}`); }
}

function capped<T>(rows: T[], cap: number, projection: string): T[] {
    if (rows.length > cap) throw new DiagnosticOverflowError(projection, cap);
    return rows;
}

function shiftYmd(ymd: string, days: number): string {
    const [y, m, d] = ymd.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function sortById<T extends { id: string }>(rows: readonly T[]): T[] {
    return [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === 'object' && !(value instanceof Date) && typeof (value as { toJSON?: unknown }).toJSON !== 'function') {
        const source = value as Record<string, unknown>;
        return Object.fromEntries(Object.keys(source).sort().map(key => [key, canonicalize(source[key])]));
    }
    return value;
}

/** SHA-256 of key-sorted JSON; arrays are expected pre-sorted by id. */
export function evidenceFingerprint(evidence: unknown): string {
    return createHash('sha256').update(JSON.stringify(canonicalize(evidence))).digest('hex');
}

interface EpochRead { rows: { key: string; value: string | null }[]; stable: boolean; reason: string | null }

function classifyEpochs(rows: { key: string; value: string | null }[]): { stable: boolean; reason: string | null } {
    for (const key of ['bankLedgerEpoch', 'receiptEvidenceEpoch']) {
        const hits = rows.filter(row => row.key === key);
        if (hits.length !== 1) return { stable: false, reason: `${key} absent or duplicated` };
        if (typeof hits[0].value !== 'string' || !/^(0|[1-9]\d*)$/.test(hits[0].value)) return { stable: false, reason: `${key} malformed` };
    }
    return { stable: true, reason: null };
}

function bankFreshness(rows: { key: string; value: string | null }[], now: Date, windowHours: number) {
    const row = rows.find(r => r.key === 'bankRegisterPullLastSuccess');
    if (!row || typeof row.value !== 'string') return { valid: false, lastSuccess: null, reason: 'bankRegisterPullLastSuccess absent' };
    const at = new Date(row.value);
    if (Number.isNaN(at.getTime())) return { valid: false, lastSuccess: null, reason: 'bankRegisterPullLastSuccess malformed' };
    if (at.getTime() > now.getTime()) return { valid: false, lastSuccess: at, reason: 'bankRegisterPullLastSuccess in the future' };
    if (now.getTime() - at.getTime() > windowHours * 3_600_000) return { valid: false, lastSuccess: at, reason: `bankRegisterPullLastSuccess older than ${windowHours}h` };
    return { valid: true, lastSuccess: at, reason: null };
}

const lineSelect = {
    id: true, account: true, sourceOfRecord: true, state: true, postedDate: true, amountCents: true,
    rawDescriptor: true, checkNumber: true, qbTxnId: true, probuildExpenseId: true, updatedAt: true,
} as const;
const observationSelect = {
    id: true, account: true, source: true, sourceLineId: true, bankLineId: true, postedDate: true, amountCents: true, createdAt: true,
} as const;
const expenseSelect = {
    id: true, date: true, amount: true, vendor: true, receiptUrl: true, sourceFileId: true, sourceGroupIndex: true,
    qbPurchaseId: true, qbSyncToken: true, status: true, description: true, updatedAt: true,
    receiptIntake: { select: { id: true, expenseId: true, qbPurchaseId: true, state: true } },
} as const;
const intakeSelect = {
    id: true, state: true, stateReason: true, txnDate: true, vendor: true, totalCents: true,
    expenseId: true, qbPurchaseId: true, postVoidQbPurchaseId: true, sourceRef: true,
} as const;
const settingSelect = { key: true, value: true } as const;

export async function loadReceiptComponentDiagnostic(db: DiagnosticDb, query: ReceiptComponentDiagnosticQuery, deps: DiagnosticDeps) {
    const startedAt = deps.startedAt ?? deps.now();
    const budgetMs = deps.budgetMs ?? DIAGNOSTIC_BUDGET_MS;
    const deadlineExceeded = () => deps.now().getTime() - startedAt.getTime() >= budgetMs;
    const guard = () => { if (deadlineExceeded()) throw new DiagnosticDeadlineError('diagnostic budget exceeded'); };
    /** Deadline checked before AND after every awaited read. */
    const read = async <T>(run: () => Promise<T>): Promise<T> => { guard(); const rows = await run(); guard(); return rows; };
    const linkDays = deps.recognitionEnabled ? 9 : 4;
    const rangeBefore = deps.recognitionEnabled ? 7 : 2;
    const rangeAfter = 2;
    const counts: Record<string, number> = {};
    const limitations = [...DIAGNOSTIC_LIMITATIONS];
    const base = {
        account: TARGET_ACCOUNT, query, startedAt, policy: deps.policy, recognitionEnabled: deps.recognitionEnabled,
        zone: deps.zone, linkDays, evidenceRangeDays: { before: rangeBefore, after: rangeAfter },
        matchingVerdict: 'not-evaluated' as const, bindingCertified: false as const, businessActionsPerformed: false as const,
    };
    const stop = (status: Exclude<DiagnosticStatus, 'complete'>, reason: string, extra: Record<string, unknown> = {}) => ({
        ...base, ...extra, complete: false as const, status, reason, counts, limitations, finishedAt: deps.now(),
    });

    const readEpochs = async (): Promise<EpochRead> => {
        const rows = await read(() => db.automationSetting.findMany({
            where: { key: { in: [...EPOCH_KEYS] } }, orderBy: { key: 'asc' }, take: 4, select: settingSelect,
        }));
        return { rows: rows.filter(row => (EPOCH_KEYS as readonly string[]).includes(row.key)), ...classifyEpochs(rows) };
    };

    try {
        const epochsBefore = await readEpochs();
        if (!epochsBefore.stable) return stop('unstable', epochsBefore.reason ?? 'epochs unstable', { epochsBefore: epochsBefore.rows });
        const freshness = bankFreshness(epochsBefore.rows, startedAt, deps.bankPullWindowHours);

        // 1. Fixed target: must be the canonical WTB-0723 negative STATEMENT line.
        const targetRows = await read(() => db.bankLine.findMany({ where: { id: query.bankLineId, account: TARGET_ACCOUNT }, take: 2, select: lineSelect }));
        const targetRaw = targetRows.find(row => row.id === query.bankLineId);
        const target = targetRaw ? { ...targetRaw, postedDate: targetRaw.postedDate.toISOString().slice(0, 10) } : null;
        if (!target) return stop('target-not-found', 'bankLineId not found', { epochsBefore: epochsBefore.rows, bankFreshness: freshness });
        const canonical = target.account === TARGET_ACCOUNT && target.sourceOfRecord === TARGET_SOURCE
            && Number.isSafeInteger(target.amountCents) && target.amountCents < 0;
        if (!canonical) return stop('target-not-canonical', 'target is not a WTB-0723 negative STATEMENT line', { target, epochsBefore: epochsBefore.rows, bankFreshness: freshness });

        // 2. Account-scoped QBO_REGISTER observation for the supplied qbTxnId is required provenance.
        const qboRaw = await read(() => db.bankLineObservation.findMany({
            where: { account: TARGET_ACCOUNT, source: 'QBO_REGISTER', sourceLineId: query.qbTxnId },
            orderBy: { id: 'asc' }, take: OBSERVATION_CAP + 1, select: observationSelect,
        }));
        const qboObservations = capped(qboRaw, OBSERVATION_CAP, 'qboObservations')
            .filter(row => row.account === TARGET_ACCOUNT && row.source === 'QBO_REGISTER' && row.sourceLineId === query.qbTxnId);
        counts.qboObservations = qboObservations.length;
        if (qboObservations.length === 0) return stop('qbo-observation-missing', 'no WTB-0723 QBO_REGISTER observation for qbTxnId', { target, epochsBefore: epochsBefore.rows, bankFreshness: freshness });

        // 3. Exactly one candidate Expense for this Purchase, exact positive target cents. Date is NOT forced.
        const candidates = await read(() => db.expense.findMany({ where: { qbPurchaseId: query.qbTxnId }, orderBy: { id: 'asc' }, take: 2, select: expenseSelect }));
        counts.candidateExpenses = candidates.length;
        const partial = { target, qboObservations, epochsBefore: epochsBefore.rows, bankFreshness: freshness };
        if (candidates.length === 0) return stop('candidate-missing', 'no Expense with this qbPurchaseId', partial);
        if (candidates.length > 1) return stop('candidate-ambiguous', 'more than one Expense with this qbPurchaseId', partial);
        const candidate = candidates[0];
        const candidateCents = deps.decimalStringToCents(String(candidate.amount));
        const targetPositiveCents = -target.amountCents;
        if (candidateCents === null || !Number.isSafeInteger(candidateCents) || candidateCents <= 0 || candidateCents !== targetPositiveCents) {
            return stop('candidate-amount-mismatch', 'candidate Expense cents do not equal positive target cents', { ...partial, candidateExpense: candidate, candidateCents, targetPositiveCents });
        }
        const candidateIntakeDead = candidate.receiptIntake ? DEAD_STATES.includes(candidate.receiptIntake.state) : false;
        const candidateDateMismatch = candidate.date instanceof Date
            ? dayKeyInTimeZone(candidate.date, deps.zone) !== target.postedDate : true;

        // 4. Same-cents closure component across ALL accounts and states (production's conservative closure).
        const component = await loadComponentToClosure(
            target.postedDate,
            (fromYmd, toYmd) => read(() => db.bankLine.findMany({
                where: { amountCents: target.amountCents, postedDate: { gte: new Date(`${fromYmd}T00:00:00Z`), lte: new Date(`${toYmd}T00:00:00Z`) } },
                orderBy: { id: 'asc' }, take: COMPONENT_CAP + 1, select: lineSelect,
            })).then(rows => rows.map(row => ({ ...row, postedDate: row.postedDate.toISOString().slice(0, 10) }))),
            { maxNodes: COMPONENT_CAP, linkDays, deadlineExceeded },
        );
        counts.componentLines = component.length;
        guard();
        if (!component.some(row => row.id === target.id)) return stop('unstable', 'target disappeared from closure');
        const dates = component.map(row => row.postedDate).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d));
        const minYmd = shiftYmd(dates.reduce((a, b) => (a < b ? a : b), target.postedDate), -rangeBefore);
        const maxYmd = shiftYmd(dates.reduce((a, b) => (a > b ? a : b), target.postedDate), rangeAfter);
        const componentIds = component.map(row => row.id);

        // 5. Full evidence range: all Expenses dated in range, all non-dead intakes with txnDate in range.
        const rangeStart = startOfDateInTimeZone(minYmd, deps.zone);
        const rangeEnd = startOfDateInTimeZone(shiftYmd(maxYmd, 1), deps.zone);
        const rangeExpenses = capped(await read(() => db.expense.findMany({
            where: { date: { gte: rangeStart, lt: rangeEnd } }, orderBy: { id: 'asc' }, take: EVIDENCE_CAP + 1, select: expenseSelect,
        })), EVIDENCE_CAP, 'rangeExpenses');
        const rangeIntakes = capped(await read(() => db.receiptIntake.findMany({
            where: { state: { notIn: DEAD_STATES }, txnDate: { gte: new Date(`${minYmd}T00:00:00.000Z`), lte: new Date(`${maxYmd}T00:00:00.000Z`) } },
            orderBy: { id: 'asc' }, take: EVIDENCE_CAP + 1, select: intakeSelect,
        })), EVIDENCE_CAP, 'rangeIntakes');
        const siblingIssues = capped(await read(() => db.reviewIssue.findMany({
            where: { targetType: 'bank-line', targetKey: { in: componentIds } }, orderBy: { id: 'asc' }, take: CLAIM_CAP + 1,
            select: { id: true, targetKey: true, version: true, reasonCodes: true, reasonHash: true, displayDetails: true, clearedAt: true, updatedAt: true },
        })), CLAIM_CAP, 'siblingIssues');
        const memoArtifacts = capped(await read(() => db.receiptMemoArtifact.findMany({
            where: { targetType: 'bank-line', targetKey: { in: componentIds } }, orderBy: { id: 'asc' }, take: CLAIM_CAP + 1,
            select: { id: true, targetKey: true, pdfId: true, createdAt: true },
        })), CLAIM_CAP, 'memoArtifacts');

        // 6. Global claims on the supplied identities: no date, state, or account filter.
        const claimLines = capped(await read(() => db.bankLine.findMany({
            where: { OR: [{ qbTxnId: query.qbTxnId }, { probuildExpenseId: candidate.id }] }, orderBy: { id: 'asc' }, take: CLAIM_CAP + 1, select: lineSelect,
        })), CLAIM_CAP, 'claimLines');
        const claimObservations = capped(await read(() => db.bankLineObservation.findMany({
            where: { source: 'QBO_REGISTER', sourceLineId: query.qbTxnId }, orderBy: { id: 'asc' }, take: CLAIM_CAP + 1, select: observationSelect,
        })), CLAIM_CAP, 'claimObservations');
        const claimIntakes = capped(await read(() => db.receiptIntake.findMany({
            where: { OR: [{ qbPurchaseId: query.qbTxnId }, { postVoidQbPurchaseId: query.qbTxnId }, { expenseId: candidate.id }] },
            orderBy: { id: 'asc' }, take: CLAIM_CAP + 1, select: intakeSelect,
        })), CLAIM_CAP, 'claimIntakes');
        const sourceOr: Array<{ receiptUrl: string } | { sourceFileId: string }> = [];
        if (typeof candidate.receiptUrl === 'string' && candidate.receiptUrl !== '') sourceOr.push({ receiptUrl: candidate.receiptUrl });
        if (typeof candidate.sourceFileId === 'string' && candidate.sourceFileId !== '') sourceOr.push({ sourceFileId: candidate.sourceFileId });
        else limitations.push('Candidate Expense has no sourceFileId; source-group siblings were not enumerated by file id.');
        const claimExpenses = sourceOr.length ? capped(await read(() => db.expense.findMany({
            where: { OR: sourceOr }, orderBy: { id: 'asc' }, take: CLAIM_CAP + 1, select: expenseSelect,
        })), CLAIM_CAP, 'claimExpenses') : [];
        if (!sourceOr.length) limitations.push('Candidate Expense has neither receiptUrl nor sourceFileId; no exact-source claim query was possible.');
        const sourceGroups = [...new Set(claimExpenses.map(row => `${row.sourceFileId ?? '∅'}#${row.sourceGroupIndex ?? '∅'}`))].sort();
        Object.assign(counts, {
            rangeExpenses: rangeExpenses.length, rangeIntakes: rangeIntakes.length, siblingIssues: siblingIssues.length,
            memoArtifacts: memoArtifacts.length, claimLines: claimLines.length, claimObservations: claimObservations.length,
            claimIntakes: claimIntakes.length, claimExpenses: claimExpenses.length,
        });

        // Reuse the production global lineage/reservation census for every loaded evidence unit,
        // not just the nominated Purchase. This remains a projection, never a retired-match shortcut.
        const lineage = await read(() => loadRetiredReceiptLineage(db, componentIds, {
            cap: CLAIM_CAP, checkBudget: guard,
            candidatePurchaseIds: lineagePurchaseIds(rangeExpenses, rangeIntakes, [candidate]),
            candidateExpenseIds: lineageExpenseIds(rangeIntakes),
        }));
        counts.lineageClaims = new Set([...lineage.snapshot.lines.flatMap(row => row.claims), ...(lineage.snapshot.units ?? []).flatMap(row => row.claims)].map(row => row.id)).size;

        // 7. Epochs again: any movement means the serial reads cannot be treated as one projection.
        const epochsAfter = await readEpochs();
        const evidence = {
            policy: deps.policy, query, target, lineage: lineage.snapshot, qboObservations: sortById(qboObservations), candidateExpense: candidate,
            component: sortById(component), rangeExpenses: sortById(rangeExpenses), rangeIntakes: sortById(rangeIntakes),
            siblingIssues: sortById(siblingIssues), memoArtifacts: sortById(memoArtifacts), claimLines: sortById(claimLines),
            claimObservations: sortById(claimObservations), claimIntakes: sortById(claimIntakes), claimExpenses: sortById(claimExpenses),
            epochsBefore: epochsBefore.rows, epochsAfter: epochsAfter.rows,
        };
        const finalFreshness = bankFreshness(epochsAfter.rows, deps.now(), deps.bankPullWindowHours);
        const moved = !epochsAfter.stable || JSON.stringify(epochsBefore.rows) !== JSON.stringify(epochsAfter.rows);
        if (moved) return stop('unstable', epochsAfter.reason ?? 'epochs changed during read', { ...evidence, bankFreshness: freshness, evidenceRange: { minYmd, maxYmd } });
        if (!finalFreshness.valid) return stop('stale', finalFreshness.reason ?? 'bank pull stale', { ...evidence, bankFreshness: finalFreshness });
        guard();
        return {
            ...base, ...evidence, complete: true as const, status: 'complete' as const, reason: null,
            evidenceRange: { minYmd, maxYmd }, bankFreshness: finalFreshness,
            candidateCents, targetPositiveCents, candidateDateMismatch, candidateIntakeDead, sourceGroups,
            counts, fingerprint: evidenceFingerprint(evidence), limitations, finishedAt: deps.now(),
        };
    } catch (error) {
        if (error instanceof LineageQueryOverflowError) return stop('overflow', 'lineage census exceeded cap', { overflow: { projection: 'lineage', cap: CLAIM_CAP } });
        if (error instanceof DiagnosticDeadlineError) return stop('deadline', error.message);
        if (error instanceof DiagnosticOverflowError) return stop('overflow', error.message, { overflow: { projection: error.projection, cap: error.cap } });
        const name = error instanceof Error ? error.name : '';
        if (name === 'ComponentDeadlineExceededError') return stop('deadline', 'closure walk exceeded budget');
        if (name === 'ComponentTooLargeError') return stop('overflow', 'closure component exceeded cap', { overflow: { projection: 'component', cap: COMPONENT_CAP } });
        throw error;
    }
}

export type ReceiptComponentDiagnostic = Awaited<ReturnType<typeof loadReceiptComponentDiagnostic>>;

export function createReceiptComponentDiagnosticHandler(deps: {
    authorized(request: Request): boolean;
    load(query: ReceiptComponentDiagnosticQuery, startedAt: Date): Promise<object>;
    now?: () => Date;
}) {
    const respond = (body: object, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
    return async (request: Request): Promise<Response> => {
        const startedAt = deps.now?.() ?? new Date();
        if (!deps.authorized(request)) return respond({ error: 'Unauthorized' }, 401);
        const query = parseReceiptComponentDiagnosticQuery(new URL(request.url).searchParams);
        if (!query) return respond({ error: 'Provide exactly one bankLineId (UUID or CUID) and exactly one qbTxnId (1-20 digits); no other parameters.' }, 400);
        try {
            return respond({ ok: true, ...(await deps.load(query, startedAt)) });
        } catch {
            return respond({ error: 'Receipt component diagnostic unavailable' }, 503);
        }
    };
}
