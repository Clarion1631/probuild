import type { Prisma } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { prisma } from './prisma';
import { lockReceiptEvidence, readReceiptEvidenceEpoch } from './receipt-evidence-lock';
import { lockBankLedgerEpoch } from './bank-ledger-epoch';
import { CYCLE_KEY, SWEEP_MARKER_KEY, parseSweepCycle, parseSweepMarker, chaserCompletedFor, cycleStillValid } from './receipt-sweep-marker';
import { receiptRecognitionPolicy } from './receipt-source-recognition';
import { reviewedReceiptFactsFingerprint } from '@/server/receipt-reviewed-source-facts';
import { reviewedReceiptPairsFingerprint } from '@/server/receipt-reviewed-pair-facts';
import { effectiveOwner, RECEIPT_REQUEST_TARGET_TYPE } from './receipt-requests';
import { decodeReasonCodes } from './review-alert-reasons';
import { parseMissingReceiptDetails } from '@/app/automation/receipts-data';
import { buildCardFromItems, parseOwnerChatUsers, postOwnerCard, pacificDate, isValidChatWebhookUrl, type CardItem } from './receipt-request-cards';
import { cardRecordsOf, recordCardOnIssues } from './receipt-card-history';
import { loadCardItemTruth } from '@/app/api/cron/receipt-request-cards/route';
import { recomputeCodesFor } from '@/app/api/cron/receipt-requests/route';
import { computeOnDemandDigest, validateSnapshot, parseAllowedTargets, toOwnerCard, validDeliveryIdentity, type PreparedSnapshot, type OnDemandDeps, type ClaimResult, type FinishResult } from './receipt-on-demand';

type Db = Prisma.TransactionClient;
const SETTING_KEYS = ['bankLedgerEpoch', 'receiptEvidenceEpoch', CYCLE_KEY, SWEEP_MARKER_KEY, 'bankRegisterPullLastSuccess'];
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export interface OnDemandStoreInstall {
    db?: typeof prisma;
    clock?: () => Date;
    config?: { allowedTargets?: unknown; ownerChatUsers?: string; webhookUrl?: string; env?: NodeJS.ProcessEnv };
    loadTruth?: typeof loadCardItemTruth;
}

