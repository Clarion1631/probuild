import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

const testUrl = process.env.CREW_PROVENANCE_TEST_URL;
test('explicit dispatch worker fences concurrent claims, retries same message and refuses remapping/backlog', { skip: !testUrl && 'Requires explicit disposable database' }, async () => {
    const url = new URL(testUrl!);
    assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname) && url.pathname === '/crew_readiness_20260907');
    const { deliverDispatchById } = await import('../src/lib/dispatch-delivery-worker');
    const db = new PrismaClient({ datasources: { db: { url: testUrl } } });
    const tag = randomUUID();
    const user = await db.user.create({ data: { name: 'Synthetic dispatch crew', email: `${tag}@example.invalid`, status: 'ACTIVATED' } });
    const publication = await db.dispatchPublication.create({ data: { clientRequestId: tag, requestHash: tag, publishedByName: 'Synthetic manager' } });
    const row = await db.chatDelivery.create({ data: { publicationId: publication.id, destination: `user:${user.id}`, payload: { recipient: { userId: user.id }, tasks: [{ id: 'synthetic', projectName: 'Synthetic kitchen', name: 'Framing', startDate: '2042-01-05', endDate: '2042-01-06', doneWhen: 'Photo anchors', assignments: [{ userId: user.id, role: 'lead' }] }] } } });
    const config = { enabled: true, approvedDeliveryIds: [row.id], recipients: [{ userId: user.id, spaceName: 'spaces/synthetic-dm', spaceType: 'DIRECT_MESSAGE' as const, verifiedAt: '2026-09-07T20:00:00Z', principalId: 'synthetic-principal' }] };
    let calls = 0;
    const sent: string[] = [];
    let releaseFirst!: () => void;
    let signalStarted!: () => void;
    const firstStarted = new Promise<void>(resolve => { signalStarted = resolve; });
    const firstRelease = new Promise<void>(resolve => { releaseFirst = resolve; });
    const sender = async (message: any) => { calls++; sent.push(JSON.stringify(message)); if (calls === 1) { signalStarted(); await firstRelease; throw new Error('ambiguous transport failure'); } return `${message.spaceName}/messages/confirmed`; };
    try {
        assert.equal(await deliverDispatchById(db, row.id, { ...config, enabled: false }, sender), 'disabled');
        assert.equal(await deliverDispatchById(db, row.id, { ...config, approvedDeliveryIds: [] }, sender), 'not_approved');
        assert.equal(await deliverDispatchById(db, row.id, { ...config, recipients: [] }, sender), 'unverified_mapping');
        const first = deliverDispatchById(db, row.id, config, sender);
        await firstStarted;
        assert.equal(await deliverDispatchById(db, row.id, config, sender), 'busy');
        assert.equal(calls, 1);
        releaseFirst();
        assert.equal(await first, 'failed');
        // Simulate a process lost after claiming a retry. Reclaiming a stale
        // lease must preserve the durable destination and message identity.
        await db.chatDelivery.update({ where: { id: row.id }, data: { status: 'PROCESSING', claimToken: 'stale-owner', processingStartedAt: new Date(Date.now() - 120_000) } });
        assert.equal(await deliverDispatchById(db, row.id, { ...config, recipients: [{ ...config.recipients[0], spaceName: 'spaces/wrong-dm' }] }, sender), 'mapping_changed');
        assert.equal(await deliverDispatchById(db, row.id, { ...config, recipients: [{ ...config.recipients[0], principalId: 'wrong-principal' }] }, sender), 'mapping_changed');
        assert.equal(await deliverDispatchById(db, row.id, config, sender), 'processed');
        assert.equal(calls, 2);
        assert.equal(sent[0], sent[1]);
        assert.ok(JSON.parse(sent[0]).text.includes('Synthetic kitchen'), 'crew receives the job name alongside the task');
        assert.ok(JSON.parse(sent[0]).text.includes('2042-01-05 to 2042-01-05'), 'exclusive storage date is displayed as the actual final work date');
        assert.equal(await deliverDispatchById(db, row.id, config, sender), 'already_processed');
        const saved = await db.chatDelivery.findUniqueOrThrow({ where: { id: row.id } });
        assert.equal(saved.providerMessageId, 'spaces/synthetic-dm/messages/confirmed');
        assert.equal(saved.attempts, 2);

        // A slow original sender must not overwrite a newer lease's result.
        await db.chatDelivery.update({ where: { id: row.id }, data: { status: 'FAILED', attempts: 0, providerMessageId: null, processedAt: null } });
        let releaseSlow!: () => void;
        let markSlowStarted!: () => void;
        const slowStarted = new Promise<void>(resolve => { markSlowStarted = resolve; });
        const slowRelease = new Promise<void>(resolve => { releaseSlow = resolve; });
        const original = deliverDispatchById(db, row.id, config, async message => {
            markSlowStarted(); await slowRelease;
            return `${message.spaceName}/messages/old-owner`;
        });
        await slowStarted;
        await db.chatDelivery.update({ where: { id: row.id }, data: { processingStartedAt: new Date(Date.now() - 120_000) } });
        assert.equal(await deliverDispatchById(db, row.id, config, async message => `${message.spaceName}/messages/new-owner`), 'processed');
        releaseSlow();
        assert.equal(await original, 'lost_claim');
        assert.equal((await db.chatDelivery.findUniqueOrThrow({ where: { id: row.id } })).providerMessageId, 'spaces/synthetic-dm/messages/new-owner');
    } finally {
        await db.dispatchPublication.delete({ where: { id: publication.id } });
        await db.user.delete({ where: { id: user.id } });
        await db.$disconnect();
    }
});
