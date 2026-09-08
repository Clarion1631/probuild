import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { createDailyLogCore } from '../src/lib/daily-log-core';

const testUrl = process.env.CREW_PROVENANCE_TEST_URL;
test('Chat source uniqueness rejects concurrent replay and cross-project reuse without extra logs', { skip: !testUrl && 'Requires explicit disposable database' }, async () => {
    const url = new URL(testUrl!);
    assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname) && url.pathname === '/crew_readiness_20260907', 'Requires isolated crew_readiness_20260907 database');
    const db = new PrismaClient({ datasources: { db: { url: testUrl } } });
    const tag = randomUUID();
    const actor = await db.user.create({ data: { name: 'Synthetic crew', email: `${tag}@example.invalid`, role: 'FIELD_CREW', status: 'ACTIVATED' } });
    const client = await db.client.create({ data: { name: `Synthetic ${tag}`, initials: 'SC' } });
    const first = await db.project.create({ data: { name: `Synthetic first ${tag}`, clientId: client.id } });
    const second = await db.project.create({ data: { name: `Synthetic second ${tag}`, clientId: client.id } });
    let confirmationToken: string | undefined;
    try {
        const input = { projectId: first.id, actorUserId: actor.id, date: '2042-01-05', workPerformed: 'Synthetic framing', chatMessageName: `spaces/synthetic/messages/${tag}` };
        const results = await Promise.allSettled([createDailyLogCore(input, db), createDailyLogCore(input, db)]);
        assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
        assert.equal(results.filter(result => result.status === 'rejected').length, 1);
        const saved = await db.dailyLog.findUniqueOrThrow({ where: { chatMessageName: input.chatMessageName } });
        assert.equal(saved.source, 'google_chat');
        assert.equal(saved.sharedToPortal, false);
        await assert.rejects(createDailyLogCore({ ...input, projectId: second.id }, db), { code: 'P2002' });
        assert.equal(await db.dailyLog.count({ where: { projectId: { in: [first.id, second.id] } } }), 1);

        // Exercise the actual MCP confirmation boundary without executing its
        // post-commit AI/webhook callbacks: both writes must fail before commit.
        const { createDailyLogWithConfirmation } = await import('../src/lib/mcp-pm-tools');
        const space = `spaces/synthetic-${tag}`;
        await db.project.update({ where: { id: first.id }, data: { googleChatSpaceId: space } });
        const request = { projectId: first.id, date: '2042-01-05', workPerformed: 'Synthetic tomorrow plan', chatMessageName: `${space}/messages/original` };
        const context = { actorLabel: 'justin-ai' as const, actorUserId: actor.id };
        const preview = await createDailyLogWithConfirmation(request, context) as any;
        assert.ok(preview.preview.includes(request.chatMessageName), 'reviewer sees the exact asserted source');
        confirmationToken = preview.confirmToken;
        assert.ok(confirmationToken);
        await assert.rejects(createDailyLogWithConfirmation({ ...request, chatMessageName: `${space}/messages/changed`, confirmToken: confirmationToken }, context), /does not match/);
        await db.project.update({ where: { id: first.id }, data: { googleChatSpaceId: `${space}-reassigned` } });
        await assert.rejects(createDailyLogWithConfirmation({ ...request, confirmToken: confirmationToken }, context), /linked Google Chat space/);
        const token = await db.mcpConfirmation.findUniqueOrThrow({ where: { token: confirmationToken } });
        assert.equal(token.consumedAt, null, 'failed project validation rolls back token consumption');
        assert.equal(await db.dailyLog.count({ where: { projectId: first.id } }), 1);
    } finally {
        if (confirmationToken) await db.mcpConfirmation.delete({ where: { token: confirmationToken } });
        await db.dailyLog.deleteMany({ where: { projectId: { in: [first.id, second.id] } } });
        await db.project.deleteMany({ where: { id: { in: [first.id, second.id] } } });
        await db.client.delete({ where: { id: client.id } });
        await db.user.delete({ where: { id: actor.id } });
        await db.$disconnect();
        const { prisma } = await import('../src/lib/prisma');
        await prisma.$disconnect();
    }
});