/** Off-lock receipt recomputation is fenced by both source epochs before any outbox reservation. */
export function createOnDemandDeps(install: OnDemandStoreInstall = {}): OnDemandDeps {
    const db = install.db ?? prisma;
    const now = install.clock ?? (() => new Date());
    const env = install.config?.env ?? process.env;
    const targets = () => {
        if (install.config?.allowedTargets !== undefined) return parseAllowedTargets(install.config.allowedTargets);
        try { return parseAllowedTargets(JSON.parse(env.RECEIPT_ON_DEMAND_TARGETS ?? 'null')); } catch { return []; }
    };
    const ownerUser = () => parseOwnerChatUsers(install.config?.ownerChatUsers ?? env.RECEIPT_OWNER_CHAT_USERS).Justin ?? '';
    const webhook = install.config?.webhookUrl ?? env.RECEIPTS_CHAT_WEBHOOK ?? '';
    const deliveryInConfiguredSpace = (thread: unknown, message: unknown) => {
        if (!validDeliveryIdentity(thread, message) || !isValidChatWebhookUrl(webhook)) return false;
        const space = /^\/v1\/(spaces\/[A-Za-z0-9_-]+)\/messages$/.exec(new URL(webhook).pathname)?.[1];
        return !!space && (thread as string).startsWith(space + '/threads/') && (message as string).startsWith(space + '/messages/');
    };
    const truth = install.loadTruth ?? ((ids, options) => loadCardItemTruth(ids, {
        ...options, recompute: (id, cache, expired) => recomputeCodesFor(id, cache, expired, true),
    }));
    const startedAt = now().getTime();
    const deadline = () => now().getTime() - startedAt >= 20_000;

    async function settings(client: Db) {
        const rows = await client.automationSetting.findMany({ where: { key: { in: SETTING_KEYS } }, select: { key: true, value: true } });
        const values = Object.fromEntries(SETTING_KEYS.map(key => [key, rows.find(r => r.key === key)?.value ?? null]));
        const policy = receiptRecognitionPolicy(env.RECEIPT_SOURCE_RECOGNITION_ENABLED === 'true', reviewedReceiptFactsFingerprint, reviewedReceiptPairsFingerprint);
        return { values, policy, ledger: values.bankLedgerEpoch ?? '0', evidence: values.receiptEvidenceEpoch ?? '0' };
    }

    async function base(client: Db, id: string): Promise<PreparedSnapshot> {
        if (!targets().includes(id)) throw Error('target-not-allowed');
        const line = await client.bankLine.findUnique({ where: { id }, select: {
            id: true, account: true, sourceOfRecord: true, state: true, amountCents: true, postedDate: true,
            rawDescriptor: true, checkNumber: true, updatedAt: true, qbTxnId: true, probuildExpenseId: true,
            observations: { where: { source: 'STATEMENT' }, take: 11, orderBy: { id: 'asc' }, select: {
                id: true, account: true, bankLineId: true, sourceDocumentId: true, sourceLineId: true,
                postedDate: true, amountCents: true, rawDescriptor: true, checkNumber: true,
                statementImport: { select: { id: true, account: true, status: true, contentHash: true } },
            } },
        } });
        if (!line || line.account !== 'WTB-0723' || line.sourceOfRecord !== 'STATEMENT' || line.state !== 'POSTED'
            || !Number.isSafeInteger(line.amountCents) || line.amountCents >= 0 || line.qbTxnId || line.probuildExpenseId)
            throw Error('canonical-ineligible');
        if (line.observations.length !== 1) throw Error('statement-proof-incomplete');
        const observation = line.observations[0];
        const postedDate = line.postedDate.toISOString().slice(0, 10);
        if (observation.account !== line.account || observation.bankLineId !== id || observation.amountCents !== line.amountCents
            || observation.postedDate.toISOString().slice(0, 10) !== postedDate || observation.rawDescriptor !== line.rawDescriptor
            || observation.checkNumber !== line.checkNumber || observation.statementImport?.status !== 'FINALIZED'
            || observation.statementImport.account !== line.account || observation.sourceDocumentId !== observation.statementImport.id
            || !/^[a-f0-9]{64}$/i.test(observation.statementImport.contentHash)) throw Error('statement-proof-conflict');
        const issue = await client.reviewIssue.findUnique({ where: { targetType_targetKey: { targetType: RECEIPT_REQUEST_TARGET_TYPE, targetKey: id } }, select: {
            id: true, version: true, displayDetails: true, reasonCodes: true, acknowledgedCodes: true, clearedAt: true,
        } });
        if (!issue) throw Error('issue-missing');
        const details = parseMissingReceiptDetails(issue.displayDetails);
        if (details.postedDate !== postedDate || details.amountCents !== line.amountCents || details.fingerprint !== `pb-${id}`
            || typeof details.payee !== 'string' || !details.payee.trim()) throw Error('issue-source-conflict');
        const codes = decodeReasonCodes(issue.reasonCodes);
        const artifact = await client.receiptMemoArtifact.findFirst({ where: { targetType: RECEIPT_REQUEST_TARGET_TYPE, targetKey: id }, select: { pdfId: true } });
        const state = await settings(client);
        const cycle = parseSweepCycle(state.values[CYCLE_KEY]);
        const marker = parseSweepMarker(state.values[SWEEP_MARKER_KEY]);
        const current = now();
        const lastBank = Date.parse(state.values.bankRegisterPullLastSuccess ?? '');
        const cents = Math.abs(line.amountCents);
        return {
            bankLineId: id, account: line.account, sourceOfRecord: line.sourceOfRecord, debitCents: cents,
            postedDate, rawDescriptor: line.rawDescriptor, updatedAt: line.updatedAt.toISOString(),
            sourceRevision: hash({ line, issue, artifact, state, ownerUser: ownerUser() }),
            owner: effectiveOwner(details), ownerUser: ownerUser(), issueVersion: issue.version,
            epochs: { ledger: state.ledger, evidence: state.evidence }, policy: state.policy,
            item: { issueId: issue.id, targetKey: id, fingerprint: `pb-${id}`, date: postedDate, vendor: details.payee,
                cents, amount: (cents / 100).toFixed(2), cardTail: typeof details.cardTail === 'string' ? details.cardTail : null },
            sweep: { certified: chaserCompletedFor(marker, pacificDate(current), 'America/Los_Angeles', cycle?.id ?? null)
                && cycleStillValid(cycle, state.ledger, state.evidence, state.policy),
                fresh: Number.isFinite(lastBank) && lastBank <= current.getTime() && current.getTime() - lastBank <= 86_400_000,
                evidenceEligible: codes.length === 1 && codes[0] === 'MISSING_RECEIPT' },
            flags: { acknowledged: decodeReasonCodes(issue.acknowledgedCodes).length > 0, resolved: issue.clearedAt !== null || !!artifact, sourceFound: false },
        };
    }

    async function readSnapshot(id: string) {
        const before = await settings(db);
        const snapshot = await base(db, id);
        if (validateSnapshot(snapshot, id, targets(), now()).length) return snapshot;
        const result = (await truth([snapshot.item.issueId], { deadlineExceeded: deadline })).get(snapshot.item.issueId);
        if (!result || result.revalidationSkipped || deadline()) throw Error('evidence-incomplete');
        if (hash(before) !== hash(await settings(db))) throw Error('source-moved');
        snapshot.flags.sourceFound = result.evidenceSatisfied;
        snapshot.flags.acknowledged ||= result.acknowledged;
        snapshot.flags.resolved ||= result.resolved || result.clearedAt !== null;
        if (result.owner !== snapshot.owner) throw Error('owner-moved');
        return snapshot;
    }

    async function priorAttempt(client: Db, id: string) {
        // No date cutoff: an unknown send remains unknown after midnight.
        const rows = await client.receiptRequestCard.findMany({ where: { owner: 'Justin' }, orderBy: { createdAt: 'desc' }, take: 51 });
        if (rows.length > 50) throw Error('prior-request-inventory-incomplete');
        const matches = rows.filter(row => {
            const items: unknown = JSON.parse(row.itemsJson);
            if (!Array.isArray(items)) throw Error('prior-request-malformed');
            return items.some(item => item && (item.targetKey === id || item.fingerprint === `pb-${id}`));
        });
        if (matches.length > 1) throw Error('multiple-prior-requests');
        return matches[0] ?? null;
    }

    async function lookupPosted(id: string): Promise<Extract<ClaimResult, { kind: 'already-posted' }> | null> {
        if (!targets().includes(id) || !/^users\/[A-Za-z0-9_-]+$/.test(ownerUser())) throw Error('not-configured');
        const issue = await db.reviewIssue.findUnique({ where: { targetType_targetKey: { targetType: RECEIPT_REQUEST_TARGET_TYPE, targetKey: id } }, select: { id: true, displayDetails: true } });
        if (!issue) return null;
        const details = parseMissingReceiptDetails(issue.displayDetails);
        if (effectiveOwner(details) !== 'Justin' || details.fingerprint !== `pb-${id}`) throw Error('owner-source-mismatch');
        const history = cardRecordsOf(details);
        const prior = await priorAttempt(db, id);
        if (!history.length && !prior) return null;
        if (!history.length || (prior && prior.status !== 'POSTED')) throw Error('prior-request-unverified');
        if (history.length > 20) throw Error('history-incomplete');
        const latest = [...history].sort((a, b) => b.date.localeCompare(a.date))[0];
        const row = await db.receiptRequestCard.findUnique({ where: { owner_pacificDate: { owner: 'Justin', pacificDate: latest.date } } });
        if (!row || row.status !== 'POSTED' || !row.postedAt || !deliveryInConfiguredSpace(row.threadName, row.messageName)) throw Error('existing-request-unverified');
        const items = JSON.parse(row.itemsJson) as CardItem[];
        if (items.length !== 1 || items[0].n !== 1 || items[0].targetKey !== id || items[0].issueId !== issue.id || items[0].fingerprint !== `pb-${id}`
            || latest.threadName !== row.threadName || latest.messageName !== row.messageName || latest.n !== 1
            || latest.requestId !== `receipt-req-Justin-${row.pacificDate}`) throw Error('existing-request-conflict');
        return { kind: 'already-posted', threadName: row.threadName!, messageName: row.messageName! };
    }

    async function claim(snapshot: PreparedSnapshot, digest: string): Promise<ClaimResult> {
        if (deadline() || !isValidChatWebhookUrl(webhook)) return { kind: 'blocked', reason: 'delivery-unavailable' };
        const claimInstant = now();
        try {
            return await db.$transaction(async tx => {
                // Global order: evidence advisory -> evidence epoch -> bank epoch -> canonical row -> issue row.
                await lockReceiptEvidence(tx);
                const evidence = await readReceiptEvidenceEpoch(tx);
                const ledger = await lockBankLedgerEpoch(tx);
                await tx.$queryRaw`SELECT "id" FROM "BankLine" WHERE "id" = ${snapshot.bankLineId} FOR UPDATE`;
                await tx.$queryRaw`SELECT "id" FROM "ReviewIssue" WHERE "id" = ${snapshot.item.issueId} FOR UPDATE`;
                if (evidence !== snapshot.epochs.evidence || ledger !== snapshot.epochs.ledger) return { kind: 'blocked', reason: 'epoch-drift' };
                const current = await base(tx, snapshot.bankLineId);
                if (validateSnapshot(current, current.bankLineId, targets(), claimInstant).length || current.sourceRevision !== snapshot.sourceRevision
                    || computeOnDemandDigest(current, claimInstant) !== digest || deadline()) return { kind: 'blocked', reason: 'source-drift' };
                const card = toOwnerCard(current, claimInstant);
                const prior = await priorAttempt(tx, current.bankLineId);
                if (prior && (prior.status !== 'POSTED' || prior.pacificDate !== card.date)) return { kind: 'blocked', reason: 'prior-request-unverified' };
                const existing = await tx.receiptRequestCard.findUnique({ where: { owner_pacificDate: { owner: card.owner, pacificDate: card.date } } });
                if (existing) {
                    const issue = await tx.reviewIssue.findUnique({ where: { id: current.item.issueId }, select: { displayDetails: true } });
                    const history = cardRecordsOf(parseMissingReceiptDetails(issue?.displayDetails ?? null));
                    if (existing.status === 'POSTED' && existing.postedAt && existing.itemsJson === JSON.stringify(card.items)
                        && deliveryInConfiguredSpace(existing.threadName, existing.messageName)
                        && history.some(h => h.threadName === existing.threadName && h.messageName === existing.messageName && h.n === 1 && h.requestId === card.requestId))
                        return { kind: 'already-posted', threadName: existing.threadName!, messageName: existing.messageName! };
                    return { kind: 'blocked', reason: 'existing-day-card' };
                }
                if (await tx.receiptRequestCardDelivery.findUnique({ where: { owner_deliveryDay: { owner: card.owner, deliveryDay: card.date } }, select: { id: true } }))
                    return { kind: 'blocked', reason: 'day-reserved' };
                const token = randomUUID();
                const row = await tx.receiptRequestCard.create({ data: { owner: card.owner, pacificDate: card.date, itemsJson: JSON.stringify(card.items),
                    overflow: 0, overflowExact: true, status: 'POSTING', claimedAt: now(), claimToken: token, deliveredOn: card.date }, select: { id: true } });
                await tx.receiptRequestCardDelivery.create({ data: { owner: card.owner, deliveryDay: card.date, cardId: row.id } });
                return { kind: 'claimed', claimId: row.id, claimToken: token };
            }, { timeout: 8_000, maxWait: 1_000 });
        } catch { return { kind: 'blocked', reason: 'claim-not-committed' }; }
    }

    async function finish(claimed: Extract<ClaimResult, { kind: 'claimed' }>, result: FinishResult): Promise<{ kind: 'recorded' } | { kind: 'failed'; reason: string }> {
        try {
            return await db.$transaction(async tx => {
                if (result.kind === 'delivered' && !deliveryInConfiguredSpace(result.threadName, result.messageName)) throw Error('invalid-delivery');
                const written = await tx.receiptRequestCard.updateMany({ where: { id: claimed.claimId, claimToken: claimed.claimToken, status: 'POSTING' },
                    data: result.kind === 'delivered' ? { status: 'POSTED', postedAt: now(), threadName: result.threadName, messageName: result.messageName,
                        attempts: { increment: 1 }, lastError: null } : { status: 'UNCERTAIN', attempts: { increment: 1 }, lastError: 'on-demand-delivery-uncertain' } });
                if (written.count !== 1) throw Error('lost-cas');
                if (result.kind === 'delivered') {
                    const row = await tx.receiptRequestCard.findUnique({ where: { id: claimed.claimId } });
                    if (!row) throw Error('missing-card');
                    const items = JSON.parse(row.itemsJson) as CardItem[];
                    if (!Array.isArray(items) || items.length !== 1 || items[0].n !== 1 || !items[0].issueId) throw Error('invalid-items');
                    const recorded = await recordCardOnIssues(buildCardFromItems(row.owner, row.pacificDate, items, 0, true), result.threadName, result.messageName, now(), tx, 'throw');
                    if (recorded.recorded !== 1 || recorded.skipped !== 0) throw Error('history-missing');
                }
                return { kind: 'recorded' };
            }, { timeout: 5_000, maxWait: 1_000 });
        } catch { return { kind: 'failed', reason: 'delivery-not-recorded' }; }
    }
    return { readSnapshot, lookupPosted, claim, finish, webhookUrl: webhook, now,
        async post(card, _url, timeoutMs) {
            const result = await postOwnerCard(webhook, card, { timeoutMs });
            return result.kind === 'delivered' && deliveryInConfiguredSpace(result.threadName, result.messageName) ? result : { kind: 'uncertain', reason: 'provider-not-confirmed' };
        },
    };
}
