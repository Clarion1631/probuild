import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { ComponentTooLargeError } from '../src/lib/receipt-requests';

process.env.DATABASE_URL = 'postgresql://fiction:fiction@127.0.0.1:9/test?pgbouncer=true';
process.env.NEXTAUTH_SECRET = 'fictional-test-only';
process.env.CRON_SECRET = 'fictional-cron';
process.env.RECEIPT_REQUEST_CARDS_ENABLED = 'true';
process.env.RECEIPTS_CHAT_WEBHOOK = 'https://example.invalid/webhook';
delete process.env.RECEIPT_SOURCE_RECOGNITION_ENABLED;
delete process.env.RECEIPT_REVIEWED_SOURCE_FACTS_JSON;
delete process.env.RECEIPT_REVIEWED_SOURCE_FACTS_SHA256;
globalThis.fetch = async () => { throw Error('NETWORK DENIED'); };

test('scheduled retry defers only incomplete card, releases its claim, preserves queued snapshot, and allows complete owner', async () => {
  mock.timers.enable({ apis: ['Date'], now: new Date('2026-01-14T16:30:00Z') });
  const items = (owner: string) => [{ n: 1, fingerprint: `pb-${owner}`, date: '2026-01-10', vendor: 'FICTIONAL STORE', cents: 12345, amount: '123.45', cardTail: owner === 'CJ' ? '8516' : '6098', issueId: `issue-${owner}`, targetKey: owner }];
  const rows = ['CJ', 'Richard'].map(owner => ({ id: `card-${owner}`, owner, pacificDate: '2026-01-13', itemsJson: JSON.stringify(items(owner)), overflow: 0, overflowExact: true, resendQueuedAt: new Date('2026-01-13T18:00:00Z') }));
  const originalSnapshots = rows.map(row => ({ itemsJson: row.itemsJson, resendQueuedAt: row.resendQueuedAt }));
  const writes: Array<{ where: any; data: any }> = [];
  const notifications: string[] = [];
  const reservations: string[] = [];
  let queryCount = 0;
  const fake: any = {
    automationSetting: { findUnique: async ({ where }: any) => where.key === 'receiptRequestsCycle' ? { value: JSON.stringify({ id: 'fixture-cycle', epoch: '1', evidenceEpoch: '1' }) } : null },
    $queryRaw: async () => ++queryCount === 1 ? [{ locked: true }] : rows,
    receiptRequestCardDelivery: { findMany: async () => [], create: async ({ data }: any) => { reservations.push(data.owner); }, deleteMany: async () => ({ count: 1 }) },
    receiptRequestCard: {
      updateMany: async (arg: any) => { writes.push(arg); return { count: 1 }; },
      findMany: async () => [],
      deleteMany: async () => { throw Error('Must not delete snapshot'); },
      findUnique: async () => null,
    },
    reviewIssue: { findMany: async ({ where }: any) => rows.filter(r => where.id.in.includes(`issue-${r.owner}`)).map(r => ({ id: `issue-${r.owner}`, targetKey: r.owner, clearedAt: null, reasonCodes: '["MISSING_RECEIPT"]', acknowledgedCodes: '[]', displayDetails: JSON.stringify({ owner: r.owner, cardTail: r.owner === 'CJ' ? '8516' : '6098' }) })) },
    receiptMemoArtifact: { findMany: async () => [] },
  };
  fake.$transaction = async (fn: any) => fn(fake);
  const originalRequire = Module.prototype.require;
  const strictArgs: boolean[] = [];
  let unexpectedFailure = false;
  Module.prototype.require = function(this: NodeModule, id: string) {
    if (id === '@/lib/prisma') return { prisma: fake };
    if (id === '@/app/api/cron/receipt-requests/route') return { recomputeCodesFor: async (target: string, _cache: unknown, _deadline: unknown, strict: boolean) => {
      strictArgs.push(strict);
      if (unexpectedFailure) throw Error('fictional unexpected query failure');
      if (target === 'CJ') throw new ComponentTooLargeError(201, 200);
      return ['MISSING_RECEIPT'];
    } };
    if (id === '@/lib/receipt-request-cards') {
      const actual = originalRequire.apply(this, arguments as unknown as [string]);
      return { ...actual, postOwnerCard: async (_url: string, card: any) => { notifications.push(card.owner); return { kind: 'rejected', reason: 'fictional-rejection' }; } };
    }
    return originalRequire.apply(this, arguments as unknown as [string]);
  };
  try {
    const { GET } = await import('../src/app/api/cron/receipt-request-cards/route');
    Module.prototype.require = originalRequire;
    const response = await GET(new Request('https://example.invalid/api/cron/receipt-request-cards?retry=1', { headers: { authorization: 'Bearer fictional-cron' } }));
    const body = await response.json();
    assert.equal(body.skipped, undefined, JSON.stringify(body));
    assert.deepEqual(body.incompleteDeferredOwners, ['CJ']);
    assert.equal(body.budgetDeferredOwners, undefined);
    assert.deepEqual(notifications, ['Richard']);
    assert.deepEqual(reservations, ['Richard']);
    assert.deepEqual(strictArgs, [true, true]);
    const cjWrites = writes.filter(w => w.where.id === 'card-CJ');
    assert.equal(cjWrites.length, 2, 'claim and release only');
    assert.deepEqual(cjWrites[1].data, { claimedAt: null, claimToken: null });
    assert.equal(typeof cjWrites[1].where.claimToken, 'string');
    assert.equal(cjWrites[1].where.postedAt, null);
    assert.deepEqual(rows.map(row => ({ itemsJson: row.itemsJson, resendQueuedAt: row.resendQueuedAt })), originalSnapshots);
    unexpectedFailure = true;
    queryCount = 0;
    notifications.length = 0;
    reservations.length = 0;
    await assert.rejects(GET(new Request('https://example.invalid/api/cron/receipt-request-cards?retry=1', { headers: { authorization: 'Bearer fictional-cron' } })), /fictional unexpected query failure/);
    assert.deepEqual(notifications, [], 'unexpected failures are not converted into missing-receipt verdicts');
    assert.deepEqual(reservations, []);

  } finally {
    Module.prototype.require = originalRequire;
    mock.timers.reset();
  }
});
