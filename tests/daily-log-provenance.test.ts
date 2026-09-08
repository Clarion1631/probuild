import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDailyLogCore, assertDailyLogChatProject } from '../src/lib/daily-log-core';

const base = { projectId: 'job', actorUserId: 'crew', date: '2026-09-08', workPerformed: 'Framing' };
test('Chat sources must match the linked project space', () => {
    assertDailyLogChatProject('spaces/job-space/messages/log-1', 'spaces/job-space');
    assertDailyLogChatProject('spaces/job-space/messages/log-1', 'job-space');
    assertDailyLogChatProject(null, null);
    assert.throws(() => assertDailyLogChatProject('spaces/job-space/messages/log-1', 'spaces/other'), /linked/);
    assert.throws(() => assertDailyLogChatProject('spaces/job-space/messages/log-1', null), /linked/);
});
test('Chat source identity is persisted with the log and never shared by default', async () => {
    let written: any;
    await createDailyLogCore({ ...base, chatMessageName: 'spaces/job-space/messages/log-1' } as any,
        { dailyLog: { create: async (args: any) => { written = args.data; return args.data; } } } as any);
    assert.equal(written.chatMessageName, 'spaces/job-space/messages/log-1');
    assert.equal(written.source, 'google_chat');
    assert.equal(written.sharedToPortal, undefined);
});
test('manual logs retain manual provenance', async () => {
    let written: any;
    await createDailyLogCore(base, { dailyLog: { create: async (args: any) => { written = args.data; return args.data; } } } as any);
    assert.equal(written.source, 'manual');
    assert.equal(written.chatMessageName, null);
});
test('invalid Chat resource names are refused before writing', async () => {
    for (const chatMessageName of ['message', 'spaces/a/messages/b/extra', 'https://chat.google.com/message']) {
        await assert.rejects(createDailyLogCore({ ...base, chatMessageName } as any,
            { dailyLog: { create: async () => { throw new Error('unexpected write'); } } } as any), /Chat message/);
    }
});
